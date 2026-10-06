// There is no account service yet, so a real session never exists and the
// popup always shows the signed-out view. Unpacked development builds can
// render the signed-in view from a local fixture: popup.html?preview=signed-in
const isDevelopmentBuild = !('update_url' in chrome.runtime.getManifest());
const previewName = new URLSearchParams(location.search).get('preview');

async function loadSession() {
  if (!isDevelopmentBuild || !previewName) return null;
  const { previewSessions } = await import('../dev/preview-sessions.js');
  return previewSessions[previewName] ?? null;
}

function showView(name) {
  for (const view of document.querySelectorAll('[data-view]')) {
    view.hidden = view.dataset.view !== name;
  }
}

function renderSignedIn(session) {
  const email = document.querySelector('[data-account-email]');
  email.textContent = session.email;
  email.hidden = false;
  showView('signed-in');
}

function renderSignedOut() {
  document.querySelector('[data-account-email]').hidden = true;
  showView('signed-out');
}

// Local UI state only: nothing here connects, enables, or saves anything.
document.addEventListener('click', (event) => {
  const toggle = event.target.closest('.switch');
  if (toggle) {
    toggle.setAttribute('aria-checked', String(toggle.getAttribute('aria-checked') !== 'true'));
    return;
  }

  const chevron = event.target.closest('.chevron:not([aria-disabled="true"])');
  if (chevron) {
    const expanded = chevron.getAttribute('aria-expanded') !== 'true';
    chevron.setAttribute('aria-expanded', String(expanded));
    document.getElementById(chevron.getAttribute('aria-controls')).hidden = !expanded;
    return;
  }

  if (event.target.closest('[data-log-out]')) renderSignedOut();
});

const session = await loadSession();
if (session) renderSignedIn(session);
else renderSignedOut();
