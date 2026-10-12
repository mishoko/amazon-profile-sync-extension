// The background's work: one function per event in core/events.js that does
// something here. Events with oneOf return { event, data }; the others may
// return data to add to the chain.
import * as state from '../core/state.js';
import { integrationFor } from '../integrations/index.js';

export const HANDLERS = {
  'storage:save-session': ({ name }) => state.saveSession(name),
  'storage:clear-session': () => state.clearSession(),
  'storage:save-settings': ({ settings }) => state.saveSettings(settings),
  'storage:save-account': ({ site, account }) => state.saveAccount(site, account),
  'storage:forget-account': ({ site }) => state.forgetAccount(site),
  'storage:read-shared-accounts': async () => ({ accounts: await state.sharedAccounts() }),
  'storage:save-all-accounts': ({ accounts }) => state.saveAllAccounts(accounts),

  // From a check, Amazon showed the email it wants the password for; from
  // reading orders, it only asked for the password again.
  async 'storage:mark-needs-sign-in'({ site, email }) {
    if (email) return state.saveAccount(site, { status: 'needs-sign-in', email });
    const known = await state.account(site);
    if (known) await state.saveAccount(site, { ...known, status: 'needs-sign-in' });
  },

  // `afterSignIn`: the user just finished signing in on this site.
  async 'site:check-account'({ site, afterSignIn = false }) {
    if (!(await state.isTracked(site.marketplace))) return { event: 'site:not-tracked' };
    const outcome = await integrationFor(site).checkAccount(site, await state.account(site));
    if (outcome.event === 'site:account-found' && afterSignIn) outcome.data.account.signedInAt = Date.now();
    return outcome;
  },

  'site:read-orders': ({ site, filter = null }) => integrationFor(site).readOrders(site, filter),

  // With the server, it finds the profile signed in to the account (maybe
  // this one); without it, this profile reads its own account.
  async 'user:requested-orders'({ account, filter = null }) {
    if (account.id && await state.serverOnline()) return { event: 'server:find-profile', data: { accountId: account.id, filter } };
    return { event: 'site:read-orders', data: { site: { marketplace: account.marketplace, domain: account.domain }, filter, servedBy: await state.instanceId() } };
  },
};
