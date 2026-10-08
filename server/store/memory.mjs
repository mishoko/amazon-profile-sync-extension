// In-memory store: used when DATABASE_URL isn't set (running the server
// directly with Node) and by the unit tests. Same contract as postgres.mjs:
//
//   touchProfile(profileId)                     the profile connected
//   replaceProfileAccounts(profileId, accounts) the profile's full current list
//   listAccounts()                              accounts with their holders
//   getAccount(id)                              one account, or null
//   deleteAccount(id)                           hide it (soft delete); false if unknown
//   releaseProfile(profileId)                   the profile disconnected: drop its holdings
//   releaseAllProfiles()                        nobody is connected (server start)
//   pruneProfiles(unseenDays)                   delete profiles unseen that long; returns count
//   close()
//
// Holdings (which profile holds which account) reflect connected profiles
// only, so they can never go stale.
//
// A deleted account is hidden from listAccounts/getAccount until a profile
// reports it with signedInAt (ms) later than the deletion.
//
// Accounts: { id, marketplace, domain, customerId, name, email,
//             holders: [{ profileId, status }] }
import { findAccountMatch } from './matching.mjs';

export function createMemoryStore() {
  const profiles = new Map(); // profileId -> { lastSeenAt }
  const accounts = []; // { id, marketplace, domain, customerId, name, email, deletedAt }
  const holdings = new Map(); // profileId -> Map(accountId -> status)
  let nextId = 1;

  const withHolders = ({ deletedAt, ...account }) => ({
    ...account,
    holders: [...holdings].flatMap(([profileId, held]) => (held.has(account.id) ? [{ profileId, status: held.get(account.id) }] : [])),
  });

  function upsertAccount(summary) {
    const existing = findAccountMatch(accounts, summary);
    if (existing) {
      existing.customerId ??= summary.customerId;
      if (summary.name) existing.name = summary.name;
      if (summary.email) existing.email = summary.email;
      if (existing.deletedAt && summary.signedInAt > existing.deletedAt.getTime()) existing.deletedAt = null;
      return existing;
    }
    const account = { id: nextId++, marketplace: summary.marketplace, domain: summary.domain, customerId: summary.customerId, name: summary.name, email: summary.email, deletedAt: null };
    accounts.push(account);
    return account;
  }

  return {
    async touchProfile(profileId) {
      profiles.set(profileId, { lastSeenAt: new Date() });
    },
    async replaceProfileAccounts(profileId, summaries) {
      profiles.set(profileId, { lastSeenAt: new Date() });
      holdings.set(profileId, new Map(summaries.map((summary) => [upsertAccount(summary).id, summary.status])));
    },
    async listAccounts() {
      return accounts.filter((account) => !account.deletedAt).map(withHolders).filter((account) => account.holders.length);
    },
    async getAccount(id) {
      const account = accounts.find((candidate) => candidate.id === id && !candidate.deletedAt);
      return account ? withHolders(account) : null;
    },
    async releaseProfile(profileId) {
      holdings.delete(profileId);
      profiles.set(profileId, { lastSeenAt: new Date() });
    },
    async releaseAllProfiles() {
      holdings.clear();
    },
    async pruneProfiles(unseenDays) {
      const cutoff = Date.now() - unseenDays * 86_400_000;
      let pruned = 0;
      for (const [profileId, { lastSeenAt }] of profiles) {
        if (lastSeenAt.getTime() < cutoff && !holdings.has(profileId)) {
          profiles.delete(profileId);
          pruned += 1;
        }
      }
      return pruned;
    },
    async deleteAccount(id) {
      const account = accounts.find((candidate) => candidate.id === id && !candidate.deletedAt);
      if (!account) return false;
      account.deletedAt = new Date();
      return true;
    },
    async close() {},
  };
}
