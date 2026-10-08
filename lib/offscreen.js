// The extension's one offscreen document (background/offscreen.html): a hidden
// page for work that needs a document but must never be visible:
// - DOM_PARSER: parsing Amazon pages for the background sign-in check;
// - IFRAME_SCRIPTING: loading Amazon's orders page in an invisible frame, so
//   Amazon's own scripts render (decrypt) the orders, which are then read.
// Chrome allows one offscreen document per extension; any context may create
// it, so a concurrent creation elsewhere is expected and fine.
const OFFSCREEN_PATH = 'background/offscreen.html';

let creating = null;

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  if (existing.length) return;
  creating ??= chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['DOM_PARSER', 'IFRAME_SCRIPTING'],
    justification: 'Read the signed-in Amazon account and its orders from Amazon pages, without showing any window.',
  }).catch((error) => {
    if (!/single offscreen document/i.test(error.message)) throw error;
  }).finally(() => { creating = null; });
  await creating;
}

// Sends one request to the offscreen document and returns its result.
export async function askOffscreen(type, payload = {}) {
  await ensureOffscreenDocument();
  const answer = await chrome.runtime.sendMessage({ target: 'offscreen', type, ...payload });
  if (!answer) throw new Error('The background page did not answer.');
  if (answer.error) throw new Error(answer.error);
  return answer.result;
}
