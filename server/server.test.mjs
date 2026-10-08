// Run: node --test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createWaybillServer } from './server.mjs';

const EXTENSION_ID = 'iibmbonngmdgckjdjpilmapdgldhkeog';
const ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const PROFILE_A = '11111111-1111-4111-8111-111111111111';
const PROFILE_B = '22222222-2222-4222-8222-222222222222';

let server;
let base;

before(async () => {
  server = createWaybillServer({ extensionIds: [EXTENSION_ID] });
  base = `127.0.0.1:${await server.listen(0)}`;
});
after(() => server.close());

const api = (path, init = {}) => fetch(`http://${base}${path}`, { ...init, headers: { origin: ORIGIN, 'content-type': 'application/json', ...init.headers } });

function connect(instanceId, { origin = ORIGIN, path = `/connect?instance=${instanceId}` } = {}) {
  const socket = new WebSocket(`ws://${base}${path}`, { headers: { origin } });
  const messages = [];
  const waiters = [];
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    const waiter = waiters.shift();
    if (waiter) waiter(message); else messages.push(message);
  });
  return {
    socket,
    opened: new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve);
      socket.addEventListener('error', reject);
    }),
    send: (object) => socket.send(JSON.stringify(object)),
    next: () => (messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve) => waiters.push(resolve))),
    close: () => socket.close(),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
const accounts = async () => (await (await api('/accounts')).json()).accounts;
const idOf = async (domain, customerId) => (await accounts()).find((account) => account.domain === domain && account.customerId === customerId).id;
const ordersOf = (id, body = '{}') => api(`/accounts/${id}/orders`, { method: 'POST', body });

test('rejects requests from other origins and hosts', async () => {
  assert.equal((await api('/accounts', { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`http://${base}/accounts`)).status, 403);
  // DNS rebinding: right origin, but the page reached the server under another host name.
  const [hostname, port] = base.split(':');
  const reboundStatus = await new Promise((resolve, reject) => {
    request({ hostname, port, path: '/accounts', headers: { origin: ORIGIN, host: 'evil.example' } }, (response) => { response.resume(); resolve(response.statusCode); })
      .on('error', reject).end();
  });
  assert.equal(reboundStatus, 403);
  await assert.rejects(connect(PROFILE_A, { origin: 'https://evil.example' }).opened);
});

test('answers health checks from the extension', async () => {
  assert.equal((await api('/health')).status, 204);
});

test('aggregates account summaries from several profiles', async () => {
  const a = connect(PROFILE_A);
  const b = connect(PROFILE_B);
  await Promise.all([a.opened, b.opened]);
  a.send({ type: 'accounts', accounts: [
    { marketplace: 'amazon', domain: '.com', customerId: 'A1AAAAAAAAAAAA', name: 'Ann', email: 'ann@example.com', status: 'active', orders: ['ignored'] },
    { marketplace: 'amazon', domain: '.co.uk', customerId: 'A1AAAAAAAAAAAA', name: 'Ann', email: 'ann@example.com', status: 'active' },
  ] });
  b.send({ type: 'accounts', accounts: [
    { marketplace: 'amazon', domain: '.com', customerId: 'A2BBBBBBBBBBBB', name: 'Bob', email: 'bob@example.com', status: 'active' },
    { marketplace: 'amazon', domain: '.de', email: 'bob@example.com', status: 'needs-sign-in' },
    { marketplace: 'amazon', domain: 'not a domain', customerId: 'A3', status: 'active' },
  ] });
  await settle();

  const list = await accounts();
  assert.deepEqual(list.map(({ domain, customerId, email }) => `${domain} ${customerId ?? email}`), [
    '.com A1AAAAAAAAAAAA', '.co.uk A1AAAAAAAAAAAA', '.com A2BBBBBBBBBBBB', '.de bob@example.com',
  ]);
  assert.ok(list.every((account) => Number.isInteger(account.id)));
  const bob = list.find((account) => account.customerId === 'A2BBBBBBBBBBBB');
  assert.deepEqual(bob.profiles, [{ instanceId: PROFILE_B, status: 'active' }]);
  assert.equal(bob.status, 'active');
  assert.equal('orders' in list[0], false);

  // A disconnected profile no longer holds anything: Bob's account leaves the
  // list, and comes back with the same ID when B reconnects and reports it.
  b.close();
  await settle();
  assert.ok(!(await accounts()).some((account) => account.id === bob.id));
  const again = connect(PROFILE_B);
  await again.opened;
  again.send({ type: 'accounts', accounts: [{ marketplace: 'amazon', domain: '.com', customerId: 'A2BBBBBBBBBBBB', status: 'active' }] });
  await settle();
  assert.equal((await accounts()).find((account) => account.customerId === 'A2BBBBBBBBBBBB').id, bob.id);
  again.close();
  a.close();
});

test('forwards an order request to the profile that holds the account', async () => {
  const a = connect(PROFILE_A);
  const b = connect(PROFILE_B);
  await Promise.all([a.opened, b.opened]);
  a.send({ type: 'accounts', accounts: [{ marketplace: 'amazon', domain: '.co.uk', customerId: 'A1AAAAAAAAAAAA', status: 'active' }] });
  b.send({ type: 'accounts', accounts: [{ marketplace: 'amazon', domain: '.com', customerId: 'A2BBBBBBBBBBBB', status: 'active' }] });
  await settle();

  const bobId = await idOf('.com', 'A2BBBBBBBBBBBB');
  const response = ordersOf(bobId, JSON.stringify({ filter: 'year-2023' }));
  const request = await b.next();
  assert.equal(request.type, 'read-orders');
  assert.equal(request.domain, '.com');
  assert.equal(request.filter, 'year-2023');
  b.send({ type: 'orders-result', requestId: request.requestId, result: { status: 'active', orders: [{ id: '113-1111111-2222222' }] } });

  const answer = await response;
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { instanceId: PROFILE_B, result: { status: 'active', orders: [{ id: '113-1111111-2222222' }] } });

  // Another profile cannot answer a request that wasn't sent to it.
  const second = ordersOf(bobId);
  const secondRequest = await b.next();
  a.send({ type: 'orders-result', requestId: secondRequest.requestId, result: { status: 'active', orders: [] } });
  b.send({ type: 'orders-result', requestId: secondRequest.requestId, error: 'Amazon took too long to load' });
  assert.equal((await second).status, 502);

  a.close();
  b.close();
});

test('reports unknown accounts and accounts no connected profile can serve', async () => {
  assert.equal((await ordersOf(999999)).status, 404);
  const a = connect(PROFILE_A);
  await a.opened;
  a.send({ type: 'accounts', accounts: [{ marketplace: 'amazon', domain: '.fr', customerId: 'A1FFFFFFFFFFFF', status: 'active' }] });
  await settle();
  const id = await idOf('.fr', 'A1FFFFFFFFFFFF');
  a.close();
  await settle();
  assert.equal((await ordersOf(id)).status, 409);
});

test('fails pending requests when the profile reconnects', async () => {
  const a = connect(PROFILE_A);
  await a.opened;
  a.send({ type: 'accounts', accounts: [{ marketplace: 'amazon', domain: '.ae', customerId: 'A1GGGGGGGGGGGG', status: 'active' }] });
  await settle();
  const response = ordersOf(await idOf('.ae', 'A1GGGGGGGGGGGG'));
  await a.next();
  const reconnected = connect(PROFILE_A);
  await reconnected.opened;
  const answer = await response;
  assert.equal(answer.status, 502);
  assert.match((await answer.json()).error, /reconnected/);
  reconnected.close();
});

test('fails pending requests when the profile disconnects', async () => {
  const a = connect(PROFILE_A);
  await a.opened;
  a.send({ type: 'accounts', accounts: [{ marketplace: 'amazon', domain: '.ca', customerId: 'A1CCCCCCCCCCCC', status: 'active' }] });
  await settle();
  const response = ordersOf(await idOf('.ca', 'A1CCCCCCCCCCCC'));
  await a.next();
  a.close();
  assert.equal((await response).status, 502);
});

test('removes an account: hidden from the list, orders refused, watchers told', async () => {
  const a = connect(PROFILE_A);
  await a.opened;
  a.send({ type: 'accounts', accounts: [{ marketplace: 'amazon', domain: '.es', customerId: 'A1EEEEEEEEEEEE', status: 'active', signedInAt: Date.now() - 1000 }] });
  await settle();
  const id = await idOf('.es', 'A1EEEEEEEEEEEE');
  const watcher = connect(null, { path: '/watch' });
  await watcher.opened;
  await watcher.next();

  assert.equal((await api(`/accounts/${id}`, { method: 'DELETE' })).status, 204);
  assert.ok(!(await watcher.next()).accounts.some((account) => account.id === id));
  assert.ok(!(await accounts()).some((account) => account.id === id));
  assert.equal((await ordersOf(id)).status, 404);
  assert.equal((await api(`/accounts/${id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await api(`/accounts/${id}`, { method: 'DELETE', headers: { origin: 'https://evil.example' } })).status, 403);
  a.close();
  watcher.close();
});

test('pushes the account list to watchers whenever it changes', async () => {
  const watcher = connect(null, { path: '/watch' });
  await watcher.opened;
  assert.equal((await watcher.next()).type, 'accounts');

  const a = connect(PROFILE_A);
  await a.opened;
  await watcher.next(); // profile connected
  a.send({ type: 'accounts', accounts: [{ marketplace: 'amazon', domain: '.it', customerId: 'A1DDDDDDDDDDDD', status: 'active' }] });
  const added = await watcher.next();
  const italy = added.accounts.find((account) => account.domain === '.it');
  assert.equal(italy?.profiles[0].instanceId, PROFILE_A);

  a.send({ type: 'accounts', accounts: [] }); // signed out
  const removed = await watcher.next();
  assert.ok(!removed.accounts.some((account) => account.id === italy.id));

  a.send({ type: 'accounts', accounts: [{ marketplace: 'amazon', domain: '.it', customerId: 'A1DDDDDDDDDDDD', status: 'active' }] });
  await watcher.next();
  a.close(); // disconnected: its accounts leave the list
  const offline = await watcher.next();
  assert.ok(!offline.accounts.some((account) => account.id === italy.id));
  watcher.close();
});
