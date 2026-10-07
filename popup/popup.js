import { mountMarketplaces } from './marketplaces.js';

// There is no account service yet, so a real session never exists and store
// builds always show the signed-out view. Unpacked development builds simulate
// sign-in with a local fixture: "Log in" waits briefly and then shows the
// signed-in view until "Log out". popup.html?preview=<name> forces a fixture.
const isDevelopmentBuild = !('update_url' in chrome.runtime.getManifest());
const previewName = new URLSearchParams(location.search).get('preview');
const SIMULATED_SESSION_KEY = 'waybill.simulatedSession';
const SIMULATED_SIGN_IN_MS = 2500;

function storedPreviewName() {
  try { return localStorage.getItem(SIMULATED_SESSION_KEY); } catch { return null; }
}

function storePreviewName(name) {
  try {
    if (name) localStorage.setItem(SIMULATED_SESSION_KEY, name);
    else localStorage.removeItem(SIMULATED_SESSION_KEY);
  } catch {}
}

async function loadSession(name = previewName ?? storedPreviewName()) {
  if (!isDevelopmentBuild || !name) return null;
  const { previewSessions } = await import('../dev/preview-sessions.js');
  return previewSessions[name] ?? null;
}

async function simulateSignIn(button) {
  button.setAttribute('aria-busy', 'true');
  button.setAttribute('aria-disabled', 'true');
  button.querySelector('[data-log-in-label]').textContent = 'Logging in…';
  await new Promise((resolve) => setTimeout(resolve, SIMULATED_SIGN_IN_MS));
  storePreviewName('signed-in');
  renderSignedIn(await loadSession('signed-in'));
  button.removeAttribute('aria-busy');
  button.removeAttribute('aria-disabled');
  button.querySelector('[data-log-in-label]').textContent = 'Log in';
}

function showView(name) {
  for (const view of document.querySelectorAll('[data-view]')) {
    view.hidden = view.dataset.view !== name;
  }
}

let marketplacesMounted = false;

function renderSignedIn(session) {
  const email = document.querySelector('[data-account-email]');
  email.textContent = session.email;
  email.hidden = false;
  showView('signed-in');
  if (!marketplacesMounted) {
    marketplacesMounted = true;
    mountMarketplaces(document.querySelector('[data-view="signed-in"]'));
  }
}

function renderSignedOut() {
  document.querySelector('[data-account-email]').hidden = true;
  showView('signed-out');
}

document.addEventListener('click', (event) => {
  const logIn = event.target.closest('[data-log-in]');
  if (logIn && isDevelopmentBuild) {
    event.preventDefault();
    if (!logIn.hasAttribute('aria-busy')) simulateSignIn(logIn);
    return;
  }

  if (event.target.closest('[data-log-out]')) {
    storePreviewName(null);
    renderSignedOut();
  }
});

if (isDevelopmentBuild) {
  document.querySelector('#login-note').textContent = 'Development build: simulated sign-in, no account is used';
}

const session = await loadSession();
if (session) renderSignedIn(session);
else renderSignedOut();
