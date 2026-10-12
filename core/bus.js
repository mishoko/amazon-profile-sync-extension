// emit(): the only way Waybill's parts talk to each other.
//
// In the popup and the Activity page, emit('user:…') hands the event to the
// background (a runtime message, which also wakes it) and resolves with every
// event the chain reached, with its data. In the background, emit() runs the
// chain directly. The background hands server events to the server itself
// (background/server-link.js).
import { CONFIG } from './config.js';
import { createRunner } from './chain.js';

let runner = null;

export async function emit(name, data = {}) {
  if (runner) return runner.run(name, data);
  if (!name.startsWith('user:')) throw new Error(`Pages may only emit user: events, not "${name}"`);
  let answer;
  try {
    answer = await chrome.runtime.sendMessage({ kind: 'run', name, data });
  } catch (error) {
    throw new Error(`Waybill's background stopped before answering "${name}". Try again. (${error.message})`);
  }
  if (!answer) throw new Error(`Nothing answered "${name}".`);
  if (!answer.ok) throw new Error(answer.error);
  return answer.reached;
}

// In the background only: run its events, and answer the pages' emit() calls.
// Call it at the top level of the background script, so a page's message is
// heard even when it is what woke the background up.
export function serve({ handlers, passOn }) {
  runner = createRunner({ side: 'background', handlers, passOn, log: (name) => console.debug(`[waybill] ${name}`) });
  const run = runner.run;
  let busy = 0;
  let keepAlive = null;
  // Chrome stops an idle background after ~30 s; a chain may wait longer
  // (Amazon, the server). Any extension API call counts as activity.
  runner.run = async (...args) => {
    busy += 1;
    keepAlive ??= setInterval(() => chrome.runtime.getPlatformInfo(), CONFIG.keepAliveEveryMs);
    try {
      return await run(...args);
    } finally {
      busy -= 1;
      if (!busy) {
        clearInterval(keepAlive);
        keepAlive = null;
      }
    }
  };
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.kind !== 'run' || sender.id !== chrome.runtime.id) return false;
    if (typeof message.name !== 'string' || !message.name.startsWith('user:')) {
      sendResponse({ ok: false, error: `Pages may only emit user: events, not "${message.name}"` });
      return false;
    }
    runner.run(message.name, message.data ?? {}).then(
      (reached) => sendResponse({ ok: true, reached }),
      (error) => {
        console.error(`[waybill] ${message.name} failed:`, error);
        sendResponse({ ok: false, error: error.message });
      },
    );
    return true;
  });
}
