// Activity page: lists marketplace accounts and, only when one is selected,
// reads that account's orders live. Orders are kept in page memory only.
//
// Like every view, it only emits user: events and draws what storage holds.
// While the local server is connected, the background keeps every browser
// profile's accounts in storage and a selected account's orders are read by
// the profile signed in to it; without the server, the list is this
// profile's own accounts and this profile reads them.
import { createStore } from '../shared/store.js';
import { emit } from '../../core/bus.js';
import * as state from '../../core/state.js';
import { ordersUrl, orderDetailsUrl } from '../../integrations/amazon/urls.js';
import { showError } from '../shared/errors.js';

// Accounts share one shape:
// { key, id?, marketplace, domain, customerId, name, email, status, profiles: [{ instanceId, status }] }
// `profiles` are the connected browser profiles holding the account.
// `id` is the server's lasting account ID; it exists only with the server.
async function loadAccounts() {
  const instanceId = await state.instanceId();
  if (await state.serverOnline()) {
    const accounts = (await state.allAccounts()).map((account) => ({ ...account, key: `id:${account.id}` }));
    return { scope: 'all-profiles', instanceId, accounts };
  }
  const accounts = (await state.trackedAccounts())
    .map((account) => ({ ...account, key: `${account.marketplace}${account.domain}`, profiles: [{ instanceId, status: account.status }] }))
    .sort((a, b) => a.domain.localeCompare(b.domain));
  return { scope: 'this-profile', instanceId, accounts };
}

const initialState = {
  scope: null,
  instanceId: null,
  accounts: { status: 'loading', items: [] },
  selectedKey: null,
  // Removing an account (server only): { key, status: 'confirming' | 'removing' | 'failed', error }
  removal: null,
  // Per account key: { requestId, status: 'loading' | 'loaded' | 'needs-sign-in' | 'error',
  //                    filter, filters, orders, error }
  orders: {},
};

function reducer(state, action) {
  switch (action.type) {
    case 'accounts-loaded': {
      const present = (key) => action.accounts.some((account) => account.key === key);
      return {
        ...state,
        scope: action.scope,
        instanceId: action.instanceId,
        accounts: { status: 'ready', items: action.accounts },
        // An account that left the list (removed, signed out) is no longer selected.
        selectedKey: present(state.selectedKey) ? state.selectedKey : null,
        removal: state.removal && present(state.removal.key) && action.scope === 'all-profiles' ? state.removal : null,
      };
    }
    case 'removal-asked':
      return { ...state, removal: { key: action.key, status: 'confirming', error: null } };
    case 'removal-cancelled':
      return { ...state, removal: null };
    case 'removal-started':
      return { ...state, removal: { key: action.key, status: 'removing', error: null } };
    case 'removal-failed':
      if (state.removal?.key !== action.key) return state;
      return { ...state, removal: { key: action.key, status: 'failed', error: action.error } };
    case 'account-selected':
      return { ...state, selectedKey: action.key };
    case 'orders-requested': {
      const previous = state.orders[action.key];
      return {
        ...state,
        orders: {
          ...state.orders,
          [action.key]: { filters: [], orders: [], ...previous, status: 'loading', requestId: action.requestId, filter: action.filter ?? previous?.filter ?? null, error: null },
        },
      };
    }
    case 'orders-received': {
      const current = state.orders[action.key];
      // Only the latest request for an account may update it.
      if (current?.requestId !== action.requestId) return state;
      const { result } = action;
      const next = result.status === 'needs-sign-in'
        ? { ...current, status: 'needs-sign-in', orders: [] }
        : { ...current, status: 'loaded', filter: result.filter, filters: result.filters.length ? result.filters : current.filters, orders: result.orders, source: result.source, servedBy: result.servedBy };
      return { ...state, orders: { ...state.orders, [action.key]: next } };
    }
    case 'orders-failed': {
      const current = state.orders[action.key];
      if (current?.requestId !== action.requestId) return state;
      return { ...state, orders: { ...state.orders, [action.key]: { ...current, status: 'error', error: action.error } } };
    }
    default:
      return state;
  }
}

const store = createStore(reducer, initialState);
let nextRequestId = 1;

// What a user:requested-orders chain ended in, as this page shows it.
function ordersOutcome(reached) {
  const read = reached['site:orders-read'];
  if (read) return { result: { status: 'active', ...read.result, servedBy: read.servedBy } };
  if (reached['site:needs-sign-in']) return { result: { status: 'needs-sign-in' } };
  if (reached['site:unreachable']) return { error: reached['site:unreachable'].reason };
  if (reached['server:account-offline']) return { error: 'No connected browser profile has this account signed in.' };
  if (reached['db:account-not-found']) return { error: 'Waybill no longer has this account.' };
  if (reached['server:offline']) return { error: "The Waybill server can't be reached." };
  throw new Error(`Orders request ended without an answer: ${Object.keys(reached).join(', ')}`);
}

async function loadOrders(key, filter = null) {
  const { id, marketplace, domain } = store.getState().accounts.items.find((item) => item.key === key);
  const requestId = nextRequestId++;
  store.dispatch({ type: 'orders-requested', key, requestId, filter });
  try {
    const { result, error } = ordersOutcome(await emit('user:requested-orders', { account: { id, marketplace, domain }, filter }));
    if (error) store.dispatch({ type: 'orders-failed', key, requestId, error });
    else store.dispatch({ type: 'orders-received', key, requestId, result });
  } catch (error) {
    console.error('[waybill]', error);
    store.dispatch({ type: 'orders-failed', key, requestId, error: error.message });
  }
}

// The selected account's server ID is kept in the address, like
// activity.html?type=amazon&id=3, so the link reopens the same account.
function showAccountInAddress(account) {
  const url = new URL(location.href);
  if (account?.id) {
    url.searchParams.set('type', account.marketplace);
    url.searchParams.set('id', String(account.id));
  } else {
    url.searchParams.delete('type');
    url.searchParams.delete('id');
  }
  history.replaceState(null, '', url);
}

function selectAccount(key) {
  store.dispatch({ type: 'account-selected', key });
  showAccountInAddress(store.getState().accounts.items.find((account) => account.key === key));
  const entry = store.getState().orders[key];
  if (!entry || entry.status === 'error' || entry.status === 'needs-sign-in') loadOrders(key);
}

// Builds DOM nodes; text is always set as text, never parsed as HTML.
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (name === 'text') node.textContent = value;
    else if (name === 'on') for (const [type, handler] of Object.entries(value)) node.addEventListener(type, handler);
    else node.setAttribute(name, value === true ? '' : value);
  }
  node.append(...children.flat(Infinity).filter(Boolean));
  return node;
}

const STATUS_LABELS = { active: 'Active', 'needs-sign-in': 'Sign in again' };

const profileLabel = (account, instanceId) =>
  (account.profiles.some((profile) => profile.instanceId === instanceId) ? 'This browser profile' : 'Another browser profile');

async function confirmRemoval(account) {
  store.dispatch({ type: 'removal-started', key: account.key });
  try {
    const reached = await emit('user:removed-account', { accountId: account.id });
    // Removed: the server then sends every profile the list without it.
    if (reached['db:account-removed']) return;
    store.dispatch({ type: 'removal-failed', key: account.key, error: reached['server:offline'] ? "the Waybill server can't be reached" : 'Waybill no longer has this account' });
  } catch (error) {
    console.error('[waybill]', error);
    store.dispatch({ type: 'removal-failed', key: account.key, error: error.message });
  }
}

function renderRemoval(account, removal) {
  const label = `Amazon ${account.domain} ${account.email ?? account.name ?? ''}`.trim();
  if (removal?.key !== account.key) {
    return h('button', {
      class: 'remove', type: 'button', 'aria-label': `Remove ${label} from Waybill`, title: 'Remove from Waybill',
      on: { click: () => store.dispatch({ type: 'removal-asked', key: account.key }) },
    }, '×');
  }
  const busy = removal.status === 'removing';
  return h('div', {
    class: 'confirm-removal', role: 'group', 'aria-label': `Remove ${label}`,
    on: { keydown: (event) => { if (event.key === 'Escape') store.dispatch({ type: 'removal-cancelled' }); } },
  },
  h('p', { text: removal.status === 'failed' ? `Couldn't remove: ${removal.error}` : 'Remove this account from Waybill? It comes back only if you sign in to it again.' }),
  h('div', { class: 'confirm-actions' },
    h('button', { class: 'confirm-remove', type: 'button', 'data-confirm-remove': true, disabled: busy, on: { click: () => confirmRemoval(account) }, text: busy ? 'Removing…' : 'Remove' }),
    h('button', { class: 'confirm-cancel', type: 'button', disabled: busy, on: { click: () => store.dispatch({ type: 'removal-cancelled' }) }, text: 'Cancel' })));
}

function renderAccounts({ scope, instanceId, accounts, selectedKey, removal }) {
  document.querySelector('#accounts-title').textContent = scope === 'all-profiles' ? 'Accounts in all browser profiles' : 'Accounts in this browser profile';
  document.querySelector('[data-server-offline]').hidden = scope !== 'this-profile';
  const list = document.querySelector('[data-account-list]');
  const hadConfirmFocus = document.activeElement?.closest?.('.confirm-removal');
  list.replaceChildren(...accounts.items.map((account) => h('li', { class: 'account-item' },
    h('button', {
      class: 'account', type: 'button', 'aria-current': String(account.key === selectedKey),
      on: { click: () => selectAccount(account.key) },
    },
    h('img', { src: '../../icons/marketplaces/amazon.png', alt: '', width: 32, height: 32 }),
    h('span', {},
      h('span', { class: 'account-name', text: `Amazon ${account.domain}` }),
      h('span', { class: 'account-sub', text: account.email ?? account.name ?? '' }),
      h('span', { class: 'account-sub', text: profileLabel(account, instanceId) })),
    h('span', { class: 'pill', 'data-status': account.status, text: STATUS_LABELS[account.status] ?? 'Inactive' })),
    // Removal is recorded by the server, so it is offered only with it.
    scope === 'all-profiles' && account.id && renderRemoval(account, removal))));
  document.querySelector('[data-accounts-empty]').hidden = accounts.status !== 'ready' || accounts.items.length > 0;
  // Keep keyboard focus in the confirmation across re-renders.
  if (removal?.status === 'confirming' && (hadConfirmFocus || document.activeElement === document.body || document.activeElement?.classList.contains('remove'))) {
    list.querySelector('[data-confirm-remove]')?.focus();
  }
}

function renderOrder(order, domain) {
  const field = (label, value, className) => value && h('div', { class: className }, h('dt', { text: label }), h('dd', {}, value));
  return h('li', { class: 'order' },
    h('dl', { class: 'order-head' },
      field('Order placed', order.placed),
      field('Total', order.total),
      field('Order #', h('a', { href: orderDetailsUrl(domain, order.id), target: '_blank', rel: 'noreferrer', text: order.id }), 'order-number')),
    order.status && h('p', { class: 'order-status', text: order.status }),
    h('ul', { class: 'items' }, order.items.map((item) => h('li', { class: 'item' },
      item.image
        ? h('img', { src: item.image, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy', on: { error: (event) => event.target.replaceWith(h('span', { class: 'no-image' })) } })
        : h('span', { class: 'no-image' }),
      h('a', { href: item.url, target: '_blank', rel: 'noreferrer', text: item.title })))));
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// Where the shown orders came from: the Amazon page(s) read, when, and how long it took.
function renderSource(entry, key, instanceId) {
  const { pages, readAt, durationMs } = entry.source;
  const shown = (url) => { const { host, pathname, search } = new URL(url); return `${host.replace(/^www\./, '')}${pathname}${search}`; };
  const where = entry.servedBy === instanceId ? 'in this browser profile' : 'in another browser profile';
  return h('p', { class: 'source' },
    `Read live from Amazon ${where} at ${timeFormat.format(readAt)} in ${(durationMs / 1000).toFixed(1)} s: `,
    pages.map((url, index) => [index ? ', ' : '', h('a', { href: url, target: '_blank', rel: 'noreferrer', text: shown(url) })]),
    ' ',
    h('button', { class: 'refresh', type: 'button', on: { click: () => loadOrders(key, entry.filter) }, text: 'Refresh' }));
}

// Shown in place of the source line while a read is in progress.
function renderFetching(account, instanceId) {
  const own = account.profiles.map((profile) => profile.instanceId === instanceId);
  const where = own.every(Boolean) ? ' in this browser profile' : own.some(Boolean) ? '' : ' in another browser profile';
  return h('p', { class: 'source', role: 'status', text: `Fetching live from Amazon${where}…` });
}

function renderDetail({ instanceId, accounts, selectedKey, orders }) {
  const detail = document.querySelector('[data-detail]');
  const account = accounts.items.find((item) => item.key === selectedKey);
  if (!account) {
    detail.replaceChildren(h('p', { class: 'message', text: accounts.items.length ? 'Select an account to load its orders from Amazon.' : '' }));
    return;
  }
  const entry = orders[selectedKey];
  const period = entry?.filters.length > 0 && h('label', { class: 'period' }, 'Period',
    h('select', {
      disabled: entry.status === 'loading',
      on: { change: (event) => loadOrders(selectedKey, event.target.value) },
    }, entry.filters.map(({ value, label }) => h('option', { value, selected: value === entry.filter, text: label }))));

  const signInLink = h('a', { href: ordersUrl(account.domain), target: '_blank', rel: 'noreferrer', text: `Sign in on Amazon ${account.domain}` });
  const loading = !entry || entry.status === 'loading';
  const orderList = (className) => h('ul', { class: className }, entry.orders.map((order) => renderOrder(order, account.domain)));
  const body = loading && entry?.orders.length ? orderList('orders is-refreshing')
    : loading ? h('p', { class: 'message', text: 'Loading orders from Amazon…' })
    : entry.status === 'needs-sign-in' ? h('p', { class: 'message' }, 'Amazon wants your password again. ', signInLink, ', then select the account again.')
    : entry.status === 'error' ? h('p', { class: 'message', text: `Couldn't load orders: ${entry.error}` })
    : entry.orders.length === 0 ? h('p', { class: 'message', text: 'No orders in this period.' })
    : orderList('orders');

  const status = loading ? renderFetching(account, instanceId)
    : entry.status === 'loaded' && entry.source ? renderSource(entry, selectedKey, instanceId)
    : null;

  detail.replaceChildren(...[
    h('div', { class: 'detail-head' },
      h('img', { src: '../../icons/marketplaces/amazon.png', alt: '', width: 40, height: 40 }),
      h('div', {},
        h('h2', { class: 'detail-title', text: `Amazon ${account.domain}` }),
        h('p', { class: 'detail-sub', text: [account.email ?? account.name, account.id && `Account #${account.id}`].filter(Boolean).join(' · ') })),
      period),
    status,
    body].filter(Boolean));
}

let shownKey = null;
store.subscribe((state) => {
  renderAccounts(state);
  renderDetail(state);
  // Clear the address when the selected account went away.
  if (shownKey && !state.selectedKey) showAccountInAddress(null);
  shownKey = state.selectedKey;
});

let firstList = true;
const requestedId = Number(new URLSearchParams(location.search).get('id')) || null;

async function showAccounts() {
  const { scope, instanceId, accounts } = await loadAccounts();
  store.dispatch({ type: 'accounts-loaded', scope, instanceId, accounts });
  if (firstList) {
    firstList = false;
    const requested = requestedId && accounts.find((account) => account.id === requestedId);
    if (requested) selectAccount(requested.key);
    else if (accounts.length === 1) selectAccount(accounts[0].key);
  }
}

// Signing in to or out of Waybill (in the popup) restarts this page, so it
// always shows exactly what the current session may see. Any other change
// (accounts, server status) redraws the list.
state.onChange((keys) => {
  if (state.isSessionChange(keys)) location.reload();
  else showAccounts().catch(showError);
});

if (!(await state.sessionName())) {
  document.querySelector('[data-signed-out]').hidden = false;
  document.querySelector('.layout').hidden = true;
} else {
  await showAccounts();
}
