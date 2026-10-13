// Runs one event through Waybill's real chain loop, in Node, and prints every
// step: which event, which side, what went in, what the handler added, what
// follows. Learning aid only; nothing here ships in the extension.
//
//   node tools/trace.mjs user:opened-popup
//   node tools/trace.mjs user:opened-popup --amazon=needs-sign-in
//   node tools/trace.mjs user:signed-in --data '{"name":"Ann"}' --step
//   node --inspect-brk tools/trace.mjs user:signed-out     (then attach a debugger)
//
// Or through npm (options go after `--`):
//   npm run trace -- user:opened-popup --amazon=gone
//   npm run trace:step -- user:signed-in       (same as --step)
//   npm run trace:debug -- user:signed-out     (same as node --inspect-brk)
//
// Options
//   --data '<json>'   the event's data (a sample is used for the common events)
//   --amazon=<what>   found (default) | gone | needs-sign-in | unreachable
//   --state=<what>    amazon-on (default) | signed-out | amazon-off
//   --server=offline  pretend the server can't be reached (user:requested-orders)
//   --step            wait for Enter before each step
//
// ┌─ REAL vs PRETENDED ───────────────────────────────────────────────────────┐
// │ REAL     core/chain.js, core/events.js, background/handlers.js,           │
// │          core/state.js, server/handlers.mjs (all unmodified).             │
// │ PRETEND  chrome.storage (a plain object in memory, not a browser's).      │
// │ PRETEND  Amazon: site:check-account and site:read-orders return a         │
// │          scripted answer; no page is fetched, so nothing here proves that  │
// │          Amazon's real pages are read correctly.                           │
// │ PRETEND  The WebSocket: background and server call each other directly.   │
// │          Real: JSON over a socket, timeouts, reconnects, 'all' not awaited.│
// │ PRETEND  The database: the in-memory store, not PostgreSQL.               │
// │ PRETEND  One browser profile only; the real server may have several.      │
// │ PRETEND  Service-worker restarts, keep-alive, page-watcher triggers.      │
// │ => Every PRETEND item must be double-checked in a real browser            │
// │    (service worker console shows `[waybill] <event>` lines).              │
// └────────────────────────────────────────────────────────────────────────────┘
import { createInterface } from 'node:readline/promises';
import { EVENTS, whereIs } from '../core/events.js';
import { createRunner } from '../core/chain.js';
import { createMemoryStore } from '../server/store/memory.mjs';
import { createHandlers } from '../server/handlers.mjs';

// ── Arguments ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const startName = args.find((a) => !a.startsWith('--'));
if (!startName || !(startName in EVENTS)) {
  console.error(`Usage: node tools/trace.mjs <event> [options]   (see the top of this file)\nEvents: ${Object.keys(EVENTS).join(', ')}`);
  process.exit(1);
}
const dataIndex = args.indexOf('--data');
const stepMode = args.includes('--step');
const amazonAnswer = flag('amazon', 'found');
const stateMode = flag('state', 'amazon-on');
const serverOnline = flag('server', 'online') !== 'offline';

const SITE = { marketplace: 'amazon', domain: '.com' };
const PROFILE = '00000000-0000-4000-8000-000000000001';
// Sample inputs, shaped like what the popup/Activity page really pass (views/).
const SAMPLE_DATA = {
  'user:signed-in': { name: 'signed-in' },
  'user:opened-popup': { site: SITE },
  'user:turned-on': { site: SITE, settings: { amazon: { enabled: true, expanded: false, domain: '.com' }, aliexpress: { enabled: false } } },
  'user:turned-off': { site: SITE, settings: { amazon: { enabled: false, expanded: false, domain: '.com' }, aliexpress: { enabled: false } } },
  'user:requested-orders': { account: { id: 1, ...SITE }, filter: null },
  'user:removed-account': { accountId: 1 },
};
const startData = dataIndex >= 0 ? JSON.parse(args[dataIndex + 1]) : SAMPLE_DATA[startName] ?? {};

// ── PRETEND: chrome.storage in memory (so the real core/state.js can run) ───
const makeArea = () => {
  const items = {};
  return {
    items,
    async get(key) {
      if (key === null) return structuredClone(items);
      return key in items ? { [key]: structuredClone(items[key]) } : {};
    },
    async set(values) { Object.assign(items, structuredClone(values)); },
    async remove(key) { delete items[key]; },
  };
};
const local = makeArea();
const session = makeArea();
globalThis.chrome = { storage: { local, session, onChanged: { addListener() {}, removeListener() {} } } };
// core/state.js refuses writes outside a service worker; pretend to be one.
globalThis.ServiceWorkerGlobalScope = class { static [Symbol.hasInstance]() { return true; } };

// Imported after the fake chrome exists, because core/state.js reads chrome.storage on load.
const { HANDLERS } = await import('../background/handlers.js');
const state = await import('../core/state.js');

if (stateMode !== 'signed-out') await state.saveSession('trace-user');
await state.saveSettings({ amazon: { enabled: stateMode === 'amazon-on', expanded: false, domain: '.com' }, aliexpress: { enabled: false } });
await session.set({ serverOnline });
local.items.instanceId = PROFILE;

// ── Tracing ─────────────────────────────────────────────────────────────────
const colour = process.stdout.isTTY;
const paint = (code, text) => (colour ? `\x1b[${code}m${text}\x1b[0m` : text);
const show = (value, max = 220) => {
  const text = value === undefined ? '-' : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}… (${text.length} chars)` : text;
};
const rl = stepMode ? createInterface({ input: process.stdin, output: process.stdout }) : null;
const pretended = new Set(['chrome.storage (in-memory object)']);
const causedBy = new Map();
let counter = 0;
let tracing = true;

// Wraps one handler (or a stand-in for "no handler") so every call is printed.
function traced(name, handler, label) {
  return async (data, context) => {
    if (!tracing) return handler?.(data, context);
    counter += 1;
    const side = whereIs(name);
    if (side === 'server') pretended.add('server store (in-memory, not PostgreSQL)');
    console.log(`\n${paint('1;36', `#${counter} ${name}`)}  [${side}]  ${paint('2', `caused by: ${causedBy.get(name) ?? 'you (the trace start)'}`)}`);
    console.log(`   handler: ${label}`);
    console.log(`   data in: ${show(data)}`);
    if (rl) await rl.question(paint('2', '   [Enter] to run the handler… '));
    let result;
    try {
      result = await handler?.(data, context);
    } catch (error) {
      console.log(`   ${paint('31', `THREW: ${error.message}`)}`);
      throw error;
    }
    const event = EVENTS[name];
    const next = event.oneOf ? [result?.event] : event.then ?? [];
    if (event.oneOf) console.log(`   chose  : ${paint('33', result?.event)}   (one of: ${event.oneOf.join(', ')})`);
    console.log(`   added  : ${show(event.oneOf ? result?.data : result)}`);
    console.log(`   next   : ${next.length ? next.join(', ') : '(end of this branch)'}`);
    for (const child of next) causedBy.set(child, name);
    return result;
  };
}

// PRETEND: Amazon. Keeps the real "is this marketplace tracked?" rule, then answers from the script.
const ACCOUNT = { status: 'active', customerId: 'A1TRACEDEMO', name: 'Trace Demo', email: 'demo@example.test' };
const AMAZON_OUTCOMES = {
  found: { event: 'site:account-found', data: { account: ACCOUNT } },
  gone: { event: 'site:account-gone' },
  'needs-sign-in': { event: 'site:needs-sign-in', data: { email: ACCOUNT.email } },
  unreachable: { event: 'site:unreachable', data: { reason: 'pretend network failure' } },
};
const MOCKS = {
  async 'site:check-account'({ site }) {
    pretended.add('Amazon account check (scripted answer, no page fetched)');
    if (!(await state.isTracked(site.marketplace))) return { event: 'site:not-tracked' };
    return AMAZON_OUTCOMES[amazonAnswer];
  },
  'site:read-orders'() {
    pretended.add('Amazon orders read (scripted answer, no page fetched)');
    if (amazonAnswer === 'found') return { event: 'site:orders-read', data: { result: { filter: null, orders: [{ id: 'PRETEND-ORDER-1' }] } } };
    return { event: AMAZON_OUTCOMES[amazonAnswer].event === 'site:account-gone' ? 'site:unreachable' : AMAZON_OUTCOMES[amazonAnswer].event, data: AMAZON_OUTCOMES[amazonAnswer].data };
  },
};

// Every event on a side gets a traced wrapper, with a stand-in where no handler exists.
function wrapAll(side, real, mocks = {}) {
  const wrapped = {};
  for (const name of Object.keys(EVENTS).filter((n) => whereIs(n) === side)) {
    const label = mocks[name] ? paint('35', 'PRETENDED (scripted stand-in, see top of tools/trace.mjs)')
      : real[name] ? paint('32', 'real handler')
        : paint('2', 'none, the loop only follows `then`');
    wrapped[name] = traced(name, mocks[name] ?? real[name], label);
  }
  return wrapped;
}

// ── Wiring: the real runner on each side, joined by a direct call (PRETEND WebSocket) ──
const store = createMemoryStore();
const { handlers: serverHandlers } = createHandlers({ store, isConnected: (id) => id === PROFILE });

const serverRunner = createRunner({
  side: 'server',
  handlers: wrapAll('server', serverHandlers),
  passOn: async (name, data) => {
    pretended.add('WebSocket (direct function call, one profile)');
    if (tracing) console.log(paint('2', `   ~ server → browser profile: "${name}" (really: a WebSocket message)`));
    return backgroundRunner.run(name, data);
  },
});
const backgroundRunner = createRunner({
  side: 'background',
  handlers: wrapAll('background', HANDLERS, MOCKS),
  passOn: async (name, data) => {
    pretended.add('WebSocket (direct function call, one profile)');
    if (tracing) console.log(paint('2', `   ~ browser → server: "${name}" (really: a WebSocket message)`));
    // Like server/server.mjs: the sender is the connection, never a field in the message.
    const { to, ...rest } = data;
    return serverRunner.run(name, { ...rest, profile: PROFILE }, { origin: PROFILE });
  },
});

// ── Run ─────────────────────────────────────────────────────────────────────
// These need an account to exist on the server first; set it up silently.
if (['user:requested-orders', 'user:removed-account'].includes(startName)) {
  tracing = false;
  await backgroundRunner.run('user:opened-popup', { site: SITE });
  tracing = true;
  console.log(paint('2', '(setup, not traced: user:opened-popup ran first so the server knows an account with id 1)'));
}

console.log(paint('1', `\nTRACE ${startName}`), show(startData), paint('2', `\nstate=${stateMode} amazon=${amazonAnswer} server=${serverOnline ? 'online' : 'offline'}`));
const reached = await (whereIs(startName) === 'server' ? serverRunner.run(startName, startData, { origin: PROFILE }) : backgroundRunner.run(startName, startData));
rl?.close();

console.log(paint('1', '\n── Events reached, with the data each ended with ──'));
for (const [name, data] of Object.entries(reached)) console.log(`  ${name}  ${show(data, 120)}`);
console.log(paint('1', '\n── Pretend browser storage afterwards ──'));
console.log('  local  ', show(local.items, 400));
console.log('  session', show(session.items, 400));
console.log(paint('1', '\n── Pretend server store afterwards ──'));
console.log('  accounts', show(await store.listAccounts(), 400));
console.log(paint('33', '\n── DOUBLE-CHECK IN A REAL BROWSER (pretended in this run) ──'));
for (const item of pretended) console.log(`  • ${item}`);
