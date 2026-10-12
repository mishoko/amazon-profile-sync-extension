// Amazon: what Waybill needs from it, in the shape every integration has
// (see integrations/index.js). Nothing here sees a password or a cookie value;
// pages are read with the browser's own Amazon sign-in, and nothing is sent
// anywhere but Amazon.
import { CONFIG } from '../../core/config.js';
import { readFetchedPage, readRenderedPage, SiteUnreachable } from '../../background/page-tools.js';
import { DOMAINS, ordersUrl, signInUrl } from './urls.js';

export const id = 'amazon';
export const name = 'Amazon';
export const sites = DOMAINS.map((domain) => ({ domain, host: `www.amazon${domain}` }));

const ACCOUNT_PAGE = 'integrations/amazon/account-page.js';
const ORDERS_PAGE = 'integrations/amazon/orders-page.js';

// What a page the user loads means: 'sign-in' (Amazon's /ap/ pages),
// 'sign-out', or 'other'.
export function pageKind(url) {
  if (url.pathname.includes('/sign-out')) return 'sign-out';
  if (url.pathname.startsWith('/ap/')) return 'sign-in';
  return 'other';
}

// A site that can't be reached is an outcome; any other error is a bug.
function unreachable(error) {
  if (error instanceof SiteUnreachable) return { event: 'site:unreachable', data: { reason: error.message } };
  throw error;
}

async function fetchAccountPage(url) {
  const page = await readFetchedPage(url, ACCOUNT_PAGE);
  if (page.robotCheck) throw new SiteUnreachable('Amazon asked for a robot check');
  return page;
}

// Who is signed in on this marketplace. `known` is the stored account, so its
// email isn't read again.
export async function checkAccount({ domain }, known) {
  try {
    const orders = await fetchAccountPage(ordersUrl(domain));
    if (orders.isSignIn) {
      return orders.email ? { event: 'site:needs-sign-in', data: { email: orders.email } } : { event: 'site:account-gone' };
    }
    if (!orders.customerId) return { event: 'site:account-gone' };
    const email = known?.customerId === orders.customerId && known.email
      ? known.email
      : (await fetchAccountPage(signInUrl(domain))).email;
    return { event: 'site:account-found', data: { account: { status: 'active', customerId: orders.customerId, name: orders.name, email } } };
  } catch (error) {
    return unreachable(error);
  }
}

async function readPage(url) {
  const page = await readRenderedPage(url, ORDERS_PAGE);
  if (page.status === 'robot-check') throw new SiteUnreachable('Amazon asked for a robot check');
  if (page.status === 'active' && page.cardCount > 0 && page.orders.length === 0) {
    throw new Error(`Amazon showed ${page.cardCount} orders, but Waybill couldn't read them`);
  }
  return page;
}

// One time filter's orders, following Amazon's pagination. `source` records
// which Amazon pages were read, when, and how long it took.
async function readFilter(domain, filter) {
  const startedAt = Date.now();
  const pages = [];
  const orders = [];
  let first = null;
  for (let page = 0; page < CONFIG.maxOrderPages; page += 1) {
    const url = ordersUrl(domain, { filter, startIndex: orders.length });
    pages.push(url);
    const result = await readPage(url);
    if (result.status !== 'active') return result;
    first ??= result;
    orders.push(...result.orders);
    if (!result.hasNextPage || !result.orders.length) break;
  }
  return { status: 'active', filter: first.filter, filters: first.filters, orders, source: { pages, readAt: Date.now(), durationMs: Date.now() - startedAt } };
}

// Amazon's default period, or else the most recent year that has orders.
async function readLatest(domain) {
  const first = await readFilter(domain, null);
  if (first.status !== 'active' || first.orders.length) return first;
  for (const { value } of first.filters.filter(({ value }) => value.startsWith('year-'))) {
    const result = await readFilter(domain, value);
    if (result.status !== 'active' || result.orders.length) return { ...result, filters: first.filters };
  }
  return first;
}

// The orders, read live and never stored.
export async function readOrders({ domain }, filter) {
  try {
    const { status, ...result } = filter ? await readFilter(domain, filter) : await readLatest(domain);
    return status === 'needs-sign-in' ? { event: 'site:needs-sign-in' } : { event: 'site:orders-read', data: { result } };
  } catch (error) {
    return unreachable(error);
  }
}
