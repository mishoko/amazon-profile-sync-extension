// The only file that touches chrome.storage. Anyone may read; only the
// background writes (its handlers), and writing anywhere else throws.
//
// chrome.storage.local   lasting: the Waybill session, marketplace settings,
//                        this profile's account summaries, the profile's ID.
// chrome.storage.session short-lived but must survive the background being
//                        stopped: server status, every profile's accounts,
//                        sign-ins in progress, last check times.
// Orders are never stored.
const local = chrome.storage.local;
const session = chrome.storage.session;

const SESSION_KEY = 'waybillSession';
const SETTINGS_KEY = 'marketplaces';
const ACCOUNT_PREFIX = 'account:';
const INSTANCE_KEY = 'instanceId';
const SERVER_ONLINE_KEY = 'serverOnline';
const ALL_ACCOUNTS_KEY = 'allAccounts';
const SIGNING_IN_PREFIX = 'signingIn:';
const CHECKED_PREFIX = 'lastChecked:';

const DEFAULT_SETTINGS = {
  amazon: { enabled: false, expanded: false, domain: '.com' },
  aliexpress: { enabled: false },
};

// A site is one marketplace in one country: { marketplace: 'amazon', domain: '.com' }.
export const siteKey = ({ marketplace, domain }) => `${marketplace}${domain}`;

function writable() {
  if (!(typeof ServiceWorkerGlobalScope !== 'undefined' && globalThis instanceof ServiceWorkerGlobalScope)) {
    throw new Error('Only the background writes storage: emit a user: event instead');
  }
}

const read = async (area, key) => (await area.get(key))[key];

// ── Reading ─────────────────────────────────────────────────────────────────
export const sessionName = async () => (await read(local, SESSION_KEY)) ?? null;

export async function settings() {
  const stored = (await read(local, SETTINGS_KEY)) ?? {};
  return Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([id, defaults]) => [id, { ...defaults, ...stored[id] }]));
}

export const account = async (site) => (await read(local, ACCOUNT_PREFIX + siteKey(site))) ?? null;

export async function accounts() {
  return Object.entries(await local.get(null)).filter(([key]) => key.startsWith(ACCOUNT_PREFIX)).map(([, value]) => value);
}

// One rule decides what this profile shares: signed in to Waybill and the
// marketplace switched on. Page watching, checks and the server all use it.
export async function isTracked(marketplace) {
  return Boolean(await sessionName()) && Boolean((await settings())[marketplace]?.enabled);
}

export async function trackedAccounts() {
  const all = await accounts();
  const tracked = await Promise.all(all.map((item) => isTracked(item.marketplace)));
  return all.filter((_, index) => tracked[index]);
}

// What the server receives: summaries only, never orders.
export async function sharedAccounts() {
  return (await trackedAccounts()).map(({ marketplace, domain, customerId = null, name = null, email = null, status, signedInAt = null }) => (
    { marketplace, domain, customerId, name, email, status, signedInAt }));
}

export const instanceId = async () => (await read(local, INSTANCE_KEY)) ?? null;
export const serverOnline = async () => (await read(session, SERVER_ONLINE_KEY)) === true;
export const allAccounts = async () => (await read(session, ALL_ACCOUNTS_KEY)) ?? [];
export const isSigningIn = async (site) => (await read(session, SIGNING_IN_PREFIX + siteKey(site))) === true;
export const lastChecked = async (site) => (await read(session, CHECKED_PREFIX + siteKey(site))) ?? 0;

// Calls listener(changedKeys) after any change, in either area.
export function onChange(listener) {
  const handle = (changes) => listener(new Set(Object.keys(changes)));
  chrome.storage.onChanged.addListener(handle);
  return () => chrome.storage.onChanged.removeListener(handle);
}
export const isSessionChange = (keys) => keys.has(SESSION_KEY);

// ── Writing (background only) ──────────────────────────────────────────────
export function saveSession(name) {
  writable();
  return local.set({ [SESSION_KEY]: name });
}

export function clearSession() {
  writable();
  return local.remove(SESSION_KEY);
}

export function saveSettings(next) {
  writable();
  if (!next || Object.keys(next).some((id) => !(id in DEFAULT_SETTINGS))) throw new Error(`Unknown marketplace settings: ${JSON.stringify(next)}`);
  return local.set({ [SETTINGS_KEY]: next });
}

// `signedInAt` (when Waybill last saw the user sign in to this account) is
// kept across later checks of the same account; it lets the server restore
// an account the user removed and then signed in to again.
export async function saveAccount(site, next) {
  writable();
  const previous = await account(site);
  const sameAccount = previous && (previous.customerId ?? previous.email) === (next.customerId ?? next.email);
  const signedInAt = next.signedInAt ?? (sameAccount ? previous.signedInAt : undefined);
  return local.set({ [ACCOUNT_PREFIX + siteKey(site)]: { ...site, ...next, signedInAt, checkedAt: Date.now() } });
}

export function forgetAccount(site) {
  writable();
  return local.remove(ACCOUNT_PREFIX + siteKey(site));
}

// A random ID for this browser profile, created once.
export async function ensureInstanceId() {
  writable();
  const existing = await instanceId();
  if (existing) return existing;
  const created = crypto.randomUUID();
  await local.set({ [INSTANCE_KEY]: created });
  return created;
}

export function setServerOnline() {
  writable();
  return session.set({ [SERVER_ONLINE_KEY]: true });
}

export function setServerOffline() {
  writable();
  return Promise.all([session.set({ [SERVER_ONLINE_KEY]: false }), session.remove(ALL_ACCOUNTS_KEY)]);
}

export function saveAllAccounts(list) {
  writable();
  if (!Array.isArray(list)) throw new Error('saveAllAccounts needs a list');
  return session.set({ [ALL_ACCOUNTS_KEY]: list });
}

export function setSigningIn(site, signingIn) {
  writable();
  const key = SIGNING_IN_PREFIX + siteKey(site);
  return signingIn ? session.set({ [key]: true }) : session.remove(key);
}

export function setLastChecked(site, time) {
  writable();
  return session.set({ [CHECKED_PREFIX + siteKey(site)]: time });
}
