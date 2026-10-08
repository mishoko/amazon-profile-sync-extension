// Reads an Amazon account's orders from the real orders page. Amazon encrypts
// order details in the page and decrypts them with its own scripts, so the page
// has to run: Waybill opens it in a minimized window of its own, lets it load,
// reads the decrypted order cards (content/read-orders.js), then closes the
// window. Orders are returned to the caller and never stored.
import { ordersUrl } from './amazon.js';

const LOAD_TIMEOUT_MS = 30000;
const MAX_PAGES = 5;
// A hidden orders window untouched this long belongs to a read that was cut
// off (its page or worker was stopped) and is closed by closeAbandonedOrdersWindows.
const ABANDONED_AFTER_MS = 2 * 60_000;
const WINDOW_KEY_PREFIX = 'ordersWindow:';
const openWindows = new Set();

// Each orders window is recorded in session storage (one key per window, so
// concurrent reads never overwrite each other) with the time of its last
// page load. This lets the background worker tell Waybill's own windows from
// the user's Amazon browsing, and close windows a cut-off read left behind.
const windowKey = (windowId) => `${WINDOW_KEY_PREFIX}${windowId}`;
const recordOrdersWindow = (windowId, visible) =>
  chrome.storage.session.set({ [windowKey(windowId)]: { touchedAt: Date.now(), visible } });
const touchOrdersWindow = async (windowId) => {
  const key = windowKey(windowId);
  const { [key]: entry } = await chrome.storage.session.get(key);
  if (entry) await chrome.storage.session.set({ [key]: { ...entry, touchedAt: Date.now() } });
};
const forgetOrdersWindow = (windowId) => chrome.storage.session.remove(windowKey(windowId));

export async function isOrdersWindow(windowId) {
  const key = windowKey(windowId);
  return key in (await chrome.storage.session.get(key));
}

export async function closeAbandonedOrdersWindows() {
  const entries = Object.entries(await chrome.storage.session.get(null)).filter(([key]) => key.startsWith(WINDOW_KEY_PREFIX));
  for (const [key, { touchedAt, visible }] of entries) {
    if (visible || Date.now() - touchedAt < ABANDONED_AFTER_MS) continue;
    await chrome.windows.remove(Number(key.slice(WINDOW_KEY_PREFIX.length))).catch(() => {}); // may already be gone
    await chrome.storage.session.remove(key);
  }
}

function waitForLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Amazon took too long to load')), LOAD_TIMEOUT_MS);
    const onUpdated = (id, change, tab) => {
      if (id === tabId && change.status === 'complete' && tab.url && tab.url !== 'about:blank') finish(null, tab);
    };
    const onRemoved = (id) => { if (id === tabId) finish(new Error('The orders window was closed')); };
    function finish(error, tab) {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (error) reject(error); else resolve(tab);
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

async function readPage({ tabId, windowId }, url) {
  await touchOrdersWindow(windowId);
  const loaded = waitForLoad(tabId);
  await chrome.tabs.update(tabId, { url });
  const tab = await loaded;
  if (new URL(tab.url).pathname.startsWith('/ap/')) return { status: 'needs-sign-in' };
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/read-orders.js'] });
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: () => globalThis.waybillReadOrders() });
  if (result.cardCount > 0 && result.orders.length === 0) {
    throw new Error(`Amazon showed ${result.cardCount} orders, but Waybill couldn't read them`);
  }
  return { status: 'active', ...result };
}

// One time filter's orders, following Amazon's pagination. `source` records
// which Amazon pages were read, when, and how long it took.
async function readFilter(ordersTab, domain, filter) {
  const startedAt = Date.now();
  const pages = [];
  const orders = [];
  let first = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = ordersUrl(domain, { filter, startIndex: orders.length });
    pages.push(url);
    const result = await readPage(ordersTab, url);
    if (result.status !== 'active') return result;
    first ??= result;
    orders.push(...result.orders);
    if (!result.hasNextPage || !result.orders.length) break;
  }
  const source = { pages, readAt: Date.now(), durationMs: Date.now() - startedAt };
  return { status: 'active', filter: first.filter, filters: first.filters, orders, source };
}

// `visible` (development only) keeps the window shown and open afterwards, so
// its DevTools can show Amazon's requests and the decrypted page.
async function withOrdersWindow(task, { visible = false } = {}) {
  const window = await chrome.windows.create(visible
    ? { url: 'about:blank', focused: true, state: 'normal' }
    : { url: 'about:blank', focused: false, state: 'minimized' });
  if (!visible) openWindows.add(window.id);
  await recordOrdersWindow(window.id, visible);
  try {
    return await task({ tabId: window.tabs[0].id, windowId: window.id });
  } finally {
    if (!visible) {
      openWindows.delete(window.id);
      chrome.windows.remove(window.id).catch(() => {});
    }
    await forgetOrdersWindow(window.id);
  }
}

// { status: 'active', filter, filters, orders, source } or { status: 'needs-sign-in' }
export function readOrders(domain, filter, options) {
  return withOrdersWindow((ordersTab) => readFilter(ordersTab, domain, filter), options);
}

// Amazon's default period, or else the most recent year that has orders.
export function readLatestOrders(domain, options) {
  return withOrdersWindow(async (ordersTab) => {
    const first = await readFilter(ordersTab, domain, null);
    if (first.status !== 'active' || first.orders.length) return first;
    for (const { value } of first.filters.filter(({ value }) => value.startsWith('year-'))) {
      const result = await readFilter(ordersTab, domain, value);
      if (result.status !== 'active' || result.orders.length) return { ...result, filters: first.filters };
    }
    return first;
  }, options);
}

// Closes any orders window still open, e.g. when the Activity page goes away.
export function closeOrdersWindows() {
  for (const id of openWindows) chrome.windows.remove(id).catch(() => {});
  openWindows.clear();
}
