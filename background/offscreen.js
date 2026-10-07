// Offscreen document (reason: DOM_PARSER). The service worker has no DOMParser,
// so it asks this page to read which Amazon account is signed in.
import { readAccount } from '../lib/amazon.js';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen' || message.type !== 'read-account' || sender.id !== chrome.runtime.id) return false;
  readAccount(message.domain, message.known)
    .then((account) => sendResponse({ account }), (error) => sendResponse({ error: error.message }));
  return true;
});
