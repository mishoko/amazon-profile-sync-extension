// Background service worker: connects this browser profile to the local
// Waybill server, keeps the server's list of this profile's Amazon accounts
// current, and answers order requests by reading Amazon in this profile.
// Nothing is sent when the server isn't running; it retries every minute.
import { getInstanceId, connectUrl, isServerRunning } from '../lib/server.js';
import { loadAccounts, markNeedsSignIn } from '../lib/storage.js';
import { readOrders, readLatestOrders } from '../lib/amazon-orders.js';

const KEEPALIVE_MS = 20_000; // WebSocket traffic keeps an MV3 service worker alive.
const RECONNECT_ALARM = 'reconnect';

let socket = null;
let connected = null; // Promise for the current connection attempt.

const send = (message) => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify(message));

async function sendAccounts() {
  const accounts = (await loadAccounts())
    .filter((account) => account.marketplace === 'amazon')
    .map(({ marketplace, domain, customerId = null, name = null, email = null, status }) => ({ marketplace, domain, customerId, name, email, status }));
  send({ type: 'accounts', accounts });
}

async function answerOrderRequest({ requestId, domain, filter }) {
  try {
    const result = filter ? await readOrders(domain, filter) : await readLatestOrders(domain);
    if (result.status === 'needs-sign-in') await markNeedsSignIn('amazon', domain);
    send({ type: 'orders-result', requestId, result });
  } catch (error) {
    send({ type: 'orders-result', requestId, error: error.message });
  }
}

// Resolves true once connected and registered, false if the server isn't reachable.
function connect() {
  if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(true);
  connected ??= Promise.all([getInstanceId(), isServerRunning()]).then(([instanceId, running]) => new Promise((resolve) => {
    if (!running) return resolve(false);
    const ws = new WebSocket(connectUrl(instanceId));
    let keepalive;
    ws.addEventListener('open', async () => {
      socket = ws;
      keepalive = setInterval(() => send({ type: 'ping' }), KEEPALIVE_MS);
      await sendAccounts();
      resolve(true);
    });
    ws.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.type === 'read-orders') answerOrderRequest(message);
    });
    ws.addEventListener('close', () => {
      clearInterval(keepalive);
      if (socket === ws) socket = null;
      resolve(false);
    });
  })).finally(() => { connected = null; });
  return connected;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.keys(changes).some((key) => key.startsWith('account:'))) sendAccounts();
});

chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === RECONNECT_ALARM) connect(); });
chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 1 });

// Pages ask for a connection before reading the server's account list.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'connect' || sender.id !== chrome.runtime.id) return false;
  Promise.all([connect(), getInstanceId()]).then(([ok, instanceId]) => sendResponse({ connected: ok, instanceId }));
  return true;
});

connect();
