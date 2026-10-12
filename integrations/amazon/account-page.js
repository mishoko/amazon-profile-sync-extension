// Reader for Amazon pages fetched by checkAccount (see background/page-tools.js):
// the orders page (who is signed in) and the "confirm your password" page
// (the account's email). Runs in the hidden page; returns plain data.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const EMAIL_ONLY = new RegExp(`^${EMAIL.source}$`);
const CUSTOMER_ID = /["']?(?:obfuscatedCustomerId|customerId|customerID)["']?\s*[:=]\s*["'](A[A-Z0-9]{9,20})["']/;

const clean = (text) => text?.replace(/\s+/g, ' ').trim() || null;

function visibleText(root) {
  const copy = root.cloneNode(true);
  for (const hidden of copy.querySelectorAll('script, style, noscript, template')) hidden.remove();
  return copy.textContent;
}

// Amazon's sign-in page shows the remembered account's email: as the value
// of the email field, inside the sign-in form, or as text above it. Script
// and style contents are excluded, so no address from page code is taken.
export function parseSignInEmail(document) {
  const field = [...document.querySelectorAll('input[name="email"], input[type="email"]')]
    .map((input) => input.getAttribute('value')?.trim())
    .find((value) => value && EMAIL_ONLY.test(value));
  if (field) return field;
  const form = document.querySelector('form[name="signIn"]');
  return (form && visibleText(form).match(EMAIL)?.[0]) ?? (document.body && visibleText(document.body).match(EMAIL)?.[0]) ?? null;
}

export function read(document, location) {
  const greeting = clean(document.querySelector('#nav-link-accountList-nav-line-1')?.textContent);
  return {
    isSignIn: location.pathname.startsWith('/ap/'),
    robotCheck: Boolean(document.querySelector('form[action*="validateCaptcha"]')),
    customerId: document.documentElement.innerHTML.match(CUSTOMER_ID)?.[1] ?? null,
    name: greeting?.includes(',') ? clean(greeting.slice(greeting.indexOf(',') + 1)) : null,
    email: parseSignInEmail(document),
  };
}
