// Waybill local server: lets the Waybill extension in every browser profile on
// this machine see the Amazon accounts signed in on the others, and load an
// account's orders on demand from whichever profile is signed into it.
//
// - Each profile connects over a WebSocket (/connect) and registers only
//   account summaries: marketplace, customer ID, name, email, status.
// - Open Activity pages subscribe over a WebSocket (/watch) and receive the
//   full account list again whenever any profile's accounts or connection
//   change.
// - Orders are lazy: POST /accounts/<key>/orders forwards a read request to a
//   connected profile that holds the account, and returns its answer. Orders
//   are passed through and never stored.
// - State is in memory; profiles re-register when they reconnect.
// - Listens on 127.0.0.1 only and accepts only Waybill's extension origin(s).
//
// Run: node server/server.mjs   (WAYBILL_PORT, WAYBILL_EXTENSION_IDS to override)
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { acceptWebSocket } from './websocket.mjs';

export const DEFAULT_PORT = 4417;
const DEFAULT_EXTENSION_IDS = ['iibmbonngmdgckjdjpilmapdgldhkeog'];
const ORDER_REQUEST_TIMEOUT_MS = 120_000;
const MAX_BODY_BYTES = 100_000;
const INSTANCE_ID = /^[0-9a-f-]{36}$/;
const STATUSES = new Set(['active', 'needs-sign-in']);
const STATUS_RANK = { active: 2, 'needs-sign-in': 1 };

export const accountKey = ({ marketplace, domain, customerId, email }) =>
  `${marketplace}${domain}:${customerId ?? `email:${email}`}`;

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
  };
  const valid = account.marketplace === 'amazon' && /^\.[a-z.]+$/.test(account.domain ?? '')
    && account.status && (account.customerId || account.email);
  return valid ? account : null;
}

export function createWaybillServer({ extensionIds = DEFAULT_EXTENSION_IDS } = {}) {
  const allowedOrigins = new Set(extensionIds.map((id) => `chrome-extension://${id}`));
  // instanceId -> { accounts: Map<key, summary>, connection | null }
  const instances = new Map();
  // requestId -> { instanceId, resolve, timer }
  const pendingOrders = new Map();
  // Activity pages watching the account list.
  const watchers = new Set();
  let allowedHosts = new Set();

  function instance(id) {
    if (!instances.has(id)) instances.set(id, { accounts: new Map(), connection: null });
    return instances.get(id);
  }

  function aggregatedAccounts() {
    const byKey = new Map();
    for (const [instanceId, { accounts, connection }] of instances) {
      for (const [key, account] of accounts) {
        const entry = byKey.get(key) ?? { key, ...account, profiles: [] };
        if (STATUS_RANK[account.status] > STATUS_RANK[entry.status]) Object.assign(entry, account);
        entry.profiles.push({ instanceId, online: connection !== null, status: account.status });
        byKey.set(key, entry);
      }
    }
    return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  function broadcastAccounts() {
    const message = { type: 'accounts', accounts: aggregatedAccounts() };
    for (const watcher of watchers) watcher.send(message);
  }

  function requestOrders(key, filter) {
    const candidates = [...instances].filter(([, { accounts, connection }]) => connection && accounts.has(key))
      .sort(([, a], [, b]) => STATUS_RANK[b.accounts.get(key).status] - STATUS_RANK[a.accounts.get(key).status]);
    if (!candidates.length) return Promise.resolve({ status: 409, body: { error: 'No connected browser profile has this account signed in.' } });
    const [instanceId, { accounts, connection }] = candidates[0];
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingOrders.delete(requestId);
        resolve({ status: 504, body: { error: 'The browser profile did not answer in time.' } });
      }, ORDER_REQUEST_TIMEOUT_MS);
      pendingOrders.set(requestId, { instanceId, resolve, timer });
      connection.send({ type: 'read-orders', requestId, domain: accounts.get(key).domain, filter: filter ?? null });
    });
  }

  function settleOrders(instanceId, { requestId, result, error }) {
    const pending = pendingOrders.get(requestId);
    if (!pending || pending.instanceId !== instanceId) return;
    clearTimeout(pending.timer);
    pendingOrders.delete(requestId);
    pending.resolve(error ? { status: 502, body: { error: String(error).slice(0, 300) } } : { status: 200, body: { instanceId, result } });
  }

  function handleConnection(instanceId, connection) {
    const entry = instance(instanceId);
    entry.connection?.close();
    entry.connection = connection;
    broadcastAccounts();
    return {
      onMessage(message) {
        if (message?.type === 'accounts' && Array.isArray(message.accounts)) {
          entry.accounts = new Map(message.accounts.map(accountSummary).filter(Boolean).map((account) => [accountKey(account), account]));
          broadcastAccounts();
        } else if (message?.type === 'orders-result') {
          settleOrders(instanceId, message);
        }
      },
      onClose() {
        if (entry.connection !== connection) return;
        entry.connection = null;
        broadcastAccounts();
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

  const server = createServer(async (request, response) => {
    if (!isAllowed(request)) return respond(response, 403, { error: 'Forbidden' });
    const { origin } = request.headers;
    const { pathname } = new URL(request.url, 'http://localhost');

    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-private-network': 'true',
        vary: 'Origin',
      });
      return response.end();
    }
    if (request.method === 'GET' && pathname === '/health') return respond(response, 204, undefined, origin);
    if (request.method === 'GET' && pathname === '/accounts') {
      return respond(response, 200, { accounts: aggregatedAccounts() }, origin);
    }
    const ordersMatch = pathname.match(/^\/accounts\/([^/]+)\/orders$/);
    if (request.method === 'POST' && ordersMatch) {
      let body;
      try { body = await readJson(request); } catch { return respond(response, 400, { error: 'Invalid JSON' }, origin); }
      const filter = typeof body.filter === 'string' && /^[a-z0-9-]{1,20}$/.test(body.filter) ? body.filter : null;
      const { status, body: answer } = await requestOrders(decodeURIComponent(ordersMatch[1]), filter);
      return respond(response, status, answer, origin);
    }
    return respond(response, 404, { error: 'Not found' }, origin);
  });

  function handleWatcher(connection) {
    watchers.add(connection);
    connection.send({ type: 'accounts', accounts: aggregatedAccounts() });
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
    listen(port = DEFAULT_PORT) {
      return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
        const { port: actual } = server.address();
        allowedHosts = new Set([`127.0.0.1:${actual}`, `localhost:${actual}`]);
        resolve(actual);
      }));
    },
    close() {
      for (const { connection } of instances.values()) connection?.close();
      for (const watcher of watchers) watcher.close();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const extensionIds = process.env.WAYBILL_EXTENSION_IDS?.split(',').map((id) => id.trim()).filter(Boolean);
  const port = await createWaybillServer({ extensionIds }).listen(Number(process.env.WAYBILL_PORT) || DEFAULT_PORT);
  console.log(`Waybill local server listening on 127.0.0.1:${port}`);
}
