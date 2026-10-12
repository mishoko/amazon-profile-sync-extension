// Marketplace cards in the signed-in popup. The switches, the open card and
// the chosen Amazon marketplace are settings in storage; every change is a
// user: event, and the cards redraw from storage. While Amazon is on, the
// chosen marketplace's sign-in is checked when the popup opens and when the
// choice changes; the last known result shows at once.
import { createStore } from '../shared/store.js';
import { emit } from '../../core/bus.js';
import * as state from '../../core/state.js';
import { ordersUrl } from '../../integrations/amazon/urls.js';
import { showError } from '../shared/errors.js';

const initialState = {
  settings: null,
  account: null, // the stored account of the chosen Amazon marketplace
  // The check this popup started: { domain, status: 'idle' | 'checking' | 'failed', reason }
  check: { domain: null, status: 'idle', reason: null },
};

function reducer(current, action) {
  switch (action.type) {
    case 'stored':
      return { ...current, settings: action.settings, account: action.account };
    case 'settings-changed':
      return { ...current, settings: action.settings };
    case 'check-started':
      return { ...current, check: { domain: action.domain, status: 'checking', reason: null } };
    case 'check-finished':
      // A late answer for a marketplace that is no longer chosen is ignored.
      if (action.domain !== current.check.domain) return current;
      return { ...current, check: { domain: action.domain, status: action.reason ? 'failed' : 'idle', reason: action.reason } };
    default:
      throw new Error(`Unknown popup action ${action.type}`);
  }
}

const CONNECTION_LABELS = { active: 'Active', 'needs-sign-in': 'Inactive', unknown: 'Inactive', error: 'Inactive' };

function render(root, { settings, account, check }) {
  for (const card of root.querySelectorAll('[data-marketplace]')) {
    const marketplace = settings[card.dataset.marketplace];
    card.querySelector('.switch').setAttribute('aria-checked', String(marketplace.enabled));
    const details = card.querySelector('.card-details');
    if (!details) continue; // AliExpress: its expanded view was never observed.
    const chevron = card.querySelector('.chevron');
    chevron.setAttribute('aria-disabled', String(!marketplace.enabled));
    chevron.setAttribute('aria-expanded', String(marketplace.expanded));
    details.hidden = !marketplace.expanded;
  }

  const { domain } = settings.amazon;
  const ours = check.domain === domain;
  const status = ours && check.status === 'failed' ? 'error' : account?.status ?? 'unknown';
  const checking = ours && check.status === 'checking';
  root.querySelector('#amazon-marketplace').value = domain;

  const logIn = root.querySelector('[data-amazon-log-in]');
  const url = new URL(ordersUrl(domain));
  url.searchParams.set('orderFilter', 'last30');
  logIn.href = url.href;
  logIn.hidden = status === 'active';

  const identity = root.querySelector('[data-amazon-identity]');
  identity.textContent = account?.email ?? account?.name ?? '';
  identity.hidden = status !== 'active';

  const pill = root.querySelector('[data-amazon-connection]');
  pill.dataset.status = checking && status === 'unknown' ? 'checking' : status;
  pill.textContent = checking && status === 'unknown' ? 'Checking…' : CONNECTION_LABELS[status];
  pill.title = status === 'needs-sign-in' ? 'Amazon wants your password again. Use "Log in".'
    : status === 'error' ? `Could not reach Amazon (${check.reason}).` : '';
  root.querySelector('[data-amazon-connection-row]').setAttribute('aria-busy', String(checking));
}

export async function mountMarketplaces(root) {
  const store = createStore(reducer, initialState);
  store.subscribe((current) => render(root, current));

  const amazonSite = () => ({ marketplace: 'amazon', domain: store.getState().settings.amazon.domain });

  async function load() {
    const settings = await state.settings();
    store.dispatch({ type: 'stored', settings, account: await state.account({ marketplace: 'amazon', domain: settings.amazon.domain }) });
  }

  // Runs a user: event that checks the chosen Amazon marketplace.
  async function checking(name, data) {
    const { domain } = data.site;
    const shows = store.getState().settings.amazon.enabled;
    if (shows) store.dispatch({ type: 'check-started', domain });
    try {
      const reached = await emit(name, data);
      if (shows) store.dispatch({ type: 'check-finished', domain, reason: reached['site:unreachable']?.reason ?? null });
    } catch (error) {
      if (shows) store.dispatch({ type: 'check-finished', domain, reason: error.message });
      throw error;
    }
  }

  // Shows the new settings at once; storage confirms them.
  function change(settings) {
    store.dispatch({ type: 'settings-changed', settings });
    return settings;
  }

  root.addEventListener('click', (event) => {
    const { settings } = store.getState();
    const toggle = event.target.closest('.switch');
    if (toggle) {
      const id = toggle.closest('[data-marketplace]').dataset.marketplace;
      const enabled = !settings[id].enabled;
      const next = change({ ...settings, [id]: { ...settings[id], enabled, ...('expanded' in settings[id] && { expanded: enabled && settings[id].expanded }) } });
      // Only Amazon has an integration; the AliExpress switch is a setting only.
      const work = id !== 'amazon' ? emit('user:changed-settings', { settings: next })
        : enabled ? checking('user:turned-on', { settings: next, site: amazonSite() })
        : emit('user:turned-off', { settings: next });
      work.catch(showError);
      return;
    }
    if (event.target.closest('.chevron:not([aria-disabled="true"])')) {
      const next = change({ ...settings, amazon: { ...settings.amazon, expanded: !settings.amazon.expanded } });
      emit('user:changed-settings', { settings: next }).catch(showError);
    }
  });

  root.querySelector('#amazon-marketplace').addEventListener('change', (event) => {
    const { settings } = store.getState();
    const next = change({ ...settings, amazon: { ...settings.amazon, domain: event.target.value } });
    store.dispatch({ type: 'stored', settings: next, account: null });
    state.account(amazonSite()).then((account) => {
      if (store.getState().settings.amazon.domain === next.amazon.domain) store.dispatch({ type: 'stored', settings: store.getState().settings, account });
    }).catch(showError);
    checking('user:selected-region', { settings: next, site: amazonSite() }).catch(showError);
  });

  state.onChange(() => load().catch(showError));

  await load();
  render(root, store.getState());
  requestAnimationFrame(() => { root.querySelector('.marketplaces').dataset.ready = ''; });
  await checking('user:opened-popup', { site: amazonSite() });
}
