// The server's work: one function per server: and db: event in
// core/events.js. Events with oneOf return { event, data }; the others may
// return data to add to the chain. `profile` in the data is always the
// connected profile the event came from (set by server.mjs, never trusted
// from the message).
const STATUSES = new Set(['active', 'needs-sign-in']);
const STATUS_RANK = { active: 2, 'needs-sign-in': 1 };
const FILTER = /^[a-z0-9-]{1,20}$/;

// The only events a browser profile may send; anything else is refused.
export const FROM_PROFILES = new Set(['db:replace-profile-accounts', 'db:remove-account', 'server:find-profile']);

const text = (value, max = 200) => (typeof value === 'string' && value.length <= max ? value : null);

// Keeps only the fields Waybill shares; null for anything malformed.
export function accountSummary(raw) {
  const account = {
    marketplace: text(raw?.marketplace, 20),
    domain: text(raw?.domain, 20),
    customerId: text(raw?.customerId, 40),
    name: text(raw?.name),
    email: text(raw?.email),
    status: STATUSES.has(raw?.status) ? raw.status : null,
    // When this profile last saw the user sign in to the account (ms).
    signedInAt: Number.isFinite(raw?.signedInAt) && raw.signedInAt <= Date.now() + 60_000 ? raw.signedInAt : null,
  };
  const valid = account.marketplace === 'amazon' && /^\.[a-z.]+$/.test(account.domain ?? '')
    && account.status && (account.customerId || account.email);
  return valid ? account : null;
}

function accountId(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid account ID ${JSON.stringify(value)}`);
  return value;
}

export function createHandlers({ store, isConnected }) {
  // One profile's store writes run in order, across reconnects (a release
  // can't overtake a new connection's report).
  const writes = new Map();
  const inOrder = (profile, write) => {
    const next = (writes.get(profile) ?? Promise.resolve()).catch(() => {}).then(write);
    writes.set(profile, next);
    return next.then(() => undefined);
  };

  // Stored accounts with the connected profiles holding them. The account's
  // status is the best status among those profiles.
  const withConnections = ({ holders, ...account }) => {
    const profiles = holders.filter(({ profileId }) => isConnected(profileId)).map(({ profileId, status }) => ({ instanceId: profileId, status }));
    const best = profiles.reduce((top, profile) => (STATUS_RANK[profile.status] > STATUS_RANK[top] ? profile.status : top), 'needs-sign-in');
    return { ...account, status: best, profiles };
  };

  const handlers = {
    'db:record-profile': ({ profile }) => inOrder(profile, () => store.touchProfile(profile)),
    'db:release-profile': ({ profile }) => inOrder(profile, () => store.releaseProfile(profile)),

    'db:replace-profile-accounts': ({ profile, accounts }) => {
      if (!Array.isArray(accounts)) throw new Error('accounts must be a list');
      const valid = accounts.map(accountSummary).filter(Boolean);
      if (valid.length !== accounts.length) console.warn(`Waybill: refused ${accounts.length - valid.length} malformed account(s) from profile ${profile}`);
      return inOrder(profile, () => store.replaceProfileAccounts(profile, valid));
    },

    // Accounts held by at least one connected profile, to every profile.
    'server:send-all-accounts': async () => ({
      accounts: (await store.listAccounts()).map(withConnections).filter((account) => account.profiles.length),
      to: 'all',
    }),

    'db:remove-account': async ({ accountId: id }) => (
      (await store.deleteAccount(accountId(id))) ? { event: 'db:account-removed' } : { event: 'db:account-not-found' }),

    // The connected profile with the best status reads the orders.
    'server:find-profile': async ({ accountId: id, filter = null }) => {
      if (filter !== null && !FILTER.test(filter)) throw new Error(`Invalid filter ${JSON.stringify(filter)}`);
      const account = await store.getAccount(accountId(id));
      if (!account) return { event: 'db:account-not-found' };
      const holder = withConnections(account).profiles.sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status])[0];
      if (!holder) return { event: 'server:account-offline' };
      return {
        event: 'site:read-orders',
        data: { site: { marketplace: account.marketplace, domain: account.domain }, filter, to: holder.instanceId, servedBy: holder.instanceId },
      };
    },
  };
  return { handlers, settled: () => Promise.all(writes.values()).catch(() => {}) };
}
