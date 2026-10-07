// Persisted extension state in chrome.storage.local, shared by the popup and
// the Activity page. Only this profile's Amazon account summaries (marketplace,
// customer ID, name, email, status) are stored; orders are never stored.

const MARKETPLACES_KEY = 'marketplaces';
const ACCOUNT_PREFIX = 'account:';

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
export function storeAccount(marketplace, domain, account) {
  const key = accountKey(marketplace, domain);
  if (account.status === 'signed-out') return chrome.storage.local.remove(key);
  return chrome.storage.local.set({ [key]: { marketplace, domain, ...account, checkedAt: Date.now() } });
}
