// Injected (read-only, in the extension's isolated world) into an Amazon orders
// page that Waybill opened in its own window. Amazon sends each order's details
// encrypted (".csd-encrypted-sensitive") and its own scripts decrypt them in
// the browser, so this waits until every order card shows an order number,
// then reads the cards. Defines a function; the caller invokes it.
globalThis.waybillReadOrders = async function waybillReadOrders() {
  const ORDER_ID = /(?<![\d-])(?:\d{3}|D01)-\d{7}-\d{7}(?![\d-])/;
  const DECRYPT_TIMEOUT_MS = 20000;
  const clean = (text) => text?.replace(/\s+/g, ' ').trim() || null;
  const cards = () => [...document.querySelectorAll('.order-card')];
  const decrypted = () => cards().every((card) => ORDER_ID.test(card.textContent));

  const deadline = Date.now() + DECRYPT_TIMEOUT_MS;
  while (!decrypted() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));

  function headerFields(card) {
    const fields = {};
    for (const label of card.querySelectorAll('.a-text-caps, .a-size-mini')) {
      const column = label.closest('li, .a-column');
      if (!column) continue;
      const name = (clean(label.textContent) ?? '').toLowerCase();
      const value = clean(column.textContent.replace(label.textContent, ''));
      if (/placed|order date/.test(name)) fields.placed ??= value;
      else if (/total/.test(name)) fields.total ??= value;
    }
    return fields;
  }

  function items(card) {
    const found = new Map();
    for (const link of card.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]')) {
      const title = clean(link.textContent);
      if (!title || found.has(title)) continue;
      const image = link.closest('.a-fixed-left-grid, .item-box, .yohtmlc-item, .a-row')?.querySelector('img')
        ?? card.querySelector(`a[href="${CSS.escape(link.getAttribute('href'))}"] img`);
      found.set(title, { title, url: link.href, image: image?.currentSrc || image?.src || null });
    }
    return [...found.values()];
  }

  const STATUS_SELECTORS = ['.delivery-box__primary-text', '.yohtmlc-shipment-status-primaryText', '.js-shipment-info-container .a-text-bold', '.shipment-top-row .a-text-bold'];
  const orders = cards().map((card) => ({
    id: (card.querySelector('.yohtmlc-order-id')?.textContent ?? card.textContent).match(ORDER_ID)?.[0] ?? null,
    ...headerFields(card),
    status: STATUS_SELECTORS.map((selector) => clean(card.querySelector(selector)?.textContent)).find(Boolean) ?? null,
    items: items(card),
  })).filter((order) => order.id);

  const select = document.querySelector('select[name="timeFilter"]');
  return {
    cardCount: cards().length,
    decrypted: decrypted(),
    orders,
    filters: [...(select?.options ?? [])].map((option) => ({ value: option.value, label: clean(option.textContent) })),
    filter: select?.value ?? null,
    hasNextPage: !!document.querySelector('.a-pagination .a-last:not(.a-disabled) a'),
  };
};
