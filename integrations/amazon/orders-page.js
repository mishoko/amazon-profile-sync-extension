// Reader for Amazon's orders page, run on the rendered page inside the hidden
// frame (see background/page-tools.js). Amazon sends each order's details
// encrypted (".csd-encrypted-sensitive") and its own scripts decrypt them in
// the browser, so this waits until every order card shows an order number,
// then reads the cards.
const ORDER_ID = /(?<![\d-])(?:\d{3}|D01)-\d{7}-\d{7}(?![\d-])/;
const DECRYPT_TIMEOUT_MS = 20_000;

// Order header columns: a small label above each value. Labels are matched in
// the marketplace languages Waybill knows; otherwise Amazon's fixed column
// order (date placed, then total) is used, which every marketplace shares,
// including the Arabic ones.
const PLACED = /placed|order date|bestellung aufgegeben|bestelldatum|commande (?:effectuée|passée)|ordine effettuato|pedido realizado|fecha del pedido/i;
const TOTAL = /total|summe|gesamt|totale|importe/i;
const STATUS_SELECTORS = ['.delivery-box__primary-text', '.yohtmlc-shipment-status-primaryText', '.js-shipment-info-container .a-text-bold', '.shipment-top-row .a-text-bold'];

const clean = (text) => text?.replace(/\s+/g, ' ').trim() || null;

function headerFields(card) {
  const columns = [];
  for (const label of card.querySelectorAll('.a-text-caps, .a-size-mini')) {
    const column = label.closest('li, .a-column');
    if (!column || columns.some((known) => known.column === column)) continue;
    columns.push({ column, name: clean(label.textContent) ?? '', value: clean(column.textContent.replace(label.textContent, '')) });
  }
  const named = (pattern) => columns.find(({ name }) => pattern.test(name))?.value;
  return {
    placed: named(PLACED) ?? columns[0]?.value ?? null,
    total: named(TOTAL) ?? columns[1]?.value ?? null,
  };
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

// { status: 'needs-sign-in' } | { status: 'robot-check' }
// | { status: 'active', cardCount, orders, filters, filter, hasNextPage }
export async function read(document, location) {
  if (location.pathname.startsWith('/ap/')) return { status: 'needs-sign-in' };
  if (document.querySelector('form[action*="validateCaptcha"]')) return { status: 'robot-check' };

  const cards = () => [...document.querySelectorAll('.order-card')];
  const decrypted = () => cards().every((card) => ORDER_ID.test(card.textContent));
  const deadline = Date.now() + DECRYPT_TIMEOUT_MS;
  while (!decrypted() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));

  const orders = cards().map((card) => ({
    id: (card.querySelector('.yohtmlc-order-id')?.textContent ?? card.textContent).match(ORDER_ID)?.[0] ?? null,
    ...headerFields(card),
    status: STATUS_SELECTORS.map((selector) => clean(card.querySelector(selector)?.textContent)).find(Boolean) ?? null,
    items: items(card),
  })).filter((order) => order.id);

  const select = document.querySelector('select[name="timeFilter"]');
  return {
    status: 'active',
    cardCount: cards().length,
    orders,
    filters: [...(select?.options ?? [])].map((option) => ({ value: option.value, label: clean(option.textContent) })),
    filter: select?.value ?? null,
    hasNextPage: Boolean(document.querySelector('.a-pagination .a-last:not(.a-disabled) a')),
  };
}
