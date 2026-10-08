// Reads an Amazon account's orders from the real orders page. Amazon sends
// order details encrypted in the page and decrypts them with its own scripts,
// so the page has to run. It runs invisibly: the offscreen document loads it
// in a hidden iframe (background/offscreen.js), content/orders-frame.js reads
// the rendered orders, and nothing is ever shown on screen. Orders are
// returned to the caller and never stored.
import { ordersUrl } from './amazon.js';
import { askOffscreen } from './offscreen.js';

const MAX_PAGES = 5;

async function readPage(url) {
  const result = await askOffscreen('read-orders-page', { url });
  if (result.status === 'needs-sign-in') return result;
  if (result.status === 'error') throw new Error(result.error);
  if (result.cardCount > 0 && result.orders.length === 0) {
    throw new Error(`Amazon showed ${result.cardCount} orders, but Waybill couldn't read them`);
  }
  return result;
}

// One time filter's orders, following Amazon's pagination. `source` records
// which Amazon pages were read, when, and how long it took.
async function readFilter(domain, filter) {
  const startedAt = Date.now();
  const pages = [];
  const orders = [];
  let first = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = ordersUrl(domain, { filter, startIndex: orders.length });
    pages.push(url);
    const result = await readPage(url);
    if (result.status !== 'active') return result;
    first ??= result;
    orders.push(...result.orders);
    if (!result.hasNextPage || !result.orders.length) break;
  }
  const source = { pages, readAt: Date.now(), durationMs: Date.now() - startedAt };
  return { status: 'active', filter: first.filter, filters: first.filters, orders, source };
}

// { status: 'active', filter, filters, orders, source } or { status: 'needs-sign-in' }
export function readOrders(domain, filter) {
  return readFilter(domain, filter);
}

// Amazon's default period, or else the most recent year that has orders.
export async function readLatestOrders(domain) {
  const first = await readFilter(domain, null);
  if (first.status !== 'active' || first.orders.length) return first;
  for (const { value } of first.filters.filter(({ value }) => value.startsWith('year-'))) {
    const result = await readFilter(domain, value);
    if (result.status !== 'active' || result.orders.length) return { ...result, filters: first.filters };
  }
  return first;
}
