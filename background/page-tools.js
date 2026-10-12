// How an integration reads a marketplace page. Both functions take the page's
// URL and a reader: a module in the integration's folder that exports
// read(document, location) and returns plain data.
//
//   readFetchedPage(url, reader)   the page as the server sends it (fetch +
//                                  parse); for pages whose data is in the HTML.
//   readRenderedPage(url, reader)  the page after its own scripts ran, in an
//                                  invisible frame; for pages that build their
//                                  data in the browser (Amazon's orders).
//
// Both run in the hidden page (background/hidden-page.html), an offscreen
// document created on first use and closed when idle. An integration that
// never calls them never creates it. A site that can't be reached (network
// error, error status, too slow) throws SiteUnreachable; anything else is a
// bug and throws a plain Error.
import { CONFIG } from '../core/config.js';

const HIDDEN_PAGE = 'background/hidden-page.html';
const READER = /^integrations\/[a-z0-9-]+\/[a-z0-9-]+\.js$/;

export class SiteUnreachable extends Error {}

export const readFetchedPage = (url, reader) => ask('fetch', url, reader);
export const readRenderedPage = (url, reader) => ask('render', url, reader);

let busy = 0;
let closeTimer = null;
let creating = null;

async function ask(mode, url, reader) {
  if (!READER.test(reader)) throw new Error(`Reader "${reader}" must be integrations/<name>/<file>.js`);
  busy += 1;
  clearTimeout(closeTimer);
  try {
    await openHiddenPage();
    const answer = await chrome.runtime.sendMessage({ kind: 'read-page', mode, url, reader });
    if (!answer) throw new Error('The hidden page did not answer.');
    if (!answer.ok) throw answer.unreachable ? new SiteUnreachable(answer.error) : new Error(answer.error);
    return answer.data;
  } finally {
    busy -= 1;
    if (!busy) closeTimer = setTimeout(closeHiddenPage, CONFIG.hiddenPageIdleMs);
  }
}

const isOpen = async () => (await chrome.runtime.getContexts({
  contextTypes: ['OFFSCREEN_DOCUMENT'],
  documentUrls: [chrome.runtime.getURL(HIDDEN_PAGE)],
})).length > 0;

async function openHiddenPage() {
  if (await isOpen()) return;
  creating ??= chrome.offscreen.createDocument({
    url: HIDDEN_PAGE,
    reasons: ['DOM_PARSER', 'IFRAME_SCRIPTING'],
    justification: 'Read the signed-in marketplace account and its orders from marketplace pages, without showing any window.',
  }).finally(() => { creating = null; });
  await creating;
}

async function closeHiddenPage() {
  if (busy || !(await isOpen())) return;
  await chrome.offscreen.closeDocument();
}
