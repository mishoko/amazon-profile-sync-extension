// Notices marketplace sign-ins and sign-outs while the user browses, only for
// marketplaces the user switched on while signed in to Waybill. Each
// integration says what a page is (pageKind); this file turns that into
// events:
//   a sign-out page opens             → site:signed-out, at once, no request
//   a page loads after sign-in pages  → site:signed-in
//   any other page loads              → site:visited, at most every CONFIG.recheckAfterMs
// "Signing in" and the last check time live in session storage, because
// Chrome may stop the background while the user types a password or a code.
import { CONFIG } from '../core/config.js';
import { emit } from '../core/bus.js';
import * as state from '../core/state.js';
import { findSite, PAGE_KINDS } from '../integrations/index.js';

// Short delays before a check, per site. Lost if the background stops; the
// next page load starts them again.
const pending = new Map();

const fail = (error) => console.error('[waybill] page watcher:', error);

async function notice(url, change) {
  const found = findSite(url);
  if (!found) return;
  const { integration, site } = found;
  if (!(await state.isTracked(site.marketplace))) return;
  const kind = integration.pageKind(url);
  if (!PAGE_KINDS.includes(kind)) throw new Error(`${integration.id}.pageKind returned "${kind}"`);
  const key = state.siteKey(site);

  if (change.url && kind === 'sign-out') {
    clearTimeout(pending.get(key));
    pending.delete(key);
    await state.setSigningIn(site, false);
    await emit('site:signed-out', { site });
    return;
  }
  if (change.status !== 'complete' || kind === 'sign-out') return;
  if (kind === 'sign-in') {
    await state.setSigningIn(site, true);
    return;
  }
  if (!(await state.isSigningIn(site)) && Date.now() - (await state.lastChecked(site)) < CONFIG.recheckAfterMs) return;
  clearTimeout(pending.get(key));
  pending.set(key, setTimeout(() => {
    pending.delete(key);
    check(site).catch(fail);
  }, CONFIG.checkDelayMs));
}

async function check(site) {
  const afterSignIn = await state.isSigningIn(site);
  await state.setSigningIn(site, false);
  await state.setLastChecked(site, Date.now());
  await emit(afterSignIn ? 'site:signed-in' : 'site:visited', { site, afterSignIn });
}

// Host permissions make tab URLs visible for marketplace pages only.
export function watchPages() {
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    if ((change.url || change.status === 'complete') && tab.url) notice(new URL(change.url ?? tab.url), change).catch(fail);
  });
}
