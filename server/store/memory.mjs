// In-memory store: used when DATABASE_URL isn't set (running the server
// directly with Node) and by the unit tests. Same contract as postgres.mjs:
//
//   touchProfile(profileId)                     the profile connected
//   replaceProfileAccounts(profileId, accounts) the profile's full current list
//   listAccounts()                              accounts with their holders
//   getAccount(id)                              one account, or null
//   close()
//
// Accounts: { id, marketplace, domain, customerId, name, email,
//             holders: [{ profileId, status }] }
import { findAccountMatch } from './matching.mjs';

export function createMemoryStore() {
  const profiles = new Map(); // profileId -> { lastSeenAt }
  const accounts = []; // { id, marketplace, domain, customerId, name, email }
  const holdings = new Map(); // profileId -> Map(accountId -> status)
  let nextId = 1;

  const withHolders = (account) => ({
    ...account,
    holders: [...holdings].flatMap(([profileId, held]) => (held.has(account.id) ? [{ profileId, status: held.get(account.id) }] : [])),
  });

  function upsertAccount(summary) {
    const existing = findAccountMatch(accounts, summary);
    if (existing) {
      existing.customerId ??= summary.customerId;
      if (summary.name) existing.name = summary.name;
      if (summary.email) existing.email = summary.email;
      return existing;
    }
    const account = { id: nextId++, marketplace: summary.marketplace, domain: summary.domain, customerId: summary.customerId, name: summary.name, email: summary.email };
    accounts.push(account);
    return account;
  }

  return {
    async touchProfile(profileId) {
      profiles.set(profileId, { lastSeenAt: new Date() });
    },
    async replaceProfileAccounts(profileId, summaries) {
      holdings.set(profileId, new Map(summaries.map((summary) => [upsertAccount(summary).id, summary.status])));
    },
    async listAccounts() {
      return accounts.map(withHolders).filter((account) => account.holders.length);
    },
    async getAccount(id) {
      const account = accounts.find((candidate) => candidate.id === id);
      return account ? withHolders(account) : null;
    },
    async close() {},
  };
}
