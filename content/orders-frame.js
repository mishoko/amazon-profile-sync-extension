// Declared for Amazon's orders, sign-in and error pages, but acts only inside
// Waybill's invisible orders frame: an iframe of this extension's offscreen
// document (background/offscreen.js). On pages the user browses it returns
// at once and does nothing. Reports the page's orders (read by
// content/read-orders.js, loaded just before) back to the offscreen document.
(() => {
  const inOwnFrame = window !== window.top
    && location.ancestorOrigins?.[0] === `chrome-extension://${chrome.runtime.id}`
    && window.name.startsWith('waybill-orders-');
  if (!inOwnFrame) return;

  const report = (result) => chrome.runtime.sendMessage({ type: 'orders-frame-result', frameName: window.name, result });
  if (location.pathname.startsWith('/ap/')) {
    report({ status: 'needs-sign-in' });
  } else if (document.querySelector('form[action*="validateCaptcha"]')) {
    report({ status: 'error', error: 'Amazon asked for a robot check.' });
  } else {
    globalThis.waybillReadOrders().then(
      (page) => report({ status: 'active', ...page }),
      (error) => report({ status: 'error', error: error.message }),
    );
  }
})();
