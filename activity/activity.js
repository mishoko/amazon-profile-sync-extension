// Activity page: lists Amazon accounts and, only when one is selected, reads
// that account's orders live from Amazon. Orders are kept in page memory only.
//
// With the local server running (server/server.mjs) the list holds the
// accounts of every browser profile with Waybill, pushed by the server as they
// change, and a selected account's orders are read by the profile that is
// signed into it. Without the server it falls back to this profile's saved
// accounts (updated as they change) and keeps checking for the server.
import { createStore } from '../lib/store.js';
import { loadAccounts, markNeedsSignIn } from '../lib/storage.js';
import { ordersUrl, orderDetailsUrl } from '../lib/amazon.js';
import { readOrders, readLatestOrders, closeOrdersWindows } from '../lib/amazon-orders.js';
import { getInstanceId, watchAccounts, requestOrders } from '../lib/server.js';

// Development builds only: activity.html?showOrdersWindow keeps the Amazon
// window visible and open, to inspect its requests in DevTools.
const isDevelopmentBuild = !('update_url' in chrome.runtime.getManifest());
const orderReadOptions = { visible: isDevelopmentBuild && new URLSearchParams(location.search).has('showOrdersWindow') };

const SERVER_RETRY_MS = 5000;

// Where accounts and orders come from. subscribe(onAccounts, onLost) delivers
// the account list now and after every change, and returns an unsubscribe
// function. Accounts share one shape:
// { key, id?, marketplace, domain, customerId, name, email, status, profiles: [{ instanceId, online }] }
// `id` is the server's lasting account ID; it exists only with the server.
const allProfiles = {
  scope: 'all-profiles',
  subscribe: (onAccounts, onLost) => watchAccounts(
    (accounts) => onAccounts(accounts.map((account) => ({ ...account, key: `id:${account.id}` }))),
    onLost,
  ),
  async orders(account, filter) {
    const { instanceId, result } = await requestOrders(account.id, filter);
    return { ...result, servedBy: instanceId };
  },
};

const thisProfile = (instanceId) => ({
  scope: 'this-profile',
  subscribe(onAccounts) {
    const load = async () => onAccounts((await loadAccounts())
      .filter((account) => account.marketplace === 'amazon')
      .map((account) => ({ ...account, key: `amazon${account.domain}`, profiles: [{ instanceId, online: true }] }))
      .sort((a, b) => a.domain.localeCompare(b.domain)));
    const onChanged = (changes, area) => {
      if (area === 'local' && Object.keys(changes).some((key) => key.startsWith('account:'))) load();
    };
    chrome.storage.onChanged.addListener(onChanged);
    load();
    return () => chrome.storage.onChanged.removeListener(onChanged);
  },
  async orders(account, filter) {
    const result = filter
      ? await readOrders(account.domain, filter, orderReadOptions)
      : await readLatestOrders(account.domain, orderReadOptions);
    if (result.status === 'needs-sign-in') await markNeedsSignIn(account.marketplace, account.domain);
    return { ...result, servedBy: instanceId };
  },
});

// Asks the background worker to connect this profile to the local server:
// { connected, instanceId }, or null if the worker didn't answer.
const connectToServer = () => chrome.runtime.sendMessage({ type: 'connect' }).catch(() => null);

const initialState = {
  scope: null,
  instanceId: null,
  accounts: { status: 'loading', items: [] },
  selectedKey: null,
  // Per account key: { requestId, status: 'loading' | 'loaded' | 'needs-sign-in' | 'error',
  //                    filter, filters, orders, error }
  orders: {},
};

function reducer(state, action) {
  switch (action.type) {
    case 'accounts-loaded':
      return { ...state, scope: action.scope, instanceId: action.instanceId, accounts: { status: 'ready', items: action.accounts } };
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
let source = null;
let nextRequestId = 1;

async function loadOrders(key, filter = null) {
  const account = store.getState().accounts.items.find((item) => item.key === key);
  const requestId = nextRequestId++;
  store.dispatch({ type: 'orders-requested', key, requestId, filter });
  try {
    const result = await source.orders(account, filter);
    store.dispatch({ type: 'orders-received', key, requestId, result });
  } catch (error) {
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

function profileLabel(account, instanceId) {
  if (account.profiles.some((profile) => profile.instanceId === instanceId)) return 'This browser profile';
  return account.profiles.some((profile) => profile.online) ? 'Another browser profile' : 'Another browser profile · not connected';
}

function renderAccounts({ scope, instanceId, accounts, selectedKey }) {
  document.querySelector('#accounts-title').textContent = scope === 'all-profiles' ? 'Accounts in all browser profiles' : 'Accounts in this browser profile';
  document.querySelector('[data-server-offline]').hidden = scope !== 'this-profile';
  const list = document.querySelector('[data-account-list]');
  list.replaceChildren(...accounts.items.map((account) => h('li', {}, h('button', {
    class: 'account', type: 'button', 'aria-current': String(account.key === selectedKey),
    on: { click: () => selectAccount(account.key) },
  },
  h('img', { src: '../icons/marketplaces/amazon.svg', alt: '', width: 32, height: 32 }),
  h('span', {},
    h('span', { class: 'account-name', text: `Amazon ${account.domain}` }),
    h('span', { class: 'account-sub', text: account.email ?? account.name ?? '' }),
    h('span', { class: 'account-sub', text: profileLabel(account, instanceId) })),
  h('span', { class: 'pill', 'data-status': account.status, text: STATUS_LABELS[account.status] ?? 'Inactive' })))));
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
      h('img', { src: '../icons/marketplaces/amazon.svg', alt: '', width: 40, height: 40 }),
      h('div', {},
        h('h2', { class: 'detail-title', text: `Amazon ${account.domain}` }),
        h('p', { class: 'detail-sub', text: [account.email ?? account.name, account.id && `Account #${account.id}`].filter(Boolean).join(' · ') })),
      period),
    status,
    body].filter(Boolean));
}

addEventListener('pagehide', closeOrdersWindows);

store.subscribe((state) => {
  renderAccounts(state);
  renderDetail(state);
});

let unsubscribe = () => {};
let firstList = true;
const requestedId = Number(new URLSearchParams(location.search).get('id')) || null;

function use(next, instanceId) {
  unsubscribe();
  source = next;
  unsubscribe = next.subscribe((accounts) => {
    store.dispatch({ type: 'accounts-loaded', scope: next.scope, instanceId, accounts });
    if (firstList) {
      const requested = requestedId && accounts.find((account) => account.id === requestedId);
      if (requested) selectAccount(requested.key);
      else if (accounts.length === 1) selectAccount(accounts[0].key);
    }
    firstList = false;
  }, () => {
    // The server stopped: show this profile's accounts until it is back.
    use(thisProfile(instanceId), instanceId);
    waitForServer(instanceId);
  });
}

function waitForServer(instanceId) {
  setTimeout(async () => {
    if ((await connectToServer())?.connected) use(allProfiles, instanceId);
    else waitForServer(instanceId);
  }, SERVER_RETRY_MS);
}

const answer = await connectToServer();
const instanceId = answer?.instanceId ?? await getInstanceId();
if (answer?.connected) {
  use(allProfiles, instanceId);
} else {
  use(thisProfile(instanceId), instanceId);
  waitForServer(instanceId);
}
