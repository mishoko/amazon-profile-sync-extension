// Marketplace cards in the signed-in popup. Switch, expansion and selected
// Amazon marketplace persist in chrome.storage.local. While Amazon is on, the
// selected marketplace's sign-in is checked each time the popup opens or the
// selection changes; the last result is shown immediately from storage.
import { createStore } from '../lib/store.js';
import { loadMarketplaces, saveMarketplaces, loadAccount, storeAccount } from '../lib/storage.js';
import { readAccount, ordersUrl } from '../lib/amazon.js';

const initialState = {
  amazon: { enabled: false, expanded: false, domain: '.com' },
  aliexpress: { enabled: false },
  // Connection of the selected Amazon marketplace.
  // status: 'unknown' | 'active' | 'needs-sign-in' | 'signed-out' | 'error'
  connection: { domain: '.com', status: 'unknown', email: null, name: null, checking: false },
};

const connectionFrom = (domain, account) => ({
  domain,
  status: account?.status ?? 'unknown',
  email: account?.email ?? null,
  name: account?.name ?? null,
  checking: false,
});

function reducer(state, action) {
  switch (action.type) {
    case 'loaded':
      return { ...state, ...action.marketplaces, connection: connectionFrom(action.marketplaces.amazon.domain, action.account) };
    case 'switch-toggled': {
      const marketplace = state[action.marketplace];
      const enabled = !marketplace.enabled;
      return { ...state, [action.marketplace]: { ...marketplace, enabled, ...('expanded' in marketplace && { expanded: enabled && marketplace.expanded }) } };
    }
    case 'expansion-toggled':
      if (!state.amazon.enabled) return state;
      return { ...state, amazon: { ...state.amazon, expanded: !state.amazon.expanded } };
    case 'domain-selected':
      return { ...state, amazon: { ...state.amazon, domain: action.domain }, connection: connectionFrom(action.domain, null) };
    case 'stored-account-loaded':
      if (action.domain !== state.connection.domain || state.connection.status !== 'unknown') return state;
      return { ...state, connection: { ...connectionFrom(action.domain, action.account), checking: state.connection.checking } };
    case 'check-started':
      if (action.domain !== state.connection.domain) return state;
      return { ...state, connection: { ...state.connection, checking: true } };
    case 'check-finished':
      // A late answer for a marketplace that is no longer selected is ignored.
      if (action.domain !== state.connection.domain) return state;
      return { ...state, connection: connectionFrom(action.domain, action.account) };
    case 'check-failed':
      if (action.domain !== state.connection.domain) return state;
      return { ...state, connection: { ...state.connection, status: 'error', checking: false } };
    default:
      return state;
  }
}

const persisted = ({ amazon, aliexpress }) => ({ amazon, aliexpress });

async function checkConnection(store) {
  const { amazon: { enabled, domain } } = store.getState();
  if (!enabled) return;
  store.dispatch({ type: 'check-started', domain });
  try {
    const account = await readAccount(domain, await loadAccount('amazon', domain));
    await storeAccount('amazon', domain, account);
    store.dispatch({ type: 'check-finished', domain, account });
  } catch (error) {
    store.dispatch({ type: 'check-failed', domain, error: error.message });
  }
}

const CONNECTION_LABELS = { active: 'Active', 'needs-sign-in': 'Inactive', 'signed-out': 'Inactive', unknown: 'Inactive', error: 'Inactive' };

function render(root, state) {
  for (const card of root.querySelectorAll('[data-marketplace]')) {
    const marketplace = state[card.dataset.marketplace];
    card.querySelector('.switch').setAttribute('aria-checked', String(marketplace.enabled));
    const chevron = card.querySelector('.chevron');
    const details = card.querySelector('.card-details');
    if (!details) continue; // AliExpress: its expanded view was never observed.
    chevron.setAttribute('aria-disabled', String(!marketplace.enabled));
    chevron.setAttribute('aria-expanded', String(marketplace.expanded));
    details.hidden = !marketplace.expanded;
  }

  const { domain } = state.amazon;
  const { status, email, name, checking } = state.connection;
  root.querySelector('#amazon-marketplace').value = domain;

  const logIn = root.querySelector('[data-amazon-log-in]');
  const url = new URL(ordersUrl(domain));
  url.searchParams.set('orderFilter', 'last30');
  logIn.href = url.href;
  logIn.hidden = status === 'active';

  const identity = root.querySelector('[data-amazon-identity]');
  identity.textContent = email ?? name ?? '';
  identity.hidden = status !== 'active';

  const pill = root.querySelector('[data-amazon-connection]');
  pill.dataset.status = checking && status === 'unknown' ? 'checking' : status;
  pill.textContent = checking && status === 'unknown' ? 'Checking…' : CONNECTION_LABELS[status];
  pill.title = status === 'needs-sign-in' ? 'Amazon wants your password again. Use "Log in".'
    : status === 'error' ? 'Could not reach Amazon.' : '';
  root.querySelector('[data-amazon-connection-row]').setAttribute('aria-busy', String(checking));
}

export async function mountMarketplaces(root) {
  const store = createStore(reducer, initialState);
  store.subscribe((state) => render(root, state));

  root.addEventListener('click', (event) => {
    const toggle = event.target.closest('.switch');
    if (toggle) {
      store.dispatch({ type: 'switch-toggled', marketplace: toggle.closest('[data-marketplace]').dataset.marketplace });
      saveMarketplaces(persisted(store.getState()));
      checkConnection(store);
      return;
    }
    if (event.target.closest('.chevron:not([aria-disabled="true"])')) {
      store.dispatch({ type: 'expansion-toggled' });
      saveMarketplaces(persisted(store.getState()));
    }
  });

  root.querySelector('#amazon-marketplace').addEventListener('change', (event) => {
    const domain = event.target.value;
    store.dispatch({ type: 'domain-selected', domain });
    saveMarketplaces(persisted(store.getState()));
    loadAccount('amazon', domain).then((account) => store.dispatch({ type: 'stored-account-loaded', domain, account }));
    checkConnection(store);
  });

  const marketplaces = await loadMarketplaces();
  store.dispatch({ type: 'loaded', marketplaces, account: await loadAccount('amazon', marketplaces.amazon.domain) });
  render(root, store.getState());
  requestAnimationFrame(() => { root.querySelector('.marketplaces').dataset.ready = ''; });
  checkConnection(store);
}
