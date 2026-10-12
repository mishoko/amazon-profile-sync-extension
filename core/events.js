// Everything Waybill does, as 'who:what'.
//
//   Past tense  something happened (the user clicked, a site answered).
//   Imperative  work: exactly one handler function does it.
//   then:       all of these follow, in order.
//   oneOf:      exactly one follows; this event's handler returns which.
//
// Where an event runs follows from the part before the colon: server: and
// db: run on the server, everything else in the extension's background
// (background/handlers.js). The popup and Activity page only start user:
// events and redraw from storage. `node tools/event-map.mjs <event>` prints
// what leads to an event and everything it causes.
export const EVENTS = {
  // ── Waybill sign-in (popup) ─────────────────────────────────────────────
  'user:signed-in':               { then: ['storage:save-session'] },
  'user:signed-out':              { then: ['storage:clear-session'] },
  'storage:save-session':         { then: ['storage:accounts-changed'] },
  'storage:clear-session':        { then: ['storage:accounts-changed'] },

  // ── Marketplace cards (popup) ───────────────────────────────────────────
  'user:opened-popup':            { then: ['site:check-account'] },
  'user:turned-on':               { then: ['storage:save-settings', 'site:check-account'] },
  'user:turned-off':              { then: ['storage:save-settings', 'storage:accounts-changed'] },
  'user:selected-region':         { then: ['storage:save-settings', 'site:check-account'] },
  'user:changed-settings':        { then: ['storage:save-settings'] }, // expand a card, the AliExpress switch
  'storage:save-settings':        { then: [] },

  // ── Noticed while the user browses a marketplace (background/page-watcher.js)
  'site:signed-in':               { then: ['site:check-account'] },
  'site:signed-out':              { then: ['storage:forget-account'] },
  'site:visited':                 { then: ['site:check-account'] }, // at most every CONFIG.recheckAfterMs

  // ── Who is signed in to the marketplace ─────────────────────────────────
  'site:check-account':           { oneOf: ['site:account-found', 'site:account-gone', 'site:needs-sign-in', 'site:unreachable', 'site:not-tracked'] },
  'site:account-found':           { then: ['storage:save-account'] },
  'site:account-gone':            { then: ['storage:forget-account'] },
  'site:needs-sign-in':           { then: ['storage:mark-needs-sign-in'] },
  'site:unreachable':             { then: [] }, // the last known state stays; whoever asked sees the reason
  'site:not-tracked':             { then: [] }, // signed out of Waybill, or this marketplace is off
  'storage:save-account':         { then: ['storage:accounts-changed'] },
  'storage:forget-account':       { then: ['storage:accounts-changed'] },
  'storage:mark-needs-sign-in':   { then: ['storage:accounts-changed'] },
  'storage:accounts-changed':     { then: ['storage:read-shared-accounts'] },
  'storage:read-shared-accounts': { then: ['db:replace-profile-accounts'] },

  // ── Accounts of every browser profile (server) ──────────────────────────
  'server:profile-connected':     { then: ['db:record-profile', 'storage:read-shared-accounts'] },
  'server:profile-disconnected':  { then: ['db:release-profile'] },
  'db:record-profile':            { then: ['server:send-all-accounts'] },
  'db:release-profile':           { then: ['server:send-all-accounts'] },
  'db:replace-profile-accounts':  { then: ['server:send-all-accounts'] },
  'server:send-all-accounts':     { then: ['storage:save-all-accounts'] }, // to every connected profile
  'storage:save-all-accounts':    { then: [] },
  'server:offline':               { then: [] }, // reached in place of any server event while the server can't be reached

  // ── Removing an account (Activity page) ─────────────────────────────────
  'user:removed-account':         { then: ['db:remove-account'] },
  'db:remove-account':            { oneOf: ['db:account-removed', 'db:account-not-found'] },
  'db:account-removed':           { then: ['server:send-all-accounts'] },
  'db:account-not-found':         { then: [] },

  // ── Orders (Activity page) ──────────────────────────────────────────────
  'user:requested-orders':        { oneOf: ['server:find-profile', 'site:read-orders'] }, // no server → read here
  'server:find-profile':          { oneOf: ['site:read-orders', 'server:account-offline', 'db:account-not-found'] },
  'site:read-orders':             { oneOf: ['site:orders-read', 'site:needs-sign-in', 'site:unreachable'] },
  'site:orders-read':             { then: [] }, // the orders go back to whoever asked
  'server:account-offline':       { then: [] },
};

const SERVER_PARTS = ['server', 'db'];

// 'server' or 'background'.
export const whereIs = (name) => (SERVER_PARTS.includes(name.split(':')[0]) ? 'server' : 'background');

// Throws on the first mistake in the table; run at every start (background,
// server) and by tools/check-extension.mjs.
export function checkEvents(events = EVENTS) {
  const parts = ['user', 'storage', 'site', ...SERVER_PARTS];
  for (const [name, event] of Object.entries(events)) {
    if (!/^[a-z]+:[a-z-]+$/.test(name) || !parts.includes(name.split(':')[0])) throw new Error(`Event "${name}" must be '<${parts.join('|')}>:<what>'`);
    if (('then' in event) === ('oneOf' in event)) throw new Error(`Event "${name}" needs exactly one of then / oneOf`);
    const next = event.then ?? event.oneOf;
    if (!Array.isArray(next) || ('oneOf' in event && next.length < 2)) throw new Error(`Event "${name}": then is a list, oneOf a list of two or more`);
    for (const target of next) if (!(target in events)) throw new Error(`Event "${name}" leads to unknown event "${target}"`);
  }
  const visiting = new Set();
  const done = new Set();
  const visit = (name, path) => {
    if (done.has(name)) return;
    if (visiting.has(name)) throw new Error(`Events loop: ${[...path, name].join(' → ')}`);
    visiting.add(name);
    for (const target of events[name].then ?? events[name].oneOf) visit(target, [...path, name]);
    visiting.delete(name);
    done.add(name);
  };
  for (const name of Object.keys(events)) visit(name, []);
}
