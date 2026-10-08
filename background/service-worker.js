// Background service worker:
// - connects this browser profile to the local Waybill server, keeps the
//   server's list of this profile's Amazon accounts current, and answers
//   order requests by reading Amazon in this profile (nothing is sent when the
//   server isn't running; it retries every minute);
// - while Amazon is switched on, follows the user's Amazon sign-ins and
//   sign-outs so the account list stays current without opening the popup.
// Nothing is tracked or shared while signed out of Waybill or with Amazon off.
import { getInstanceId, connectUrl, isServerRunning } from '../lib/server.js';
import { loadTrackedAccounts, affectsTrackedAccounts, isAmazonTracked, loadAccount, storeAccount, markNeedsSignIn } from '../lib/storage.js';
import { AMAZON_DOMAINS } from '../lib/amazon.js';
import { readOrders, readLatestOrders } from '../lib/amazon-orders.js';
import { askOffscreen } from '../lib/offscreen.js';

const KEEPALIVE_MS = 20_000; // WebSocket traffic keeps an MV3 service worker alive.
const RECONNECT_ALARM = 'reconnect';

let socket = null;
let connected = null; // Promise for the current connection attempt.

const send = (message) => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify(message));

// Reports exactly the tracked accounts (signed in to Waybill, Amazon on);
// otherwise an empty list, which removes this profile's accounts everywhere.
async function sendAccounts() {
  const accounts = (await loadTrackedAccounts())
    .map(({ marketplace, domain, customerId = null, name = null, email = null, status, signedInAt = null }) => ({ marketplace, domain, customerId, name, email, status, signedInAt }));
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

// --- Following Amazon sign-ins and sign-outs -------------------------------
// Signing out (Amazon's sign-out page) forgets the account at once, without a
// request. Leaving Amazon's sign-in pages (a sign-in just finished) checks the
// account. Other Amazon page loads re-check at most every RECHECK_MS. No check
// runs while the user is on a sign-in page, so it can't disturb a sign-in.
const CHECK_DELAY_MS = 1500;
const RECHECK_MS = 5 * 60_000;
const lastChecked = new Map(); // domain -> time
const inSignIn = new Set(); // domains whose last page was a sign-in page
const pendingChecks = new Map(); // domain -> { timer, afterSignIn }

const amazonDomainOf = (url) => AMAZON_DOMAINS.find((domain) => url.hostname === `www.amazon${domain}`);

// The service worker has no DOMParser; the offscreen document reads the account.
const readAccountOffscreen = (domain, known) => askOffscreen('read-account', { domain, known });

// `afterSignIn`: the user just finished signing in on this marketplace.
async function checkAccount(domain, { afterSignIn = false } = {}) {
  pendingChecks.delete(domain);
  if (!(await isAmazonTracked())) return;
  lastChecked.set(domain, Date.now());
  try {
    const account = await readAccountOffscreen(domain, await loadAccount('amazon', domain));
    const signedIn = afterSignIn && account.status === 'active';
    await storeAccount('amazon', domain, signedIn ? { ...account, signedInAt: Date.now() } : account);
  } catch {
    // Amazon unreachable or a robot check: keep the last known state.
  }
}

async function followAmazonPage(tab, change) {
  const url = new URL(change.url ?? tab.url);
  const domain = amazonDomainOf(url);
  if (!domain) return;
  if (!(await isAmazonTracked())) return;

  if (change.url && url.pathname.includes('/sign-out')) {
    clearTimeout(pendingChecks.get(domain)?.timer);
    pendingChecks.delete(domain);
    await storeAccount('amazon', domain, { status: 'signed-out' });
    return;
  }
  if (change.status !== 'complete') return;
  if (url.pathname.startsWith('/ap/')) {
    inSignIn.add(domain);
    return;
  }
  const signInFinished = inSignIn.delete(domain);
  if (!signInFinished && Date.now() - (lastChecked.get(domain) ?? 0) < RECHECK_MS) return;
  // A pending "just signed in" check keeps that flag when rescheduled.
  const pending = pendingChecks.get(domain);
  clearTimeout(pending?.timer);
  const afterSignIn = signInFinished || Boolean(pending?.afterSignIn);
  pendingChecks.set(domain, { afterSignIn, timer: setTimeout(() => checkAccount(domain, { afterSignIn }), CHECK_DELAY_MS) });
}

// Amazon host permissions make tab URLs visible for Amazon pages only.
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if ((change.url || change.status === 'complete') && tab.url) followAmazonPage(tab, change);
});

// --- Server registration -----------------------------------------------------
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && affectsTrackedAccounts(changes)) sendAccounts();
});

// Every minute: reconnect if the server was unreachable.
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === RECONNECT_ALARM) connect(); });
chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 1 });

// Pages ask for a connection before reading the server's account list.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'connect' || sender.id !== chrome.runtime.id) return false;
  Promise.all([connect(), getInstanceId()]).then(([ok, instanceId]) => sendResponse({ connected: ok, instanceId }));
  return true;
});

connect();
