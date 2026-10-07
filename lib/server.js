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

export const connectUrl = (instanceId) => `${SERVER_ORIGIN.replace(/^http/, 'ws')}/connect?instance=${instanceId}`;

async function call(path, init = {}, timeoutMs) {
  const response = await fetch(`${SERVER_ORIGIN}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json' },
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Local server answered ${response.status}`);
  return body;
}

// Accounts from all connected profiles; throws when the server isn't running.
export async function fetchAccounts() {
  return (await call('/accounts', {}, REACHABLE_TIMEOUT_MS)).accounts;
}

// Asks whichever profile holds the account to read its orders: { instanceId, result }.
export function requestOrders(key, filter) {
  return call(`/accounts/${encodeURIComponent(key)}/orders`, { method: 'POST', body: JSON.stringify({ filter }) });
}
