import { API } from './constants.js';
import { askCopyAuth, askInstallKey, askTrustHost, askUpdate } from './authprompt.js';
import { renderMenu } from './menu.js';
import { newRequestId, postJson, Transcript, usageText } from './transcript.js';

const token = renderMenu();
const hostSel = document.getElementById('host-select');
const sessSel    = document.getElementById('session-select');
const modelSel   = document.getElementById('model-select');
const chat       = document.getElementById('chat');
const composer   = document.getElementById('composer');
const input      = document.getElementById('input');
const btnConnect = document.getElementById('btn-connect');
const btnNew     = document.getElementById('btn-new-session');
const btnRename  = document.getElementById('btn-rename-session');
const btnDelete  = document.getElementById('btn-delete-session');
const btnAbort   = document.getElementById('btn-abort');
const btnCompact = document.getElementById('btn-compact');
const statusBar  = document.getElementById('session-bar');     // session row
const statusBand = document.getElementById('remote-status-bar'); // status strip
const statusEl   = document.getElementById('remote-status');
const usageEl = document.getElementById('session-usage');
const steerWrap = document.getElementById('steer-wrap');
const steerBox = document.getElementById('steer');

const q = (path, params = {}) => {
  const u = new URLSearchParams({ token, ...params });
  return `${path}?${u}`;
};
const getJson = (path, params) => fetch(q(path, params)).then((r) => r.json()).catch((e) => ({ error: String(e?.message || e) }));
const post = (path, body, opts) => postJson(path, token, body, opts);

let busy = false;
const transcript = new Transcript(chat, {
  onBusy: (b) => { busy = b; steerWrap.classList.toggle('hidden', !b); showStatus(); },
  onModel: (m) => selectModel(m),
  onUsage: (u) => { usageEl.textContent = usageText(u); },
});

// --- event position: (epoch, seq) of the last event this page has applied ----
// The bridge forwards `after`/`epoch`; pi-serverd answers `reset` when the
// numbering changed (daemon restart, buffer overflow) and the page reloads.
let attachedId = null;
let pos = { epoch: undefined, cursor: -1 };
let pollGeneration = 0;
let link = 'disconnected';

function showStatus() {
  statusBar.classList.toggle('hidden', !attachedId);
  if (statusBand) statusBand.classList.toggle('hidden', !attachedId);
  statusEl.textContent = link === 'reconnecting' ? 'reconnecting…' : busy ? 'running…' : 'idle';
}

async function reloadHistory() {
  const history = await getJson(API.remoteHistory);
  if (history.error) return false;
  transcript.clear();
  transcript.renderEntries(history.entries);
  pos = { epoch: history.epoch, cursor: history.cursor ?? -1 };
  const state = await getJson(API.remoteState);
  if (!state.error) {
    busy = Boolean(state.busy);
    steerWrap.classList.toggle('hidden', !busy);
    selectModel(state.docs?.['pi.agent']?.model);
    usageEl.textContent = usageText(state.docs?.['pi.usage']);
  }
  showStatus();
  return true;
}

async function pollLoop(generation) {
  while (generation === pollGeneration) {
    const r = await getJson(API.remoteEvents, { after: String(pos.cursor), ...(pos.epoch ? { epoch: pos.epoch } : {}) });
    if (generation !== pollGeneration) return;
    if (r.error) {
      link = r.reconnecting ? 'reconnecting' : link;
      showStatus();
      await new Promise((res) => setTimeout(res, 2000));
      if (r.reconnecting === undefined) await checkLink();
      continue;
    }
    if (link !== 'connected') { link = 'connected'; showStatus(); }
    if (r.reset) { await reloadHistory(); continue; }
    for (const ev of r.events ?? []) transcript.handleEvent(ev);
    pos = { epoch: r.epoch, cursor: r.cursor };
  }
}

async function checkLink() {
  const s = await getJson(API.remoteStatus);
  link = s.status || 'disconnected';
  showStatus();
}

// --- hosts / sessions -----------------------------------------------------------

async function loadHosts() {
  const j = await getJson(API.clients);
  for (const c of j.clients ?? []) {
    const o = document.createElement('option');
    o.value = c.target;
    o.textContent = c.name;
    hostSel.appendChild(o);
  }
}

function selectModel(active) {
  for (const o of modelSel.options) {
    try {
      const m = JSON.parse(o.value);
      o.selected = m.provider === active?.provider && m.modelId === active?.modelId;
    } catch {}
  }
}

async function loadRemoteModels() {
  const result = await getJson(API.remoteModels);
  modelSel.innerHTML = '';
  for (const model of result.models ?? []) {
    const option = document.createElement('option');
    option.value = JSON.stringify(model);
    option.textContent = `${model.provider}/${model.modelId}`;
    modelSel.appendChild(option);
  }
  modelSel.classList.toggle('hidden', !modelSel.options.length);
}

async function attachSession(id) {
  pollGeneration++;
  const r = await post(API.remoteAttach, { id }, { retries: 2 });
  if (!r.ok) { transcript.sys(`error: ${r.error || 'could not attach'}`); return; }
  attachedId = id;
  link = 'connected';
  await loadRemoteModels();
  await reloadHistory();
  // session-row buttons visible as part of #session-bar
  composer.classList.remove('hidden');
  pollLoop(pollGeneration);
}

async function showSessions(sessions, attachFirst = false) {
  sessSel.innerHTML = '';
  for (const s of sessions) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = `${s.name || s.id}${s.cwd ? ` (${s.cwd})` : ''}`;
    sessSel.appendChild(o);
  }
  btnDelete?.classList.toggle('hidden', !sessions.length);
  btnRename?.classList.toggle('hidden', !sessions.length);
  // The first option is selected automatically by HTML but does not emit a
  // change event. Attach it explicitly so a one-session host is usable.
  if (attachFirst && sessions.length) await attachSession(sessions[0].id);
}

let connecting = false;
let connected = false;
let connectGeneration = 0;

function setConnected(v) {
  connected = v;
  btnConnect.textContent = v ? 'disconnect' : 'connect';
}

function resetUi() {
  pollGeneration++;
  attachedId = null;
  link = 'disconnected';
  transcript.clear();
  for (const el of [composer, modelSel]) el.classList.add('hidden');
  sessSel.innerHTML = '';
  setConnected(false);
  showStatus();
}

async function disconnectHost() {
  connectGeneration++;
  connecting = false;
  resetUi();
  const r = await post(API.remoteDisconnect, {});
  transcript.sys(r.error ? `error: ${r.error}` : 'disconnected');
}

async function connectHost() {
  const target = hostSel.value;
  if (!target || connecting) return;
  connecting = true;
  const generation = ++connectGeneration;
  btnConnect.textContent = 'cancel';
  try {
    // A connection is owned by one host. Do not leave the old host's attached
    // session, model, transcript, or composer usable while switching hosts.
    resetUi();
    transcript.sys(`connecting ${target}…`);
    // provisioning (install/start of pi-serverd) can take minutes: show its log
    let shown = 0;
    const logTimer = setInterval(async () => {
      const st = await getJson(API.remoteStatus);
      for (const l of (st.log ?? []).slice(shown)) transcript.sys(l);
      shown = Math.max(shown, (st.log ?? []).length);
    }, 1500);
    let r;
    try {
      // the bridge answers needsAuth / needsUpdate until the user decided; each answer is sent along
      const body = { target };
      for (let i = 0; i < 4; i++) {
        r = await post(API.remoteConnect, body);
        if (r.needsTrust) {
          if (await askTrustHost(target, r.fingerprint)) {
            const trust = await post(API.remoteTrustHost, { target, fingerprint: r.fingerprint });
            if (!trust.ok) { r = trust; break; }
          } else body.copyAuth = false;
        } else if (r.needsAuth) body.copyAuth = await askCopyAuth(target);
        else if (r.needsUpdate) body.allowUpdate = await askUpdate(target, r);
        else break;
      }
    } finally { clearInterval(logTimer); }
    if (generation !== connectGeneration) return;
    if (r.loginFailed && await askInstallKey(target)) {
      // ssh-copy-id needs a terminal for the password; the terminal page returns here afterwards
      const back = `/remote.html?token=${encodeURIComponent(token)}&host=${encodeURIComponent(target)}`;
      location.href = `/terminal.html?token=${encodeURIComponent(token)}&ssh=${encodeURIComponent(target)}&sshop=copyid&next=${encodeURIComponent(back)}`;
      return;
    }
    if (!r.ok) { transcript.sys(`error: ${r.error}`); return; }
    setConnected(true);
    transcript.sys(`connected: ${r.serverId}${r.hostKey ? ` · host key ${r.hostKey}` : ''}`);
    let sessions = r.sessions?.sessions ?? [];
    // A fresh host has no durable conversations yet. Create one immediately so
    // Remote always opens a session belonging to the newly selected host.
    if (!sessions.length) {
      const created = await post(API.remoteCreate, {});
      if (!created.id) { transcript.sys(`error: ${created.error || 'could not create session'}`); return; }
      sessions = [{ id: created.id }];
    }
    await showSessions(sessions, true);
  } catch (e) { if (generation === connectGeneration) transcript.sys(`error: ${e?.message || e}`); }
  finally {
    if (generation === connectGeneration) { connecting = false; btnConnect.textContent = connected ? 'disconnect' : 'connect'; }
  }
}

// Selecting a host connects through SSH and immediately fills the session
// dropdown from that host. The button remains a manual refresh/reconnect.
hostSel.addEventListener('change', () => {
  // host change only resets UI; user clicks connect explicitly
  if (connected || connecting) disconnectHost();
});
btnConnect.addEventListener('click', () => (connected || connecting ? disconnectHost() : connectHost()));

sessSel.addEventListener('change', async () => {
  if (sessSel.value) await attachSession(sessSel.value);
});

modelSel.addEventListener('change', async () => {
  try {
    const model = JSON.parse(modelSel.value);
    const r = await post(API.remoteModel, model);
    if (!r.ok) transcript.sys(`error: ${r.error || 'could not change model'}`);
  } catch { transcript.sys('error: invalid model selection'); }
});

btnRename?.addEventListener('click', async () => {
  const id = sessSel.value;
  if (!id) return;
  const cur = sessSel.options[sessSel.selectedIndex]?.textContent || id;
  const name = prompt('Rename session:', cur);
  if (name === null || name === cur) return;
  const r = await post(API.remoteRename, { id, name });
  if (!r.ok) { transcript.sys(`error: ${r.error || 'rename failed'}`); return; }
  sessSel.options[sessSel.selectedIndex].textContent = name || id;
});

btnNew.addEventListener('click', async () => {
  const r = await post(API.remoteCreate, {});
  if (!r.id) { transcript.sys(`error: ${r.error || 'could not create session'}`); return; }
  const o = document.createElement('option');
  o.value = r.id;
  o.textContent = r.name || r.id;
  sessSel.prepend(o);
  sessSel.value = r.id;
  await attachSession(r.id);
});

btnDelete.addEventListener('click', async () => {
  const id = sessSel.value;
  if (!id || !confirm(`Stop and remove remote session ${id}?`)) return;
  const r = await post(API.remoteDelete, { id });
  if (!r.ok) { transcript.sys(`error: ${r.error || 'could not remove session'}`); return; }
  pollGeneration++;
  attachedId = null;
  transcript.clear();
  composer.classList.add('hidden');
  const sessions = await getJson(API.remoteSessions);
  await showSessions(sessions.sessions ?? [], true);
});

btnAbort.addEventListener('click', async () => {
  const r = await post(API.remoteAbort, {});
  if (r.error) transcript.sys(`error: ${r.error}`);
});
btnCompact.addEventListener('click', async () => {
  const r = await post(API.remoteCompact, {});
  if (r.error) transcript.sys(`error: ${r.error}`);
});

composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  const pending = transcript.addPendingUser(text);
  // one requestId for every retry: a prompt the server already accepted
  // before the tunnel dropped is not run a second time
  const body = { message: text, requestId: newRequestId() };
  if (busy && steerBox.checked) body.whenBusy = 'steer';
  const r = await post(API.remotePrompt, body, { retries: 10 });
  if (r.error) transcript.failPending(pending, r.error);
});

loadHosts().then(() => {
  // coming back from the key installation: reconnect to that host
  const host = new URLSearchParams(location.search).get('host');
  if (host && [...hostSel.options].some((o) => o.value === host)) { hostSel.value = host; connectHost(); }
});
