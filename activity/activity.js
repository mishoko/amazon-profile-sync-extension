// Activity page: lists this browser profile's Amazon accounts (as found by the
// popup) and, only when one is selected, reads that account's orders live from
// Amazon's orders page (see lib/amazon-orders.js). Orders are kept in page memory only; they are never stored or sent.
import { createStore } from '../lib/store.js';
import { loadAccounts, storeAccount } from '../lib/storage.js';
import { ordersUrl, orderDetailsUrl } from '../lib/amazon.js';
import { readOrders, readLatestOrders, closeOrdersWindows } from '../lib/amazon-orders.js';

const accountKey = ({ marketplace, domain }) => `${marketplace}${domain}`;

// Development builds only: activity.html?showOrdersWindow keeps the Amazon
// window visible and open, to inspect its requests in DevTools.
const isDevelopmentBuild = !('update_url' in chrome.runtime.getManifest());
const orderReadOptions = { visible: isDevelopmentBuild && new URLSearchParams(location.search).has('showOrdersWindow') };

const initialState = {
  accounts: { status: 'loading', items: [] },
  selectedKey: null,
  // Per account key: { requestId, status: 'loading' | 'loaded' | 'needs-sign-in' | 'error',
  //                    filter, filters, orders, error }
  orders: {},
};

function reducer(state, action) {
  switch (action.type) {
    case 'accounts-loaded':
      return { ...state, accounts: { status: 'ready', items: action.accounts } };
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
        : { ...current, status: 'loaded', filter: result.filter, filters: result.filters.length ? result.filters : current.filters, orders: result.orders, source: result.source };
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

async function loadOrders(key, filter = null) {
  const account = store.getState().accounts.items.find((item) => accountKey(item) === key);
  const requestId = nextRequestId++;
  store.dispatch({ type: 'orders-requested', key, requestId, filter });
  try {
    const result = filter
      ? await readOrders(account.domain, filter, orderReadOptions)
      : await readLatestOrders(account.domain, orderReadOptions);
    if (result.status === 'needs-sign-in') await storeAccount(account.marketplace, account.domain, { ...account, status: 'needs-sign-in' });
    store.dispatch({ type: 'orders-received', key, requestId, result });
  } catch (error) {
    store.dispatch({ type: 'orders-failed', key, requestId, error: error.message });
  }
}

function selectAccount(key) {
  store.dispatch({ type: 'account-selected', key });
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

function renderAccounts({ accounts, selectedKey }) {
  const list = document.querySelector('[data-account-list]');
  list.replaceChildren(...accounts.items.map((account) => {
    const key = accountKey(account);
    return h('li', {}, h('button', {
      class: 'account', type: 'button', 'aria-current': String(key === selectedKey),
      on: { click: () => selectAccount(key) },
    },
    h('img', { src: '../icons/marketplaces/amazon.svg', alt: '', width: 32, height: 32 }),
    h('span', {},
      h('span', { class: 'account-name', text: `Amazon ${account.domain}` }),
      h('span', { class: 'account-sub', text: account.email ?? account.name ?? '' })),
    h('span', { class: 'pill', 'data-status': account.status, text: STATUS_LABELS[account.status] ?? 'Inactive' })));
  }));
  document.querySelector('[data-accounts-empty]').hidden = accounts.status !== 'ready' || accounts.items.length > 0;
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
function renderSource(entry, key) {
  const { pages, readAt, durationMs } = entry.source;
  const shown = (url) => { const { host, pathname, search } = new URL(url); return `${host.replace(/^www\./, '')}${pathname}${search}`; };
  return h('p', { class: 'source' },
    `Read live from Amazon at ${timeFormat.format(readAt)} in ${(durationMs / 1000).toFixed(1)} s: `,
    pages.map((url, index) => [index ? ', ' : '', h('a', { href: url, target: '_blank', rel: 'noreferrer', text: shown(url) })]),
    ' ',
    h('button', { class: 'refresh', type: 'button', on: { click: () => loadOrders(key, entry.filter) }, text: 'Refresh' }));
}

function renderDetail({ accounts, selectedKey, orders }) {
  const detail = document.querySelector('[data-detail]');
  const account = accounts.items.find((item) => accountKey(item) === selectedKey);
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
  const body = !entry || entry.status === 'loading' ? h('p', { class: 'message', text: 'Loading orders from Amazon…' })
    : entry.status === 'needs-sign-in' ? h('p', { class: 'message' }, 'Amazon wants your password again. ', signInLink, ', then select the account again.')
    : entry.status === 'error' ? h('p', { class: 'message', text: `Couldn't load orders: ${entry.error}` })
    : entry.orders.length === 0 ? h('p', { class: 'message', text: 'No orders in this period.' })
    : h('ul', { class: 'orders' }, entry.orders.map((order) => renderOrder(order, account.domain)));

  detail.replaceChildren(
    h('div', { class: 'detail-head' },
      h('img', { src: '../icons/marketplaces/amazon.svg', alt: '', width: 40, height: 40 }),
      h('div', {},
        h('h2', { class: 'detail-title', text: `Amazon ${account.domain}` }),
        h('p', { class: 'detail-sub', text: account.email ?? account.name ?? '' })),
      period),
    entry?.status === 'loaded' && entry.source && renderSource(entry, selectedKey),
    body);
}

addEventListener('pagehide', closeOrdersWindows);

store.subscribe((state) => {
  renderAccounts(state);
  renderDetail(state);
});

const accounts = (await loadAccounts())
  .filter((account) => account.marketplace === 'amazon')
  .sort((a, b) => a.domain.localeCompare(b.domain));
store.dispatch({ type: 'accounts-loaded', accounts });
if (accounts.length === 1) selectAccount(accountKey(accounts[0]));
