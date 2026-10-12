// Waybill local server: lets the Waybill extension in every browser profile on
// this machine see the accounts signed in on the others, and read an
// account's orders on demand in whichever profile is signed in to it.
//
// It runs the server: and db: events of core/events.js with the same chain
// runner as the extension (core/chain.js); the work is in handlers.mjs.
// Each profile's background connects over one WebSocket (/connect) that
// carries events both ways:
//   { kind: 'run', id, name, data }  { kind: 'answer', id, ok, reached | error }  { kind: 'ping' }
// - On connect the server records the profile and asks it for its accounts;
//   every change sends all profiles the full account list.
// - Orders are lazy and pass through: never stored.
// - Profiles and accounts are kept in a store: Postgres when DATABASE_URL is
//   set (compose.yaml), otherwise in memory. Each account gets a lasting
//   numeric ID. Which profile holds which account is recorded only while the
//   profile is connected.
// - Listens on 127.0.0.1 only and accepts only Waybill's extension origin.
//
// Run: docker compose up, or node server/server.mjs (in-memory store)
// (WAYBILL_PORT, WAYBILL_HOST, WAYBILL_EXTENSION_IDS, DATABASE_URL)
import { createServer } from 'node:http';
import { CONFIG } from '../core/config.js';
import { createRunner } from '../core/chain.js';
import { acceptWebSocket } from './websocket.mjs';
import { createMemoryStore } from './store/memory.mjs';
import { createHandlers, FROM_PROFILES } from './handlers.mjs';

const INSTANCE_ID = /^[0-9a-f-]{36}$/;

export function createWaybillServer({ extensionIds = [CONFIG.extensionId], store = createMemoryStore(), answerTimeoutMs = CONFIG.answerTimeoutMs } = {}) {
  const allowedOrigins = new Set(extensionIds.map((id) => `chrome-extension://${id}`));
  const connections = new Map(); // instanceId -> profile connection
  let allowedHosts = new Set();

  const { handlers, settled } = createHandlers({ store, isConnected: (profile) => connections.has(profile) });
  const runner = createRunner({
    side: 'server',
    handlers,
    log: (name) => { if (process.env.WAYBILL_LOG_EVENTS) console.log(`event ${name}`); },
    // A browser event: to the profile in data.to ('all': every profile, not
    // awaited), else back to the profile the chain came from.
    passOn: async (name, data, { origin }) => {
      const target = data.to ?? origin;
      if (target === 'all') {
        for (const connection of connections.values()) connection.run(name, data).catch((error) => console.error(`Waybill: ${name} to a profile failed: ${error.message}`));
        return {};
      }
      const connection = connections.get(target);
      if (!connection) throw new Error('The browser profile is no longer connected.');
      return connection.run(name, data);
    },
  });
  const runLoudly = (name, data, context) => runner.run(name, data, context).catch((error) => console.error(`Waybill: ${name} failed: ${error.message}`));

  // One profile's open connection: sends events to it and waits for its answers.
  function profileConnection(socket) {
    const pending = new Map(); // id -> { resolve, reject, timer }
    let nextId = 1;
    return {
      socket,
      run(name, data) {
        const id = nextId++;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`The browser profile didn't answer "${name}" in time.`));
          }, answerTimeoutMs);
          pending.set(id, { resolve, reject, timer });
          socket.send({ kind: 'run', id, name, data });
        });
      },
      answered({ id, ok, reached, error }) {
        const waiting = pending.get(id);
        if (!waiting) return;
        pending.delete(id);
        clearTimeout(waiting.timer);
        if (ok) waiting.resolve(reached ?? {});
        else waiting.reject(new Error(String(error).slice(0, 300)));
      },
      failAll(message) {
        for (const waiting of pending.values()) {
          clearTimeout(waiting.timer);
          waiting.reject(new Error(message));
        }
        pending.clear();
      },
    };
  }

  async function onProfileMessage(instanceId, connection, message) {
    if (message?.kind === 'ping') return;
    if (message?.kind === 'answer') return connection.answered(message);
    if (message?.kind !== 'run') throw new Error(`unknown message kind ${JSON.stringify(message?.kind)}`);
    const { id, name } = message;
    try {
      if (!FROM_PROFILES.has(name)) throw new Error(`A browser profile may not run "${name}" on the server`);
      // The sender is the connection, never a field in the message.
      const { to, ...data } = typeof message.data === 'object' && message.data ? message.data : {};
      const reached = await runner.run(name, { ...data, profile: instanceId }, { origin: instanceId });
      connection.socket.send({ kind: 'answer', id, ok: true, reached });
    } catch (error) {
      console.error(`Waybill: ${name} from profile ${instanceId} failed: ${error.message}`);
      connection.socket.send({ kind: 'answer', id, ok: false, error: error.message });
    }
  }

  function connectProfile(instanceId, socket) {
    const replaced = connections.get(instanceId);
    const connection = profileConnection(socket);
    connections.set(instanceId, connection);
    if (replaced) {
      replaced.failAll('The browser profile reconnected; please try again.');
      replaced.socket.close(); // its onClose sees it is no longer current and releases nothing
    }
    runLoudly('server:profile-connected', { profile: instanceId }, { origin: instanceId });
    return {
      onMessage: (message) => onProfileMessage(instanceId, connection, message).catch((error) => {
        console.error(`Waybill: message from profile ${instanceId}: ${error.message}`);
        socket.close();
      }),
      onClose() {
        connection.failAll('The browser profile disconnected.');
        if (connections.get(instanceId) !== connection) return;
        connections.delete(instanceId);
        runLoudly('server:profile-disconnected', { profile: instanceId }, { origin: instanceId });
      },
    };
  }

  const isAllowed = (request) => allowedHosts.has(request.headers.host) && allowedOrigins.has(request.headers.origin);

  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    if (!isAllowed(request)) {
      response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }
    // The only HTTP route: lets the extension see the server is up without a
    // failed WebSocket (which Chrome logs as an extension error).
    const status = request.method === 'GET' && pathname === '/health' ? 204 : 404;
    response.writeHead(status, { 'cache-control': 'no-store', 'access-control-allow-origin': request.headers.origin, vary: 'Origin' }).end();
  });

  server.on('upgrade', (request, socket) => {
    const { pathname, searchParams } = new URL(request.url, 'http://localhost');
    const instanceId = searchParams.get('instance') ?? '';
    if (!isAllowed(request) || pathname !== '/connect' || !INSTANCE_ID.test(instanceId)
      || request.headers.upgrade?.toLowerCase() !== 'websocket' || !request.headers['sec-websocket-key']) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    let events;
    const connection = acceptWebSocket(request, socket, {
      onMessage: (message) => events.onMessage(message),
      onClose: () => events.onClose(),
    });
    events = connectProfile(instanceId, connection);
  });

  return {
    // `host` is 127.0.0.1 except inside a container, where Docker publishes
    // the port on the machine's loopback interface only (compose.yaml).
    async listen(port = CONFIG.serverPort, host = '127.0.0.1') {
      // No profile is connected yet: profiles and holdings of a previous run are void.
      await store.releaseAllProfiles();
      return new Promise((resolve) => server.listen(port, host, () => {
        const { port: actual } = server.address();
        allowedHosts = new Set([`127.0.0.1:${actual}`, `localhost:${actual}`]);
        resolve(actual);
      }));
    },
    async close() {
      for (const connection of connections.values()) connection.socket.close();
      await new Promise((resolve) => server.close(resolve));
      await settled();
      await store.releaseAllProfiles();
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
  const port = await waybill.listen(Number(process.env.WAYBILL_PORT) || CONFIG.serverPort, host);
  console.log(`Waybill local server listening on ${host}:${port}`);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      await waybill.close();
      process.exit(0);
    });
  }
}
