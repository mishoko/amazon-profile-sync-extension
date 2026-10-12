// Every marketplace Waybill reads. Adding one: a folder like amazon/ whose
// main module exports the six things below, and one line in this list.
//
//   id, name      'amazon', 'Amazon'
//   sites         [{ domain, host }]: one entry per country site
//   pageKind(url) 'sign-in' | 'sign-out' | 'other' for a page the user loads
//   checkAccount(site, known) → { event: 'site:account-found' | 'site:account-gone'
//                                 | 'site:needs-sign-in' | 'site:unreachable', data }
//   readOrders(site, filter)  → { event: 'site:orders-read' | 'site:needs-sign-in'
//                                 | 'site:unreachable', data }
//
// Pages are read with background/page-tools.js. The background loads this
// list at start and refuses to start if an integration is incomplete.
import * as amazon from './amazon/amazon.js';

export const INTEGRATIONS = [amazon];

const EXPORTS = { id: 'string', name: 'string', sites: 'object', pageKind: 'function', checkAccount: 'function', readOrders: 'function' };
export const PAGE_KINDS = ['sign-in', 'sign-out', 'other'];

for (const integration of INTEGRATIONS) {
  for (const [key, type] of Object.entries(EXPORTS)) {
    if (typeof integration[key] !== type) throw new Error(`Integration "${integration.id ?? '?'}" must export ${key} (${type})`);
  }
  if (!integration.sites.length || integration.sites.some((site) => !site.domain || !site.host)) {
    throw new Error(`Integration "${integration.id}" must list its sites as { domain, host }`);
  }
}

export function integrationFor({ marketplace }) {
  const integration = INTEGRATIONS.find((candidate) => candidate.id === marketplace);
  if (!integration) throw new Error(`No integration for "${marketplace}"`);
  return integration;
}

// The integration and site a URL belongs to, or null for any other website.
export function findSite(url) {
  for (const integration of INTEGRATIONS) {
    const site = integration.sites.find(({ host }) => host === url.hostname);
    if (site) return { integration, site: { marketplace: integration.id, domain: site.domain } };
  }
  return null;
}
