// Offscreen document: hidden work for the service worker and the Activity
// page (see lib/offscreen.js).
// - 'read-account': which Amazon account is signed in (needs DOMParser).
// - 'read-orders-page': loads one Amazon orders page in an invisible iframe,
//   where content/orders-frame.js reads it once Amazon's scripts have
//   rendered the orders, and posts the result back here.
import { readAccount } from '../lib/amazon.js';

const PAGE_TIMEOUT_MS = 60_000; // loading (≤ 30 s) plus Amazon's rendering (≤ 20 s)
const pendingFrames = new Map(); // frame name -> settle(result)

function readOrdersPage(url) {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.name = `waybill-orders-${crypto.randomUUID()}`;
    frame.width = '1280';
    frame.height = '900';
    const settle = (outcome) => {
      clearTimeout(timer);
      pendingFrames.delete(frame.name);
      frame.remove();
      outcome();
    };
    const timer = setTimeout(() => settle(() => reject(new Error('Amazon took too long to load.'))), PAGE_TIMEOUT_MS);
    pendingFrames.set(frame.name, (result) => settle(() => resolve(result)));
    frame.src = url;
    document.body.append(frame);
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.type === 'orders-frame-result') {
    pendingFrames.get(message.frameName)?.(message.result);
    return false;
  }
  if (message?.target !== 'offscreen') return false;
  const work = message.type === 'read-account' ? readAccount(message.domain, message.known)
    : message.type === 'read-orders-page' ? readOrdersPage(message.url)
    : null;
  if (!work) return false;
  work.then((result) => sendResponse({ result }), (error) => sendResponse({ error: error.message }));
  return true;
});
