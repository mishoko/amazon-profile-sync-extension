// The toolbar popup. Like every view, it only emits user: events and draws
// what storage holds; the background does the work.
import { emit } from '../../core/bus.js';
import * as state from '../../core/state.js';
import { showError } from '../shared/errors.js';
import { mountMarketplaces } from './marketplaces.js';

// There is no account service yet, so a real session never exists and store
// builds always show the signed-out view. Unpacked development builds simulate
// sign-in with a local fixture: "Log in" waits briefly and then shows the
// signed-in view until "Log out". popup.html?preview=<name> forces a fixture.
const isDevelopmentBuild = !('update_url' in chrome.runtime.getManifest());
const previewName = new URLSearchParams(location.search).get('preview');
const SIMULATED_SIGN_IN_MS = 2500;

async function loadSession(requested = null) {
  const name = requested ?? previewName ?? await state.sessionName();
  if (!isDevelopmentBuild || !name) return null;
  const { previewSessions } = await import('../../dev/preview-sessions.js');
  return previewSessions[name] ?? null;
}

async function simulateSignIn(button) {
  const label = button.querySelector('[data-log-in-label]');
  button.setAttribute('aria-busy', 'true');
  button.setAttribute('aria-disabled', 'true');
  label.textContent = 'Logging in…';
  try {
    await new Promise((resolve) => setTimeout(resolve, SIMULATED_SIGN_IN_MS));
    await emit('user:signed-in', { name: 'signed-in' });
    renderSignedIn(await loadSession('signed-in'));
  } finally {
    button.removeAttribute('aria-busy');
    button.removeAttribute('aria-disabled');
    label.textContent = 'Log in';
  }
}

function showView(name) {
  for (const view of document.querySelectorAll('[data-view]')) view.hidden = view.dataset.view !== name;
}

let marketplacesMounted = false;

function renderSignedIn(session) {
  const email = document.querySelector('[data-account-email]');
  email.textContent = session.email;
  email.hidden = false;
  showView('signed-in');
  if (!marketplacesMounted) {
    marketplacesMounted = true;
    mountMarketplaces(document.querySelector('[data-view="signed-in"]')).catch(showError);
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
    if (!logIn.hasAttribute('aria-busy')) simulateSignIn(logIn).catch(showError);
    return;
  }
  if (event.target.closest('[data-log-out]')) {
    renderSignedOut();
    emit('user:signed-out').catch(showError);
  }
});

if (isDevelopmentBuild) {
  document.querySelector('#login-note').textContent = 'Development build: simulated sign-in, no account is used';
}

const session = await loadSession();
if (session) renderSignedIn(session);
else renderSignedOut();
