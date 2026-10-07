// Reads this browser profile's own Amazon session: who is signed in on a
// marketplace. Every request is an ordinary page load with the browser's
// existing Amazon sign-in. Orders are read by amazon-orders.js. Nothing here sees a
// password or a cookie value, and nothing is sent anywhere but Amazon.

export const AMAZON_DOMAINS = ['.com', '.ca', '.co.uk', '.com.au', '.de', '.es', '.fr', '.ie', '.it', '.ae', '.sa'];

// Amazon's sign-in handle per marketplace, as found in its own redirects.
const SIGN_IN_HANDLES = {
  '.com': 'us', '.ca': 'ca', '.co.uk': 'uk', '.com.au': 'au', '.de': 'de', '.es': 'es',
  '.fr': 'fr', '.ie': 'ie', '.it': 'it', '.ae': 'ae', '.sa': 'sa',
};
const OPENID_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';
const OPENID_NS = 'http://specs.openid.net/auth/2.0';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const CUSTOMER_ID = /["']?(?:obfuscatedCustomerId|customerId|customerID)["']?\s*[:=]\s*["'](A[A-Z0-9]{9,20})["']/;

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
