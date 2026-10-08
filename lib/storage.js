// Persisted extension state in chrome.storage.local, shared by the popup and
// the Activity page. Only this profile's Amazon account summaries (marketplace,
// customer ID, name, email, status) are stored; orders are never stored.

const MARKETPLACES_KEY = 'marketplaces';
const ACCOUNT_PREFIX = 'account:';
// The Waybill sign-in. There is no account service yet: development builds
// keep the name of the signed-in preview fixture (dev/preview-sessions.js).
const SESSION_KEY = 'waybillSession';

export async function loadSessionName() {
  return (await chrome.storage.local.get(SESSION_KEY))[SESSION_KEY] ?? null;
}

export function saveSessionName(name) {
  return name ? chrome.storage.local.set({ [SESSION_KEY]: name }) : chrome.storage.local.remove(SESSION_KEY);
}

export const isSessionChange = (changes) => SESSION_KEY in changes;

const DEFAULT_MARKETPLACES = {
  amazon: { enabled: false, expanded: false, domain: '.com' },
  aliexpress: { enabled: false },
};

export async function loadMarketplaces() {
  const { [MARKETPLACES_KEY]: stored = {} } = await chrome.storage.local.get(MARKETPLACES_KEY);
  return {
    amazon: { ...DEFAULT_MARKETPLACES.amazon, ...stored.amazon },
    aliexpress: { ...DEFAULT_MARKETPLACES.aliexpress, ...stored.aliexpress },
  };
}

export function saveMarketplaces(marketplaces) {
  return chrome.storage.local.set({ [MARKETPLACES_KEY]: marketplaces });
}

// One key per account, so concurrent writes never overwrite each other.
const accountKey = (marketplace, domain) => `${ACCOUNT_PREFIX}${marketplace}${domain}`;

export async function loadAccounts() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([key]) => key.startsWith(ACCOUNT_PREFIX))
    .map(([, account]) => account);
}

export async function loadAccount(marketplace, domain) {
  const key = accountKey(marketplace, domain);
  return (await chrome.storage.local.get(key))[key] ?? null;
}

// `account` is a readAccount() result; signed-out marketplaces are forgotten.
// `signedInAt` (when Waybill last saw the user sign in to this account) is
// kept across later checks of the same account; it lets the server restore an
// account the user removed and then signed in to again.
export async function storeAccount(marketplace, domain, account) {
  const key = accountKey(marketplace, domain);
  if (account.status === 'signed-out') return chrome.storage.local.remove(key);
  const previous = await loadAccount(marketplace, domain);
  const sameAccount = previous && (previous.customerId ?? previous.email) === (account.customerId ?? account.email);
  const signedInAt = account.signedInAt ?? (sameAccount ? previous.signedInAt : undefined);
  return chrome.storage.local.set({ [key]: { marketplace, domain, ...account, signedInAt, checkedAt: Date.now() } });
}

// Called when Amazon asks for the password again while reading orders.
export async function markNeedsSignIn(marketplace, domain) {
  const account = await loadAccount(marketplace, domain);
  if (account) await storeAccount(marketplace, domain, { ...account, status: 'needs-sign-in' });
}

// The accounts this profile shares with Waybill: only while signed in to
// Waybill and with Amazon switched on. Background tracking, server
// registration and the Activity page all use this one rule.
export async function isAmazonTracked() {
  return Boolean(await loadSessionName()) && (await loadMarketplaces()).amazon.enabled;
}

export async function loadTrackedAccounts() {
  if (!(await isAmazonTracked())) return [];
  return (await loadAccounts()).filter((account) => account.marketplace === 'amazon');
}

// True when a chrome.storage change can alter loadTrackedAccounts().
export const affectsTrackedAccounts = (changes) =>
  Object.keys(changes).some((key) => key === SESSION_KEY || key === MARKETPLACES_KEY || key.startsWith(ACCOUNT_PREFIX));
