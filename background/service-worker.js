// Background service worker:
// - connects this browser profile to the local Waybill server, keeps the
//   server's list of this profile's Amazon accounts current, and answers
//   order requests by reading Amazon in this profile (nothing is sent when the
//   server isn't running; it retries every minute);
// - while Amazon is switched on, follows the user's Amazon sign-ins and
//   sign-outs so the account list stays current without opening the popup.
import { getInstanceId, connectUrl, isServerRunning } from '../lib/server.js';
import { loadAccounts, loadAccount, storeAccount, loadMarketplaces, markNeedsSignIn } from '../lib/storage.js';
import { AMAZON_DOMAINS } from '../lib/amazon.js';
import { readOrders, readLatestOrders, isOrdersWindow } from '../lib/amazon-orders.js';

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

// --- Following Amazon sign-ins and sign-outs -------------------------------
// Signing out (Amazon's sign-out page) forgets the account at once, without a
// request. Leaving Amazon's sign-in pages (a sign-in just finished) checks the
// account. Other Amazon page loads re-check at most every RECHECK_MS. No check
// runs while the user is on a sign-in page, so it can't disturb a sign-in.
const CHECK_DELAY_MS = 1500;
const RECHECK_MS = 5 * 60_000;
const lastChecked = new Map(); // domain -> time
const inSignIn = new Set(); // domains whose last page was a sign-in page
const pendingChecks = new Map(); // domain -> timer

const amazonDomainOf = (url) => AMAZON_DOMAINS.find((domain) => url.hostname === `www.amazon${domain}`);

async function readAccountOffscreen(domain, known) {
  const [existing] = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: 'background/offscreen.html',
      reasons: ['DOM_PARSER'],
      justification: 'Read which Amazon account is signed in from Amazon pages.',
    }).catch(() => {}); // Already being created by a concurrent check.
  }
  const answer = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'read-account', domain, known });
  if (answer?.error) throw new Error(answer.error);
  return answer.account;
}

async function checkAccount(domain) {
  pendingChecks.delete(domain);
  if (!(await loadMarketplaces()).amazon.enabled) return;
  lastChecked.set(domain, Date.now());
  try {
    await storeAccount('amazon', domain, await readAccountOffscreen(domain, await loadAccount('amazon', domain)));
  } catch {
    // Amazon unreachable or a robot check: keep the last known state.
  }
}

async function followAmazonPage(tab, change) {
  const url = new URL(change.url ?? tab.url);
  const domain = amazonDomainOf(url);
  if (!domain || await isOrdersWindow(tab.windowId)) return;
  if (!(await loadMarketplaces()).amazon.enabled) return;

  if (change.url && url.pathname.includes('/sign-out')) {
    clearTimeout(pendingChecks.get(domain));
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
  clearTimeout(pendingChecks.get(domain));
  pendingChecks.set(domain, setTimeout(() => checkAccount(domain), CHECK_DELAY_MS));
}

// Amazon host permissions make tab URLs visible for Amazon pages only.
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if ((change.url || change.status === 'complete') && tab.url) followAmazonPage(tab, change);
});

// --- Server registration -----------------------------------------------------
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
