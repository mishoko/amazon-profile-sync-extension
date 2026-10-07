// Reads this browser profile's own Amazon session: who is signed in on a
// marketplace, and that account's orders. Every request is an ordinary page
// load with the browser's existing Amazon sign-in. Nothing here sees a
// password or a cookie value, and nothing is sent anywhere but Amazon.

export const AMAZON_DOMAINS = ['.com', '.ca', '.co.uk', '.com.au', '.de', '.es', '.fr', '.ie', '.it', '.ae', '.sa'];

// Amazon's sign-in handle per marketplace, as found in its own redirects.
const SIGN_IN_HANDLES = {
  '.com': 'us', '.ca': 'ca', '.co.uk': 'uk', '.com.au': 'au', '.de': 'de', '.es': 'es',
  '.fr': 'fr', '.ie': 'ie', '.it': 'it', '.ae': 'ae', '.sa': 'sa',
};
const OPENID_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';
const OPENID_NS = 'http://specs.openid.net/auth/2.0';

const ORDER_ID = /\b(?:\d{3}|D01)-\d{7}-\d{7}\b/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const CUSTOMER_ID = /["']?(?:obfuscatedCustomerId|customerId|customerID)["']?\s*[:=]\s*["'](A[A-Z0-9]{9,20})["']/;
const ORDER_CARD = '.order-card, .js-order-card, .a-box-group.order';
const MAX_ORDER_PAGES = 5;

export const amazonOrigin = (domain) => `https://www.amazon${domain}`;

export function ordersUrl(domain, { filter, startIndex = 0 } = {}) {
  const url = new URL('/your-orders/orders', amazonOrigin(domain));
  if (filter) url.searchParams.set('timeFilter', filter);
  if (startIndex) url.searchParams.set('startIndex', String(startIndex));
  return url.href;
}

export function orderDetailsUrl(domain, orderId) {
  const url = new URL('/your-orders/order-details', amazonOrigin(domain));
  url.searchParams.set('orderID', orderId);
  return url.href;
}

// The "confirm your password" page for the remembered account. It shows the
// account's email address; Waybill only reads it and never submits the form.
function signInUrl(domain) {
  const url = new URL('/ap/signin', amazonOrigin(domain));
  url.search = new URLSearchParams({
    'openid.pape.max_auth_age': '0',
    'openid.return_to': ordersUrl(domain),
    'openid.identity': OPENID_SELECT,
    'openid.assoc_handle': `amzn_retail_yourorders_${SIGN_IN_HANDLES[domain]}`,
    'openid.mode': 'checkid_setup',
    'openid.claimed_id': OPENID_SELECT,
    'openid.ns': OPENID_NS,
  }).toString();
  return url.href;
}

async function fetchPage(url) {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error(`Amazon answered ${response.status}`);
  const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
  if (doc.querySelector('form[action*="validateCaptcha"]')) throw new Error('Amazon asked for a robot check');
  return { doc, isSignIn: new URL(response.url).pathname.startsWith('/ap/') };
}

const clean = (text) => text?.replace(/\s+/g, ' ').trim() || null;

export function parseCustomer(doc) {
  const greeting = clean(doc.querySelector('#nav-link-accountList-nav-line-1')?.textContent);
  return {
    customerId: doc.documentElement.innerHTML.match(CUSTOMER_ID)?.[1] ?? null,
    name: greeting?.includes(',') ? clean(greeting.slice(greeting.indexOf(',') + 1)) : null,
  };
}

export function parseSignInEmail(doc) {
  const form = doc.querySelector('form[name="signIn"]') ?? doc.body;
  return form?.textContent.match(EMAIL)?.[0] ?? null;
}

// Signed-in state of one marketplace:
//   { status: 'active', customerId, name, email }  orders are readable
//   { status: 'needs-sign-in', email }             Amazon wants the password again
//   { status: 'signed-out' }                       nobody is signed in
// `known` is the previously stored account, so its email isn't re-read.
export async function readAccount(domain, known = null) {
  const orders = await fetchPage(ordersUrl(domain));
  if (orders.isSignIn) {
    const email = parseSignInEmail(orders.doc);
    return email ? { status: 'needs-sign-in', email } : { status: 'signed-out' };
  }
  const { customerId, name } = parseCustomer(orders.doc);
  if (!customerId) return { status: 'signed-out' };
  const email = known?.customerId === customerId && known.email
    ? known.email
    : parseSignInEmail((await fetchPage(signInUrl(domain))).doc);
  return { status: 'active', customerId, name, email };
}

function headerFields(card) {
  const fields = {};
  for (const label of card.querySelectorAll('.a-text-caps')) {
    const column = label.closest('li, .a-column');
    if (!column) continue;
    const name = clean(label.textContent).toLowerCase();
    const value = clean(column.textContent.replace(label.textContent, ''));
    if (/placed|order date/.test(name)) fields.placed ??= value;
    else if (/total/.test(name)) fields.total ??= value;
  }
  return fields;
}

function parseItems(card, domain) {
  const items = new Map();
  for (const link of card.querySelectorAll('.yohtmlc-product-title a, a.yohtmlc-product-title, .yohtmlc-item a[href*="/dp/"], a[href*="/dp/"], a[href*="/gp/product/"]')) {
    const title = clean(link.textContent);
    if (!title || items.has(title)) continue;
    const image = link.closest('.a-fixed-left-grid, .item-box, .yohtmlc-item, .a-row')?.querySelector('img');
    items.set(title, {
      title,
      url: new URL(link.getAttribute('href'), amazonOrigin(domain)).href,
      image: image?.getAttribute('data-a-hires') || image?.getAttribute('src') || null,
    });
  }
  return [...items.values()];
}

export function parseOrders(doc, domain) {
  const cards = [...doc.querySelectorAll(ORDER_CARD)].filter((card) => !card.parentElement?.closest(ORDER_CARD));
  return cards.map((card) => {
    const id = (card.querySelector('.yohtmlc-order-id')?.textContent ?? card.textContent).match(ORDER_ID)?.[0] ?? null;
    const status = ['.delivery-box__primary-text', '.yohtmlc-shipment-status-primaryText', '.js-shipment-info-container .a-text-bold', '.shipment-top-row .a-text-bold']
      .map((selector) => clean(card.querySelector(selector)?.textContent))
      .find(Boolean) ?? null;
    return { id, ...headerFields(card), status, items: parseItems(card, domain) };
  }).filter((order) => order.id);
}

export function parseTimeFilters(doc) {
  return [...doc.querySelectorAll('select[name="timeFilter"] option')]
    .map((option) => ({ value: option.value, label: clean(option.textContent), selected: option.selected }))
    .filter((option) => option.value);
}

const hasNextPage = (doc) => !!doc.querySelector('.a-pagination .a-last:not(.a-disabled) a');

// One time filter's orders (all of its pages, up to MAX_ORDER_PAGES):
//   { status: 'active', filter, filters, orders }
//   { status: 'needs-sign-in' }
export async function readOrders(domain, filter = null) {
  const orders = [];
  let filters = [];
  for (let page = 0; page < MAX_ORDER_PAGES; page += 1) {
    const { doc, isSignIn } = await fetchPage(ordersUrl(domain, { filter, startIndex: orders.length }));
    if (isSignIn) return { status: 'needs-sign-in' };
    if (page === 0) filters = parseTimeFilters(doc);
    const found = parseOrders(doc, domain);
    orders.push(...found);
    if (!found.length || !hasNextPage(doc)) break;
  }
  return { status: 'active', filter: filter ?? filters.find((option) => option.selected)?.value ?? null, filters, orders };
}

// Amazon's default view, or else the most recent year that has orders.
export async function readLatestOrders(domain) {
  const first = await readOrders(domain);
  if (first.status !== 'active' || first.orders.length) return first;
  for (const { value } of first.filters.filter(({ value }) => value.startsWith('year-'))) {
    const result = await readOrders(domain, value);
    if (result.status !== 'active' || result.orders.length) return { ...result, filters: first.filters };
  }
  return first;
}
