// Store contract, run against the in-memory store always and against
// Postgres when DATABASE_URL is set (docker compose --profile test run --rm tests).
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from './memory.mjs';

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const summary = (fields) => ({ marketplace: 'amazon', domain: '.com', customerId: null, name: null, email: null, status: 'active', ...fields });

const stores = [['memory', async () => createMemoryStore()]];
if (process.env.DATABASE_URL) {
  stores.push(['postgres', async () => {
    const { createPostgresStore } = await import('./postgres.mjs');
    const store = await createPostgresStore(process.env.DATABASE_URL);
    return store;
  }]);
}

for (const [name, create] of stores) {
  describe(`${name} store`, () => {
    let store;
    before(async () => { store = await create(); });
    after(() => store.close());
    beforeEach(async () => {
      if (name === 'postgres') {
        const pg = (await import('pg')).default;
        const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
        await client.connect();
        await client.query('TRUNCATE profile_accounts, accounts, profiles RESTART IDENTITY CASCADE');
        await client.end();
      } else {
        store = await create();
      }
    });

    test('gives each account a lasting numeric ID and lists its holders', async () => {
      await store.replaceProfileAccounts(P1, [summary({ customerId: 'A1AAAAAAAAAAAA', email: 'ann@example.com', name: 'Ann' })]);
      await store.replaceProfileAccounts(P2, [summary({ customerId: 'A1AAAAAAAAAAAA', email: 'ann@example.com', status: 'needs-sign-in' })]);
      const [account] = await store.listAccounts();
      assert.equal(account.id, 1);
      assert.equal(account.name, 'Ann');
      assert.deepEqual(account.holders.sort((a, b) => a.profileId.localeCompare(b.profileId)), [
        { profileId: P1, status: 'active' }, { profileId: P2, status: 'needs-sign-in' },
      ]);
      assert.deepEqual(await store.getAccount(1), account);
    });

    test('keeps the same ID when an email-only account later shows its customer ID', async () => {
      await store.replaceProfileAccounts(P1, [summary({ email: 'bob@example.com', status: 'needs-sign-in' })]);
      const [before] = await store.listAccounts();
      await store.replaceProfileAccounts(P1, [summary({ email: 'bob@example.com', customerId: 'A2BBBBBBBBBBBB', name: 'Bob' })]);
      const list = await store.listAccounts();
      assert.equal(list.length, 1);
      assert.equal(list[0].id, before.id);
      assert.equal(list[0].customerId, 'A2BBBBBBBBBBBB');
    });

    test('treats each marketplace as its own account', async () => {
      await store.replaceProfileAccounts(P1, [
        summary({ customerId: 'A1AAAAAAAAAAAA' }), summary({ domain: '.co.uk', customerId: 'A1AAAAAAAAAAAA' }),
      ]);
      assert.deepEqual((await store.listAccounts()).map((account) => account.domain).sort(), ['.co.uk', '.com']);
    });

    test('replacing a profile list drops accounts it no longer holds, and the ID survives', async () => {
      await store.replaceProfileAccounts(P1, [summary({ customerId: 'A1AAAAAAAAAAAA' })]);
      const [first] = await store.listAccounts();
      await store.replaceProfileAccounts(P1, []);
      assert.deepEqual(await store.listAccounts(), []);
      await store.replaceProfileAccounts(P1, [summary({ customerId: 'A1AAAAAAAAAAAA' })]);
      assert.equal((await store.listAccounts())[0].id, first.id);
    });
  });
}
