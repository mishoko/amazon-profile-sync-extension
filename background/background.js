// The extension's background: the hub every event passes through.
// Everything that can wake it is registered here, at load, so no wake-up is
// missed (Chrome stops it after ~30 s without activity and starts it again
// for the next event):
//   messages from the popup and Activity page   core/bus.js
//   marketplace pages the user loads            background/page-watcher.js
//   the reconnect alarm, every minute           below
// It keeps nothing in memory that must outlive a stop; that is in
// core/state.js (session storage).
import { CONFIG } from '../core/config.js';
import { whereIs } from '../core/events.js';
import { serve, emit } from '../core/bus.js';
import * as state from '../core/state.js';
import { HANDLERS } from './handlers.js';
import { watchPages } from './page-watcher.js';
import { startServerLink, connect, runOnServer } from './server-link.js';

serve({
  handlers: HANDLERS,
  passOn: (name, data) => {
    if (whereIs(name) !== 'server') throw new Error(`Nowhere to run "${name}"`);
    return runOnServer(name, data);
  },
});
watchPages();

const RECONNECT_ALARM = 'reconnect';
chrome.alarms.onAlarm.addListener(({ name }) => { if (name === RECONNECT_ALARM) connect(); });
chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: CONFIG.reconnectEveryMinutes });

// A new start has no connection yet, whatever the last one left in storage.
state.setServerOffline().then(() => startServerLink(emit));
