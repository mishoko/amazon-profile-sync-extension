// Client side of the local Waybill server (server/server.mjs), which joins the
// Amazon accounts of every browser profile that has Waybill installed.
export const SERVER_ORIGIN = 'http://127.0.0.1:4417';
const INSTANCE_KEY = 'instanceId';
const REACHABLE_TIMEOUT_MS = 1500;

// A random ID for this browser profile's Waybill, created once.
export async function getInstanceId() {
  const { [INSTANCE_KEY]: stored } = await chrome.storage.local.get(INSTANCE_KEY);
  if (stored) return stored;
  const instanceId = crypto.randomUUID();
  await chrome.storage.local.set({ [INSTANCE_KEY]: instanceId });
  return instanceId;
}

// A failed fetch is silent, unlike a failed WebSocket, which Chrome logs as an
// extension error. So reachability is checked first.
export async function isServerRunning() {
  try {
    return (await fetch(`${SERVER_ORIGIN}/health`, { signal: AbortSignal.timeout(REACHABLE_TIMEOUT_MS) })).ok;
  } catch {
    return false;
  }
}

const WS_ORIGIN = SERVER_ORIGIN.replace(/^http/, 'ws');
export const connectUrl = (instanceId) => `${WS_ORIGIN}/connect?instance=${instanceId}`;

// Calls onAccounts with the full account list of all profiles now and after
// every change, and onLost once if the server goes away. Returns a stop function.
export function watchAccounts(onAccounts, onLost) {
  const socket = new WebSocket(`${WS_ORIGIN}/watch`);
  let stopped = false;
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.type === 'accounts') onAccounts(message.accounts);
  });
  socket.addEventListener('close', () => { if (!stopped) onLost(); });
  return () => {
    stopped = true;
    socket.close();
  };
}

async function call(path, init = {}) {
  const response = await fetch(`${SERVER_ORIGIN}${path}`, { ...init, headers: { 'content-type': 'application/json' } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Local server answered ${response.status}`);
  return body;
}

// Asks whichever profile holds the account (by its server ID) to read its
// orders: { instanceId, result }.
export function requestOrders(accountId, filter) {
  return call(`/accounts/${accountId}/orders`, { method: 'POST', body: JSON.stringify({ filter }) });
}
