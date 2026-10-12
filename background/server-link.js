// This profile's one connection to the Waybill server: a WebSocket that
// carries events both ways, in the same shape:
//   { kind: 'run', id, name, data }        run this event (and its chain) on your side
//   { kind: 'answer', id, ok, reached | error }
//   { kind: 'ping' }                       keeps the connection (and the background) alive
// While the server can't be reached, every server event ends in
// 'server:offline'. Nothing is queued: when the server is back, it asks for
// this profile's whole account list again.
import { CONFIG } from '../core/config.js';
import { whereIs } from '../core/events.js';
import * as state from '../core/state.js';

const WS_ORIGIN = CONFIG.serverOrigin.replace(/^http/, 'ws');

let socket = null;
let connecting = null;
let runLocally = null;
let nextId = 1;
const pending = new Map(); // id -> { resolve, reject, timer }

const send = (message) => socket.send(JSON.stringify(message));

// A failed fetch is silent, unlike a failed WebSocket, which Chrome logs as
// an extension error. So reachability is checked first.
async function reachable() {
  try {
    return (await fetch(`${CONFIG.serverOrigin}/health`, { signal: AbortSignal.timeout(CONFIG.serverReachableTimeoutMs) })).ok;
  } catch {
    return false;
  }
}

async function onMessage(message) {
  if (message.kind === 'answer') {
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    clearTimeout(waiting.timer);
    if (message.ok) waiting.resolve(message.reached);
    else waiting.reject(new Error(message.error));
    return;
  }
  if (message.kind !== 'run') throw new Error(`Unknown message from the server: ${message.kind}`);
  try {
    if (whereIs(message.name) !== 'background') throw new Error(`The server may not ask this profile to run "${message.name}"`);
    send({ kind: 'answer', id: message.id, ok: true, reached: await runLocally(message.name, message.data ?? {}) });
  } catch (error) {
    console.error(`[waybill] ${message.name} (from the server) failed:`, error);
    send({ kind: 'answer', id: message.id, ok: false, error: error.message });
  }
}

async function open() {
  const instanceId = await state.ensureInstanceId();
  if (!(await reachable())) return false;
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS_ORIGIN}/connect?instance=${instanceId}`);
    let keepAlive;
    ws.addEventListener('open', async () => {
      socket = ws;
      keepAlive = setInterval(() => send({ kind: 'ping' }), CONFIG.keepAliveEveryMs);
      await state.setServerOnline();
      resolve(true);
    });
    ws.addEventListener('message', ({ data }) => onMessage(JSON.parse(data)).catch((error) => console.error('[waybill] server message:', error)));
    ws.addEventListener('close', async () => {
      clearInterval(keepAlive);
      if (socket === ws) {
        socket = null;
        for (const waiting of pending.values()) {
          clearTimeout(waiting.timer);
          waiting.reject(new Error('The Waybill server disconnected before answering.'));
        }
        pending.clear();
        await state.setServerOffline();
      }
      resolve(false);
    });
  });
}

// `run(name, data)` runs a background event here; server events come back
// through it.
export function startServerLink(run) {
  runLocally = run;
  connect();
}

// Resolves true once connected, false if the server isn't reachable.
export function connect() {
  if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(true);
  connecting ??= open().finally(() => { connecting = null; });
  return connecting;
}

// Hands a server event to the server and resolves with what its chain reached.
export function runOnServer(name, data) {
  if (socket?.readyState !== WebSocket.OPEN) return Promise.resolve({ 'server:offline': data });
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`The Waybill server didn't answer "${name}" in time.`));
    }, CONFIG.answerTimeoutMs);
    pending.set(id, { resolve, reject, timer });
    send({ kind: 'run', id, name, data });
  });
}
