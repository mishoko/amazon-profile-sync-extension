// The event table and the chain runner shared by the extension and the server.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENTS, whereIs, checkEvents } from '../core/events.js';
import { createRunner } from '../core/chain.js';

// Every oneOf event on the background needs a handler; these stand in.
const backgroundChoices = {
  'site:check-account': () => ({ event: 'site:not-tracked' }),
  'site:read-orders': () => ({ event: 'site:unreachable', data: { reason: 'test' } }),
  'user:requested-orders': () => ({ event: 'site:read-orders' }),
};

function background(handlers = {}) {
  const sent = [];
  const runner = createRunner({
    side: 'background',
    handlers: { ...backgroundChoices, ...handlers },
    passOn: async (name, data) => {
      sent.push([name, data]);
      return { [name]: data };
    },
  });
  return { runner, sent };
}

test('the event table is valid', () => {
  checkEvents();
  assert.equal(whereIs('db:remove-account'), 'server');
  assert.equal(whereIs('server:find-profile'), 'server');
  assert.equal(whereIs('storage:save-account'), 'background');
  assert.equal(whereIs('user:signed-out'), 'background');
});

test('runs a chain in order, adds each handler\'s data, and hands server events on', async () => {
  const ran = [];
  const { runner, sent } = background({
    'storage:clear-session': () => { ran.push('clear'); },
    'storage:read-shared-accounts': () => { ran.push('read'); return { accounts: [] }; },
  });
  const reached = await runner.run('user:signed-out', { by: 'test' });
  assert.deepEqual(ran, ['clear', 'read']);
  assert.deepEqual(Object.keys(reached), ['user:signed-out', 'storage:clear-session', 'storage:accounts-changed', 'storage:read-shared-accounts', 'db:replace-profile-accounts']);
  assert.deepEqual(sent, [['db:replace-profile-accounts', { by: 'test', accounts: [] }]]);
});

test('oneOf follows only the event its handler chose', async () => {
  const { runner } = background({
    'site:check-account': () => ({ event: 'site:account-gone' }),
    'storage:forget-account': () => {},
    'storage:read-shared-accounts': () => ({ accounts: [] }),
  });
  const reached = await runner.run('site:signed-in', { site: { marketplace: 'amazon', domain: '.com' } });
  assert.ok('site:account-gone' in reached);
  assert.ok(!('site:account-found' in reached));
  assert.ok('storage:forget-account' in reached);
});

test('fails loud', async () => {
  const wrongChoice = background({ 'site:check-account': () => ({ event: 'site:orders-read' }) }).runner;
  await assert.rejects(wrongChoice.run('site:visited', {}), /must lead to one of/);
  await assert.rejects(background().runner.run('user:typo', {}), /Unknown event/);
  const badReturn = background({ 'storage:clear-session': () => 'done' }).runner;
  await assert.rejects(badReturn.run('user:signed-out', {}), /must return an object or nothing/);
  assert.throws(() => background({ 'db:remove-account': () => {} }), /belongs on the server/);
  assert.throws(() => background({ 'storage:typo': () => {} }), /unknown event/);
  assert.throws(() => createRunner({ side: 'background', handlers: {}, passOn: () => ({}) }), /has oneOf but no handler/);
});

test('the table check catches mistakes', () => {
  assert.throws(() => checkEvents({ 'user:a': { then: ['user:missing'] } }), /unknown event/);
  assert.throws(() => checkEvents({ 'user:a': { then: ['user:b'] }, 'user:b': { then: ['user:a'] } }), /loop/);
  assert.throws(() => checkEvents({ 'other:a': { then: [] } }), /must be/);
  assert.throws(() => checkEvents({ 'user:a': { oneOf: ['user:b'] }, 'user:b': { then: [] } }), /two or more/);
  assert.throws(() => checkEvents({ 'user:a': {} }), /exactly one of/);
});

test('every event can be reached from something that happened', () => {
  const targets = new Set(Object.values(EVENTS).flatMap((event) => event.then ?? event.oneOf));
  // Starting points: started by the user, noticed on a site, or by the server's connections.
  const starts = Object.keys(EVENTS).filter((name) => !targets.has(name));
  assert.deepEqual(starts.filter((name) => !/^(user|site|server):/.test(name)), []);
});
