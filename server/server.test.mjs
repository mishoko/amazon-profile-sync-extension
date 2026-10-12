// Run: node --test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createWaybillServer } from './server.mjs';

const EXTENSION_ID = 'dmhkjckieepnigmelmogkmomgmkgkkdn';
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

const health = (headers = { origin: ORIGIN }) => fetch(`http://${base}/health`, { headers });

// A browser profile as the server sees it: it answers the server's events
// like the background does (background/handlers.js), and can run the events
// a profile may send. `reads(name, data)` answers site:read-orders.
function profile(instanceId, { accounts = [], origin = ORIGIN, reads } = {}) {
  const socket = new WebSocket(`ws://${base}/connect?instance=${instanceId}`, { headers: { origin } });
  const pending = new Map();
  const lists = [];
  const listeners = new Set();
  let shared = accounts;
  let nextId = 1;
  const send = (message) => socket.send(JSON.stringify(message));

  const run = (name, data = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ kind: 'run', id, name, data });
  });

  async function answer(name, data) {
    if (name === 'storage:read-shared-accounts') return { [name]: { ...data, accounts: shared }, ...(await run('db:replace-profile-accounts', { accounts: shared })) };
    if (name === 'storage:save-all-accounts') {
      lists.push(data.accounts);
      for (const listener of listeners) listener();
      return { [name]: data };
    }
    if (name === 'site:read-orders' && reads) return reads(name, data);
    throw new Error(`unexpected ${name}`);
  }

  socket.addEventListener('message', async ({ data }) => {
    const message = JSON.parse(data);
    if (message.kind === 'answer') {
      const waiting = pending.get(message.id);
      pending.delete(message.id);
      if (message.ok) waiting.resolve(message.reached);
      else waiting.reject(new Error(message.error));
      return;
    }
    try {
      send({ kind: 'answer', id: message.id, ok: true, reached: await answer(message.name, message.data) });
    } catch (error) {
      send({ kind: 'answer', id: message.id, ok: false, error: error.message });
    }
  });

  return {
    opened: new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve);
      socket.addEventListener('error', reject);
    }),
    run,
    report(next) {
      shared = next;
      return run('db:replace-profile-accounts', { accounts: next });
    },
    // Resolves with the first account list (sent to every profile) that passes `check`.
    until(check) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no matching account list')), 2000);
        const look = () => {
          const list = lists.at(-1);
          if (!list || !check(list)) return;
          clearTimeout(timer);
          listeners.delete(look);
          resolve(list);
        };
        listeners.add(look);
        look();
      });
    },
    close: () => socket.close(),
  };
}

const ann = { marketplace: 'amazon', domain: '.com', customerId: 'A1AAAAAAAAAAAA', name: 'Ann', email: 'ann@example.com', status: 'active' };
const bob = { marketplace: 'amazon', domain: '.com', customerId: 'A2BBBBBBBBBBBB', name: 'Bob', email: 'bob@example.com', status: 'active' };
const has = (customerId) => (list) => list.some((account) => account.customerId === customerId);
const lacks = (customerId) => (list) => !has(customerId)(list);
const idIn = (list, customerId) => list.find((account) => account.customerId === customerId).id;

test('rejects requests from other origins and hosts', async () => {
  assert.equal((await health({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await health({})).status, 403);
  // DNS rebinding: right origin, but the page reached the server under another host name.
  const [hostname, port] = base.split(':');
  const reboundStatus = await new Promise((resolve, reject) => {
    request({ hostname, port, path: '/health', headers: { origin: ORIGIN, host: 'evil.example' } }, (response) => { response.resume(); resolve(response.statusCode); })
      .on('error', reject).end();
  });
  assert.equal(reboundStatus, 403);
  await assert.rejects(profile(PROFILE_A, { origin: 'https://evil.example' }).opened);
});

test('answers health checks from the extension', async () => {
  assert.equal((await health()).status, 204);
});

test('asks each profile for its accounts and sends every profile the full list', async () => {
  const a = profile(PROFILE_A, { accounts: [{ ...ann, orders: ['ignored'] }, { ...ann, domain: '.co.uk' }] });
  const b = profile(PROFILE_B, { accounts: [bob, { marketplace: 'amazon', domain: '.de', email: 'bob@example.com', status: 'needs-sign-in' }, { marketplace: 'amazon', domain: 'not a domain', customerId: 'A3', status: 'active' }] });
  await Promise.all([a.opened, b.opened]);

  const list = await a.until((items) => items.length === 4);
  assert.deepEqual(list.map(({ domain, customerId, email }) => `${domain} ${customerId ?? email}`), [
    '.com A1AAAAAAAAAAAA', '.co.uk A1AAAAAAAAAAAA', '.com A2BBBBBBBBBBBB', '.de bob@example.com',
  ]);
  assert.ok(list.every((account) => Number.isInteger(account.id)));
  const bobs = list.find((account) => account.customerId === bob.customerId);
  assert.deepEqual(bobs.profiles, [{ instanceId: PROFILE_B, status: 'active' }]);
  assert.equal(bobs.status, 'active');
  assert.equal('orders' in list[0], false);
  await b.until((items) => items.length === 4);

  // A disconnected profile no longer holds anything: Bob's account leaves the
  // list, and comes back with the same ID when B reconnects and reports it.
  b.close();
  await a.until(lacks(bob.customerId));
  const again = profile(PROFILE_B, { accounts: [bob] });
  await again.opened;
  assert.equal(idIn(await a.until(has(bob.customerId)), bob.customerId), bobs.id);

  // Signing out reports an empty list.
  await again.report([]);
  await a.until(lacks(bob.customerId));
  again.close();
  a.close();
});

test('a profile reports only for itself', async () => {
  const italian = [{ ...bob, domain: '.it' }];
  const a = profile(PROFILE_A, { accounts: italian });
  await a.opened;
  await a.run('db:replace-profile-accounts', { accounts: italian, profile: PROFILE_B, to: PROFILE_B });
  const italy = (await a.until((items) => items.some((account) => account.domain === '.it'))).find((account) => account.domain === '.it');
  assert.deepEqual(italy.profiles, [{ instanceId: PROFILE_A, status: 'active' }]);
  a.close();
});

test('finds the profile signed in to an account and passes its orders back', async () => {
  const seen = [];
  const a = profile(PROFILE_A, { accounts: [{ ...ann, domain: '.co.uk' }] });
  const b = profile(PROFILE_B, {
    accounts: [bob],
    reads: (name, data) => {
      seen.push(data);
      if (data.filter === 'year-2020') throw new Error('Amazon showed 2 orders, but Waybill couldn\'t read them');
      return { [name]: data, 'site:orders-read': { ...data, result: { orders: [{ id: '113-1111111-2222222' }] } } };
    },
  });
  await Promise.all([a.opened, b.opened]);
  const bobId = idIn(await a.until(has(bob.customerId)), bob.customerId);

  const reached = await a.run('server:find-profile', { accountId: bobId, filter: 'year-2023' });
  assert.deepEqual(seen[0], { site: { marketplace: 'amazon', domain: '.com' }, filter: 'year-2023', to: PROFILE_B, servedBy: PROFILE_B, accountId: bobId, profile: PROFILE_A });
  assert.deepEqual(reached['site:orders-read'].result.orders, [{ id: '113-1111111-2222222' }]);
  assert.equal(reached['site:orders-read'].servedBy, PROFILE_B);

  // An error in the reading profile reaches the asker.
  await assert.rejects(a.run('server:find-profile', { accountId: bobId, filter: 'year-2020' }), /couldn't read them/);
  await assert.rejects(a.run('server:find-profile', { accountId: bobId, filter: 'Robert; DROP TABLE' }), /Invalid filter/);
  a.close();
  b.close();
});

test('reports unknown accounts and accounts no connected profile holds', async () => {
  const a = profile(PROFILE_A, { accounts: [{ ...ann, domain: '.fr', customerId: 'A1FFFFFFFFFFFF' }] });
  const b = profile(PROFILE_B);
  await Promise.all([a.opened, b.opened]);
  assert.ok('db:account-not-found' in await b.run('server:find-profile', { accountId: 999999 }));
  const id = idIn(await b.until(has('A1FFFFFFFFFFFF')), 'A1FFFFFFFFFFFF');
  a.close();
  await b.until(lacks('A1FFFFFFFFFFFF'));
  assert.ok('server:account-offline' in await b.run('server:find-profile', { accountId: id }));
  await assert.rejects(b.run('server:find-profile', { accountId: 'one' }), /Invalid account ID/);
  b.close();
});

test('fails a waiting orders request when the reading profile reconnects or disconnects', async () => {
  let started;
  const reading = new Promise((resolve) => { started = resolve; });
  const a = profile(PROFILE_A);
  const b = profile(PROFILE_B, { accounts: [{ ...bob, domain: '.ae' }], reads: () => { started(); return new Promise(() => {}); } });
  await Promise.all([a.opened, b.opened]);
  const id = idIn(await a.until((items) => items.some((account) => account.domain === '.ae')), bob.customerId);

  const first = a.run('server:find-profile', { accountId: id });
  await reading;
  const reconnected = profile(PROFILE_B, { accounts: [{ ...bob, domain: '.ae' }], reads: () => new Promise(() => {}) });
  await reconnected.opened;
  await assert.rejects(first, /reconnected/);

  await a.until((items) => items.some((account) => account.domain === '.ae'));
  const second = a.run('server:find-profile', { accountId: id });
  await new Promise((resolve) => setTimeout(resolve, 50));
  reconnected.close();
  await assert.rejects(second, /disconnected/);
  a.close();
});

test('removes an account: gone from every list, orders refused, removal answered once', async () => {
  const a = profile(PROFILE_A, { accounts: [{ ...ann, domain: '.es', customerId: 'A1EEEEEEEEEEEE', signedInAt: Date.now() - 1000 }] });
  const b = profile(PROFILE_B);
  await Promise.all([a.opened, b.opened]);
  const id = idIn(await b.until(has('A1EEEEEEEEEEEE')), 'A1EEEEEEEEEEEE');

  assert.ok('db:account-removed' in await b.run('db:remove-account', { accountId: id }));
  await a.until(lacks('A1EEEEEEEEEEEE'));
  await b.until(lacks('A1EEEEEEEEEEEE'));
  assert.ok('db:account-not-found' in await b.run('server:find-profile', { accountId: id }));
  assert.ok('db:account-not-found' in await b.run('db:remove-account', { accountId: id }));

  // Reported again without a newer sign-in, it stays removed.
  await a.report([{ ...ann, domain: '.es', customerId: 'A1EEEEEEEEEEEE', signedInAt: Date.now() - 1000 }]);
  assert.ok('db:account-not-found' in await b.run('server:find-profile', { accountId: id }));
  // Signed in to it again: back, with the same ID.
  await a.report([{ ...ann, domain: '.es', customerId: 'A1EEEEEEEEEEEE', signedInAt: Date.now() }]);
  assert.equal(idIn(await b.until(has('A1EEEEEEEEEEEE')), 'A1EEEEEEEEEEEE'), id);
  a.close();
  b.close();
});

test('refuses events a profile may not run on the server', async () => {
  const a = profile(PROFILE_A);
  await a.opened;
  for (const name of ['server:send-all-accounts', 'db:release-profile', 'server:profile-connected', 'storage:save-session', 'nonsense']) {
    await assert.rejects(a.run(name, { profile: PROFILE_B }), /may not run/);
  }
  a.close();
});
