// Amazon addresses Waybill uses. Pure functions: used by the integration
// and by the views (links to Amazon).
export const DOMAINS = ['.com', '.ca', '.co.uk', '.com.au', '.de', '.es', '.fr', '.ie', '.it', '.ae', '.sa'];

// Amazon's sign-in handle per marketplace, as found in its own redirects.
const SIGN_IN_HANDLES = {
  '.com': 'us', '.ca': 'ca', '.co.uk': 'uk', '.com.au': 'au', '.de': 'de', '.es': 'es',
  '.fr': 'fr', '.ie': 'ie', '.it': 'it', '.ae': 'ae', '.sa': 'sa',
};
const OPENID_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';
const OPENID_NS = 'http://specs.openid.net/auth/2.0';

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
export function signInUrl(domain) {
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
