// Development probe: does this profile's Amazon sign-in reach the extension,
// and which account identifiers (id, email) do Amazon's own pages expose?
// It reads a few pages with the browser's existing session, prints masked
// findings, and keeps nothing. It never handles a password or a cookie value.
//
// Runs on load for ?check=.co.uk:2024,.com:2023, or from the form.
const form = document.querySelector('[data-probe]');
const output = document.querySelector('[data-result]');

const mask = (value) => value.length <= 4
  ? '•'.repeat(value.length)
  : `${value.slice(0, 2)}…${value.slice(-2)} (${value.length} chars)`;
const maskEmail = (email) => {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 2)}…@…${domain.slice(-4)}`;
};

// Any "<something>customer<something>": "<id-like value>" pair, in JSON or JS.
const customerKeyPattern = /["']?([A-Za-z_]*[Cc]ustomer[A-Za-z_]*)["']?\s*[:=]\s*["']([A-Za-z0-9.\-]{8,80})["']/g;
const accountUrnPattern = /amzn1\.account\.[A-Z0-9]{10,}/g;
const emailPattern = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const orderIdPattern = /\b(?:\d{3}|D01)-\d{7}-\d{7}\b/g;

// A short, one-way fingerprint so values can be compared across marketplaces
// and profiles without showing them.
async function fingerprint(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest).slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function describe(values, maskValue) {
  return Promise.all([...new Set(values)].map(async (value) => `${maskValue(value)} #${await fingerprint(value)}`));
}

function tally(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].map(([value, count]) => `${value} ×${count}`);
}

async function read(url) {
  const response = await fetch(url, { credentials: 'include' });
  const html = await response.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const visibleText = doc.body?.textContent ?? '';
  return {
    status: response.status,
    redirected: response.redirected,
    finalPath: new URL(response.url).pathname,
    title: doc.title.trim().slice(0, 60),
    captcha: !!doc.querySelector('form[action*="validateCaptcha"]'),
    greeting: await (async () => {
      const text = doc.querySelector('#nav-link-accountList-nav-line-1')?.textContent.trim();
      if (!text || /sign in/i.test(text)) return text ?? null;
      const [hello, ...name] = text.split(',');
      const fullName = name.join(',').trim();
      return `${hello}, ${mask(fullName)} #${await fingerprint(fullName)}`;
    })(),
    emailsInVisibleText: await describe(visibleText.match(emailPattern) ?? [], maskEmail),
    emailsInSource: tally((html.match(emailPattern) ?? []).map(maskEmail)).slice(0, 6),
    customerIdKeys: tally([...html.matchAll(customerKeyPattern)].map(([, key]) => key)),
    customerIds: await describe([
      ...[...html.matchAll(customerKeyPattern)].map(([, , value]) => value),
      ...(html.match(accountUrnPattern) ?? []),
    ], mask),
    distinctOrderIds: new Set(html.match(orderIdPattern) ?? []).size,
    productLinks: doc.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]').length,
  };
}

async function probe(domain, year) {
  const origin = `https://www.amazon${domain}`;
  if (!await chrome.permissions.contains({ origins: [`${origin}/*`] })) {
    return { domain, hostPermission: 'not granted' };
  }
  const pages = {
    home: `${origin}/`,
    yourAccount: `${origin}/gp/css/homepage.html`,
    orders: `${origin}/your-orders/orders?timeFilter=year-${year}`,
  };
  const results = { domain, year, hostPermission: 'granted' };
  for (const [name, url] of Object.entries(pages)) {
    try { results[name] = await read(url); } catch (error) { results[name] = `${error.name}: ${error.message}`; }
  }
  return results;
}

async function run(checks) {
  output.textContent = 'Checking…';
  const results = [];
  for (const [domain, year] of checks) results.push(await probe(domain, year));
  output.textContent = JSON.stringify(results, null, 2);
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const data = new FormData(form);
  run([[data.get('domain'), data.get('year')]]);
});

const requested = new URLSearchParams(location.search).get('check');
if (requested) run(requested.split(',').map((pair) => pair.split(':')));
