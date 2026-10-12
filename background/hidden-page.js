// The hidden page: an offscreen document that reads marketplace pages for
// background/page-tools.js and is never shown. Offscreen documents get only
// chrome.runtime, so it reads no storage; it gets a URL and a reader and
// answers with the reader's data.
//   fetch:  fetch the page with the browser's own sign-in, parse it, read it.
//   render: load it in an invisible frame, where background/frame-bridge.js
//           runs the reader after the page's own scripts, and reports back.
import { CONFIG } from '../core/config.js';

const FRAME_PREFIX = 'waybill-frame:';
const pendingFrames = new Map(); // frame id -> settle(report)

const unreachable = (message) => Object.assign(new Error(message), { unreachable: true });
const loadReader = (reader) => import(chrome.runtime.getURL(reader));

async function readFetched(url, reader) {
  let response;
  try {
    response = await fetch(url, { credentials: 'include' });
  } catch (error) {
    throw unreachable(`${new URL(url).hostname} could not be reached (${error.message})`);
  }
  if (!response.ok) throw unreachable(`${new URL(url).hostname} answered ${response.status}`);
  const document = new DOMParser().parseFromString(await response.text(), 'text/html');
  return (await loadReader(reader)).read(document, new URL(response.url));
}

function readRendered(url, reader) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const frame = document.createElement('iframe');
    frame.name = FRAME_PREFIX + JSON.stringify({ id, reader });
    frame.width = '1280';
    frame.height = '900';
    const settle = (outcome) => {
      clearTimeout(timer);
      pendingFrames.delete(id);
      frame.remove();
      outcome();
    };
    const timer = setTimeout(() => settle(() => reject(unreachable(`${new URL(url).hostname} took too long to load`))), CONFIG.framePageTimeoutMs);
    pendingFrames.set(id, (report) => settle(() => (report.ok ? resolve(report.data) : reject(new Error(report.error)))));
    frame.src = url;
    document.body.append(frame);
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.kind === 'frame-read') {
    pendingFrames.get(message.id)?.(message);
    return false;
  }
  if (message?.kind !== 'read-page') return false;
  const work = message.mode === 'fetch' ? readFetched(message.url, message.reader)
    : message.mode === 'render' ? readRendered(message.url, message.reader)
    : Promise.reject(new Error(`Unknown read mode "${message.mode}"`));
  work.then(
    (data) => sendResponse({ ok: true, data }),
    (error) => sendResponse({ ok: false, unreachable: error.unreachable === true, error: error.message }),
  );
  return true;
});
