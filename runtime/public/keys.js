import { API } from './constants.js';
import { renderMenu } from './menu.js';

const token = renderMenu();
const list = document.getElementById('key-list');
const msg = document.getElementById('msg');
const oauthProvider = document.getElementById('oauth-provider');
const oauthStatus = document.getElementById('oauth-status');
const oauthDialog = document.getElementById('oauth-dialog');

function askOAuthPrompt(prompt) {
  const title = document.getElementById('oauth-dialog-title');
  const message = document.getElementById('oauth-dialog-message');
  const select = document.getElementById('oauth-dialog-select');
  const input = document.getElementById('oauth-dialog-input');
  const submit = document.getElementById('oauth-dialog-submit');
  const cancel = document.getElementById('oauth-dialog-cancel');
  title.textContent = prompt.type === 'select' ? 'Choose sign-in method' : 'Sign in';
  message.textContent = prompt.message || 'Enter the requested value.';
  select.innerHTML = '';
  const choices = prompt.options ?? [];
  select.classList.toggle('hidden', !choices.length);
  input.classList.toggle('hidden', Boolean(choices.length));
  if (choices.length) {
    for (const choice of choices) {
      const option = document.createElement('option');
      option.value = choice.id;
      option.textContent = choice.label;
      select.append(option);
    }
  } else {
    input.value = '';
    input.placeholder = prompt.placeholder || '';
  }
  return new Promise((resolve) => {
    const finish = (value) => { oauthDialog.close(); resolve(value); };
    submit.onclick = () => finish(choices.length ? select.value : input.value);
    cancel.onclick = () => finish('');
    oauthDialog.oncancel = (event) => { event.preventDefault(); finish(''); };
    oauthDialog.showModal();
    if (!choices.length) input.focus();
  });
}

async function load() {
  const r = await fetch(`${API.providers}?token=${encodeURIComponent(token)}`);
  const j = await r.json().catch(() => ({ providers: [] }));
  list.innerHTML = '';
  if (!j.providers?.length) {
    list.innerHTML = '<div class="key-empty">no credentials saved</div>';
    return;
  }
  for (const p of j.providers) {
    const row = document.createElement('div');
    row.className = 'key-row';
    const name = document.createElement('span');
    name.className = 'key-name';
    name.textContent = p.provider;
    const hint = document.createElement('span');
    hint.className = 'key-hint';
    hint.textContent = p.keyHint ?? p.type;
    const del = document.createElement('button');
    del.textContent = '✕';
    del.className = 'key-del';
    del.addEventListener('click', async () => {
      const r2 = await fetch(API.auth, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-token': token },
        body: JSON.stringify({ provider: p.provider, delete: true }),
      });
      msg.textContent = r2.ok ? `${p.provider} removed` : 'error';
      load();
    });
    row.append(name, hint, del);
    list.appendChild(row);
  }
}

async function loadOAuthProviders() {
  const data = await fetch(`${API.oauthProviders}?token=${encodeURIComponent(token)}`)
    .then((r) => r.json()).catch(() => ({ providers: [] }));
  oauthProvider.innerHTML = '';
  for (const provider of data.providers ?? []) {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = provider.label || provider.name || provider.id;
    oauthProvider.append(option);
  }
  document.getElementById('oauth-login').disabled = !oauthProvider.options.length;
  if (!oauthProvider.options.length) oauthStatus.textContent = 'no OAuth providers available';
}

async function runOAuth(provider) {
  oauthStatus.textContent = 'starting sign-in…';
  const started = await fetch(API.oauthStart, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-token': token }, body: JSON.stringify({ provider }),
  }).then((r) => r.json()).catch(() => ({}));
  if (!started.id) { oauthStatus.textContent = `error: ${started.error || 'could not start sign-in'}`; return; }
  let answeredPrompt = null;
  const timer = setInterval(async () => {
    const state = await fetch(`${API.oauthStatus}?token=${encodeURIComponent(token)}&id=${encodeURIComponent(started.id)}`)
      .then((r) => r.json()).catch(() => ({}));
    for (const event of state.events ?? []) {
      if (event.type === 'auth_url') {
        oauthStatus.innerHTML = '';
        const link = document.createElement('a');
        link.href = event.url;
        link.textContent = event.instructions || 'open sign-in page';
        oauthStatus.append(link);
        // MainActivity routes non-local URLs to Android's browser.
        window.location.assign(event.url);
      } else if (event.type === 'device_code') {
        oauthStatus.textContent = `Open ${event.verificationUri} and enter code: ${event.userCode}`;
      } else if (event.message) oauthStatus.textContent = event.message;
    }
    if (state.prompt && state.prompt.id !== answeredPrompt) {
      answeredPrompt = state.prompt.id;
      const value = await askOAuthPrompt(state.prompt);
      await fetch(API.oauthRespond, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-token': token },
        body: JSON.stringify({ id: started.id, promptId: state.prompt.id, value }),
      });
    }
    if (state.done) {
      clearInterval(timer);
      oauthStatus.textContent = state.error ? `error: ${state.error}` : `signed in: ${provider}`;
      if (!state.error) { load(); loadOAuthProviders(); }
    }
  }, 600);
}

document.getElementById('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const provider = document.getElementById('add-provider').value;
  const key = document.getElementById('add-key').value.trim();
  if (!key) return;
  const r = await fetch(API.auth, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-token': token },
    body: JSON.stringify({ provider, key }),
  });
  const j = await r.json().catch(() => ({}));
  msg.textContent = j.ok ? `saved ${provider}` : `error: ${j.error || r.status}`;
  if (j.ok) { document.getElementById('add-key').value = ''; load(); }
});

document.getElementById('oauth-login').addEventListener('click', () => runOAuth(oauthProvider.value));
load();
loadOAuthProviders();

// 
// ─── pi version / update ─────────────────────────────────────────────────────
const elInstalled = document.getElementById('update-installed');
const elArrow     = document.getElementById('update-arrow');
const elLatest    = document.getElementById('update-latest');
const elOk        = document.getElementById('update-ok');
const btnUpdate   = document.getElementById('update-btn');
const elLog       = document.getElementById('update-log');

async function checkVersion() {
  elInstalled.textContent = 'checking…';
  try {
    const v = await fetch(`${API.piVersion}?token=${encodeURIComponent(token)}`).then(r => r.json());
    elInstalled.textContent = v.installed ?? '?';
    if (v.updateAvailable) {
      elArrow.classList.remove('hidden');
      elLatest.textContent = v.latest;
      elLatest.classList.remove('hidden');
      btnUpdate.classList.remove('hidden');
      elOk.classList.add('hidden');
    } else {
      elArrow.classList.add('hidden');
      elLatest.classList.add('hidden');
      btnUpdate.classList.add('hidden');
      elOk.classList.remove('hidden');
    }
  } catch { elInstalled.textContent = 'unavailable'; }
}

let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    const s = await fetch(`${API.piUpdateStatus}?token=${encodeURIComponent(token)}`).then(r => r.json()).catch(() => null);
    if (!s) return;
    if (s.log?.length) { elLog.textContent = s.log.join('\n'); elLog.scrollTop = elLog.scrollHeight; }
    if (s.done) {
      clearInterval(pollTimer); pollTimer = null;
      if (s.ok) {
        elInstalled.textContent = s.version ?? 'updated';
        elLog.textContent += '\nrestarting…';
        setTimeout(() => location.reload(), 3000);
      } else {
        btnUpdate.textContent = 'Retry'; btnUpdate.disabled = false;
      }
    }
  }, 1000);
}

btnUpdate?.addEventListener('click', async () => {
  btnUpdate.textContent = 'updating…'; btnUpdate.disabled = true;
  elLog.textContent = ''; elLog.classList.remove('hidden');
  await fetch(API.piUpdate, { method: 'POST', headers: { 'x-token': token } });
  startPolling();
});

// auto-resume polling if an update is already running (page reload during update)
(async () => {
  await checkVersion();
  const s = await fetch(`${API.piUpdateStatus}?token=${encodeURIComponent(token)}`).then(r => r.json()).catch(() => null);
  if (s?.running) { elLog.classList.remove('hidden'); btnUpdate.textContent = 'updating…'; btnUpdate.disabled = true; startPolling(); }
})();
