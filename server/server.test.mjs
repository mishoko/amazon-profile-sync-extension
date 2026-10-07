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

function connect(instanceId, { origin = ORIGIN } = {}) {
  const socket = new WebSocket(`ws://${base}/connect?instance=${instanceId}`, { headers: { origin } });
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

  const { accounts } = await (await api('/accounts')).json();
  assert.deepEqual(accounts.map((account) => account.key), [
    'amazon.co.uk:A1AAAAAAAAAAAA', 'amazon.com:A1AAAAAAAAAAAA', 'amazon.com:A2BBBBBBBBBBBB', 'amazon.de:email:bob@example.com',
  ]);
  assert.deepEqual(accounts[2].profiles, [{ instanceId: PROFILE_B, online: true, status: 'active' }]);
  assert.equal('orders' in accounts[1], false);

  b.close();
  await settle();
  const after = await (await api('/accounts')).json();
  assert.equal(after.accounts.find((account) => account.key === 'amazon.com:A2BBBBBBBBBBBB').profiles[0].online, false);
  a.close();
});

test('forwards an order request to the profile that holds the account', async () => {
  const a = connect(PROFILE_A);
  const b = connect(PROFILE_B);
  await Promise.all([a.opened, b.opened]);
  a.send({ type: 'accounts', accounts: [{ marketplace: 'amazon', domain: '.co.uk', customerId: 'A1AAAAAAAAAAAA', status: 'active' }] });
  b.send({ type: 'accounts', accounts: [{ marketplace: 'amazon', domain: '.com', customerId: 'A2BBBBBBBBBBBB', status: 'active' }] });
  await settle();

  const response = api(`/accounts/${encodeURIComponent('amazon.com:A2BBBBBBBBBBBB')}/orders`, { method: 'POST', body: JSON.stringify({ filter: 'year-2023' }) });
  const request = await b.next();
  assert.equal(request.type, 'read-orders');
  assert.equal(request.domain, '.com');
  assert.equal(request.filter, 'year-2023');
  b.send({ type: 'orders-result', requestId: request.requestId, result: { status: 'active', orders: [{ id: '113-1111111-2222222' }] } });

  const answer = await response;
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { instanceId: PROFILE_B, result: { status: 'active', orders: [{ id: '113-1111111-2222222' }] } });

  // Another profile cannot answer a request that wasn't sent to it.
  const second = api(`/accounts/${encodeURIComponent('amazon.com:A2BBBBBBBBBBBB')}/orders`, { method: 'POST', body: '{}' });
  const secondRequest = await b.next();
  a.send({ type: 'orders-result', requestId: secondRequest.requestId, result: { status: 'active', orders: [] } });
  b.send({ type: 'orders-result', requestId: secondRequest.requestId, error: 'Amazon took too long to load' });
  assert.equal((await second).status, 502);

  a.close();
  b.close();
});

test('reports accounts that no connected profile can serve', async () => {
  const response = await api(`/accounts/${encodeURIComponent('amazon.fr:A9')}/orders`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 409);
});

test('fails pending requests when the profile disconnects', async () => {
  const a = connect(PROFILE_A);
  await a.opened;
  a.send({ type: 'accounts', accounts: [{ marketplace: 'amazon', domain: '.ca', customerId: 'A1CCCCCCCCCCCC', status: 'active' }] });
  await settle();
  const response = api(`/accounts/${encodeURIComponent('amazon.ca:A1CCCCCCCCCCCC')}/orders`, { method: 'POST', body: '{}' });
  await a.next();
  a.close();
  assert.equal((await response).status, 502);
});
