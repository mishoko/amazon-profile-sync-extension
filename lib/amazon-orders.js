// Reads an Amazon account's orders from the real orders page. Amazon encrypts
// order details in the page and decrypts them with its own scripts, so the page
// has to run: Waybill opens it in a minimized window of its own, lets it load,
// reads the decrypted order cards (content/read-orders.js), then closes the
// window. Orders are returned to the caller and never stored.
import { ordersUrl } from './amazon.js';

const LOAD_TIMEOUT_MS = 30000;
const MAX_PAGES = 5;
const openWindows = new Set();

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

async function readPage(tabId, url) {
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

// One time filter's orders, following Amazon's pagination.
async function readFilter(tabId, domain, filter) {
  const orders = [];
  let first = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await readPage(tabId, ordersUrl(domain, { filter, startIndex: orders.length }));
    if (result.status !== 'active') return result;
    first ??= result;
    orders.push(...result.orders);
    if (!result.hasNextPage || !result.orders.length) break;
  }
  return { status: 'active', filter: first.filter, filters: first.filters, orders };
}

async function withOrdersWindow(task) {
  const window = await chrome.windows.create({ url: 'about:blank', focused: false, state: 'minimized' });
  openWindows.add(window.id);
  try {
    return await task(window.tabs[0].id);
  } finally {
    openWindows.delete(window.id);
    chrome.windows.remove(window.id).catch(() => {});
  }
}

// { status: 'active', filter, filters, orders } or { status: 'needs-sign-in' }
export function readOrders(domain, filter) {
  return withOrdersWindow((tabId) => readFilter(tabId, domain, filter));
}

// Amazon's default period, or else the most recent year that has orders.
export function readLatestOrders(domain) {
  return withOrdersWindow(async (tabId) => {
    const first = await readFilter(tabId, domain, null);
    if (first.status !== 'active' || first.orders.length) return first;
    for (const { value } of first.filters.filter(({ value }) => value.startsWith('year-'))) {
      const result = await readFilter(tabId, domain, value);
      if (result.status !== 'active' || result.orders.length) return { ...result, filters: first.filters };
    }
    return first;
  });
}

// Closes any orders window still open, e.g. when the Activity page goes away.
export function closeOrdersWindows() {
  for (const id of openWindows) chrome.windows.remove(id).catch(() => {});
  openWindows.clear();
}
