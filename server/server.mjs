// Waybill local server: lets the Waybill extension in every browser profile on
// this machine see the Amazon accounts signed in on the others, and load an
// account's orders on demand from whichever profile is signed into it.
//
// - Each profile connects over a WebSocket (/connect) and registers only
//   account summaries: marketplace, customer ID, name, email, status.
// - Open Activity pages subscribe over a WebSocket (/watch) and receive the
//   full account list again whenever any profile's accounts or connection
//   change.
// - DELETE /accounts/<id> removes an account (soft delete); it returns only
//   when a profile reports a sign-in to it made after the removal.
// - Orders are lazy: POST /accounts/<id>/orders forwards a read request to a
//   connected profile that holds the account, and returns its answer. Orders
//   are passed through and never stored.
// - Profiles and accounts are kept in a store: Postgres when DATABASE_URL is
//   set (compose.yaml), otherwise in memory. Each account gets a lasting
//   numeric ID. Which profiles are connected is known only while they are.
// - Listens on 127.0.0.1 only and accepts only Waybill's extension origin(s).
//
// Run: docker compose up, or node server/server.mjs (in-memory store)
// (WAYBILL_PORT, WAYBILL_HOST, WAYBILL_EXTENSION_IDS, DATABASE_URL)
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { acceptWebSocket } from './websocket.mjs';
import { createMemoryStore } from './store/memory.mjs';

export const DEFAULT_PORT = 4417;
const DEFAULT_EXTENSION_IDS = ['iibmbonngmdgckjdjpilmapdgldhkeog'];
const ORDER_REQUEST_TIMEOUT_MS = 120_000;
const MAX_BODY_BYTES = 100_000;
const INSTANCE_ID = /^[0-9a-f-]{36}$/;
const STATUSES = new Set(['active', 'needs-sign-in']);
const STATUS_RANK = { active: 2, 'needs-sign-in': 1 };

const text = (value, max = 200) => (typeof value === 'string' && value.length <= max ? value : null);

// Keeps only the fields Waybill shares; rejects anything malformed.
function accountSummary(raw) {
  const account = {
    marketplace: text(raw?.marketplace, 20),
    domain: text(raw?.domain, 20),
    customerId: text(raw?.customerId, 40),
    name: text(raw?.name),
    email: text(raw?.email),
    status: STATUSES.has(raw?.status) ? raw.status : null,
    // When this profile last saw the user sign in to the account (ms).
    signedInAt: Number.isFinite(raw?.signedInAt) && raw.signedInAt <= Date.now() + 60_000 ? raw.signedInAt : null,
  };
  const valid = account.marketplace === 'amazon' && /^\.[a-z.]+$/.test(account.domain ?? '')
    && account.status && (account.customerId || account.email);
  return valid ? account : null;
}

export function createWaybillServer({ extensionIds = DEFAULT_EXTENSION_IDS, store = createMemoryStore() } = {}) {
  const allowedOrigins = new Set(extensionIds.map((id) => `chrome-extension://${id}`));
  // instanceId -> the profile's open connection
  const connections = new Map();
  // requestId -> { instanceId, resolve, timer }
  const pendingOrders = new Map();
  // Activity pages watching the account list.
  const watchers = new Set();
  let allowedHosts = new Set();

  // Stored accounts plus who holds them right now. The account's status is
  // the best status among the profiles holding it.
  const withConnections = (account) => {
    const profiles = account.holders.map(({ profileId, status }) => ({ instanceId: profileId, online: connections.has(profileId), status }));
    const best = profiles.reduce((top, profile) => (STATUS_RANK[profile.status] > STATUS_RANK[top] ? profile.status : top), 'needs-sign-in');
    const { holders, ...fields } = account;
    return { ...fields, status: best, profiles };
  };

  async function aggregatedAccounts() {
    return (await store.listAccounts()).map(withConnections);
  }

  async function broadcastAccounts() {
    if (!watchers.size) return;
    const message = { type: 'accounts', accounts: await aggregatedAccounts() };
    for (const watcher of watchers) watcher.send(message);
  }

  async function requestOrders(accountId, filter) {
    const account = await store.getAccount(accountId);
    if (!account) return { status: 404, body: { error: 'No such account.' } };
    const holder = withConnections(account).profiles.filter((profile) => profile.online)
      .sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status])[0];
    if (!holder) return { status: 409, body: { error: 'No connected browser profile has this account signed in.' } };
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingOrders.delete(requestId);
        resolve({ status: 504, body: { error: 'The browser profile did not answer in time.' } });
      }, ORDER_REQUEST_TIMEOUT_MS);
      pendingOrders.set(requestId, { instanceId: holder.instanceId, resolve, timer });
      connections.get(holder.instanceId).send({ type: 'read-orders', requestId, domain: account.domain, filter: filter ?? null });
    });
  }

  function settleOrders(instanceId, { requestId, result, error }) {
    const pending = pendingOrders.get(requestId);
    if (!pending || pending.instanceId !== instanceId) return;
    clearTimeout(pending.timer);
    pendingOrders.delete(requestId);
    pending.resolve(error ? { status: 502, body: { error: String(error).slice(0, 300) } } : { status: 200, body: { instanceId, result } });
  }

  const logStoreError = (error) => console.error(`Waybill store: ${error.message}`);

  function handleConnection(instanceId, connection) {
    connections.get(instanceId)?.close();
    connections.set(instanceId, connection);
    // Store writes for one profile run in the order its messages arrived.
    let writes = store.touchProfile(instanceId).then(broadcastAccounts).catch(logStoreError);
    return {
      onMessage(message) {
        if (message?.type === 'accounts' && Array.isArray(message.accounts)) {
          const accounts = message.accounts.map(accountSummary).filter(Boolean);
          writes = writes.then(() => store.replaceProfileAccounts(instanceId, accounts)).then(broadcastAccounts).catch(logStoreError);
        } else if (message?.type === 'orders-result') {
          settleOrders(instanceId, message);
        }
      },
      onClose() {
        if (connections.get(instanceId) !== connection) return;
        connections.delete(instanceId);
        broadcastAccounts().catch(logStoreError);
        for (const [requestId, pending] of pendingOrders) {
          if (pending.instanceId === instanceId) settleOrders(instanceId, { requestId, error: 'The browser profile disconnected.' });
        }
      },
    };
  }

  const isAllowed = (request) => allowedHosts.has(request.headers.host) && allowedOrigins.has(request.headers.origin);

  function respond(response, status, body, origin) {
    response.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...(origin && { 'access-control-allow-origin': origin, vary: 'Origin' }),
    });
    response.end(body === undefined ? '' : JSON.stringify(body));
  }

  function readJson(request) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      request.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { reject(new Error('too large')); request.destroy(); } else chunks.push(chunk);
      });
      request.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch (error) { reject(error); } });
    });
  }

  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      logStoreError(error);
      if (!response.headersSent) respond(response, 503, { error: 'The Waybill server could not reach its database.' }, request.headers.origin);
    });
  });

  async function handleRequest(request, response) {
    if (!isAllowed(request)) return respond(response, 403, { error: 'Forbidden' });
    const { origin } = request.headers;
    const { pathname } = new URL(request.url, 'http://localhost');

    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST, DELETE',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-private-network': 'true',
        vary: 'Origin',
      });
      return response.end();
    }
    if (request.method === 'GET' && pathname === '/health') return respond(response, 204, undefined, origin);
    if (request.method === 'GET' && pathname === '/accounts') {
      return respond(response, 200, { accounts: await aggregatedAccounts() }, origin);
    }
    const accountMatch = pathname.match(/^\/accounts\/(\d{1,15})$/);
    if (request.method === 'DELETE' && accountMatch) {
      if (!(await store.deleteAccount(Number(accountMatch[1])))) return respond(response, 404, { error: 'No such account.' }, origin);
      await broadcastAccounts();
      return respond(response, 204, undefined, origin);
    }
    const ordersMatch = pathname.match(/^\/accounts\/(\d{1,15})\/orders$/);
    if (request.method === 'POST' && ordersMatch) {
      let body;
      try { body = await readJson(request); } catch { return respond(response, 400, { error: 'Invalid JSON' }, origin); }
      const filter = typeof body.filter === 'string' && /^[a-z0-9-]{1,20}$/.test(body.filter) ? body.filter : null;
      const { status, body: answer } = await requestOrders(Number(ordersMatch[1]), filter);
      return respond(response, status, answer, origin);
    }
    return respond(response, 404, { error: 'Not found' }, origin);
  }

  function handleWatcher(connection) {
    watchers.add(connection);
    aggregatedAccounts().then((accounts) => connection.send({ type: 'accounts', accounts })).catch(logStoreError);
    return { onMessage() {}, onClose: () => watchers.delete(connection) };
  }

  server.on('upgrade', (request, socket) => {
    const { pathname, searchParams } = new URL(request.url, 'http://localhost');
    const instanceId = searchParams.get('instance') ?? '';
    const route = pathname === '/watch' ? 'watch' : pathname === '/connect' && INSTANCE_ID.test(instanceId) ? 'connect' : null;
    if (!isAllowed(request) || !route
      || request.headers.upgrade?.toLowerCase() !== 'websocket' || !request.headers['sec-websocket-key']) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    let handlers;
    const connection = acceptWebSocket(request, socket, {
      onMessage: (message) => handlers.onMessage(message),
      onClose: () => handlers.onClose(),
    });
    handlers = route === 'watch' ? handleWatcher(connection) : handleConnection(instanceId, connection);
  });

  return {
    // `host` is 127.0.0.1 except inside a container, where Docker publishes
    // the port on the machine's loopback interface only (compose.yaml).
    listen(port = DEFAULT_PORT, host = '127.0.0.1') {
      return new Promise((resolve) => server.listen(port, host, () => {
        const { port: actual } = server.address();
        allowedHosts = new Set([`127.0.0.1:${actual}`, `localhost:${actual}`]);
        resolve(actual);
      }));
    },
    async close() {
      for (const connection of connections.values()) connection.close();
      for (const watcher of watchers) watcher.close();
      await new Promise((resolve) => server.close(resolve));
      await store.close();
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const extensionIds = process.env.WAYBILL_EXTENSION_IDS?.split(',').map((id) => id.trim()).filter(Boolean);
  const host = process.env.WAYBILL_HOST || '127.0.0.1';
  const store = process.env.DATABASE_URL
    ? await (await import('./store/postgres.mjs')).createPostgresStore(process.env.DATABASE_URL)
    : createMemoryStore();
  console.log(process.env.DATABASE_URL ? 'Store: Postgres' : 'Store: in memory (set DATABASE_URL for Postgres)');
  const waybill = createWaybillServer({ extensionIds, store });
  const port = await waybill.listen(Number(process.env.WAYBILL_PORT) || DEFAULT_PORT, host);
  console.log(`Waybill local server listening on ${host}:${port}`);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      await waybill.close();
      process.exit(0);
    });
  }
}
