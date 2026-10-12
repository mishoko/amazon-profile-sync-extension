// Fail loud in a view: an error is logged and shown in the page's
// [data-error] line, never swallowed.
export function showError(error) {
  console.error('[waybill]', error);
  const line = document.querySelector('[data-error]');
  if (!line) return;
  line.textContent = error?.message ?? String(error);
  line.hidden = false;
}
