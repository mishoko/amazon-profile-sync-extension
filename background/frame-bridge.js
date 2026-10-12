// Content script for marketplace pages that Waybill reads rendered. It acts
// only inside the hidden page's invisible frame; on pages the user browses it
// returns at once and does nothing. In the frame, it loads the integration's
// reader module (named by the hidden page in the frame's name), runs it on
// the rendered page and reports the result to the hidden page.
// Content scripts can't be modules, so this file is a plain script that
// imports the reader module.
(() => {
  const PREFIX = 'waybill-frame:';
  const READER = /^integrations\/[a-z0-9-]+\/[a-z0-9-]+\.js$/;
  const inOwnFrame = window !== window.top
    && location.ancestorOrigins?.[0] === `chrome-extension://${chrome.runtime.id}`
    && window.name.startsWith(PREFIX);
  if (!inOwnFrame) return;

  const { id, reader } = JSON.parse(window.name.slice(PREFIX.length));
  const report = (outcome) => chrome.runtime.sendMessage({ kind: 'frame-read', id, ...outcome });
  if (!READER.test(reader)) {
    report({ ok: false, error: `Refused reader "${reader}"` });
    return;
  }
  import(chrome.runtime.getURL(reader))
    .then((module) => module.read(document, location))
    .then((data) => report({ ok: true, data }), (error) => report({ ok: false, error: error.message }));
})();
