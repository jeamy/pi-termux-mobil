import { API } from './constants.js';
import { renderMenu } from './menu.js';
import { newRequestId, postJson, Transcript, usageText } from './transcript.js';

const token = renderMenu();
const hostSel = document.getElementById('host-select');
const sessSel = document.getElementById('session-select');
const modelSel = document.getElementById('model-select');
const chat = document.getElementById('chat');
const composer = document.getElementById('composer');
const input = document.getElementById('input');
const btnConnect = document.getElementById('btn-connect');
const btnNew = document.getElementById('btn-new-session');
const btnDelete = document.getElementById('btn-delete-session');
const btnAbort = document.getElementById('btn-abort');
const btnCompact = document.getElementById('btn-compact');
const statusBar = document.getElementById('session-bar');
const statusEl = document.getElementById('remote-status');
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
  for (const b of [btnAbort, btnCompact]) b.classList.remove('hidden');
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
  sessSel.classList.toggle('hidden', !sessions.length);
  btnNew.classList.remove('hidden');
  btnDelete.classList.toggle('hidden', !sessions.length);
  // The first option is selected automatically by HTML but does not emit a
  // change event. Attach it explicitly so a one-session host is usable.
  if (attachFirst && sessions.length) await attachSession(sessions[0].id);
}

let connecting = false;
async function connectHost() {
  const target = hostSel.value;
  if (!target || connecting) return;
  connecting = true;
  try {
    // A connection is owned by one host. Do not leave the old host's attached
    // session, model, transcript, or composer usable while switching hosts.
    pollGeneration++;
    attachedId = null;
    transcript.clear();
    for (const el of [composer, modelSel, sessSel, btnNew, btnDelete, btnAbort, btnCompact]) el.classList.add('hidden');
    sessSel.innerHTML = '';
    showStatus();
    transcript.sys(`connecting ${target}…`);
    const r = await post(API.remoteConnect, { target });
    if (!r.ok) { transcript.sys(`error: ${r.error}`); return; }
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
  } finally {
    connecting = false;
  }
}

// Selecting a host connects through SSH and immediately fills the session
// dropdown from that host. The button remains a manual refresh/reconnect.
hostSel.addEventListener('change', connectHost);
btnConnect.addEventListener('click', connectHost);

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

btnNew.addEventListener('click', async () => {
  const r = await post(API.remoteCreate, {});
  if (!r.id) { transcript.sys(`error: ${r.error || 'could not create session'}`); return; }
  const o = document.createElement('option');
  o.value = r.id;
  o.textContent = r.id;
  sessSel.prepend(o);
  sessSel.value = r.id;
  sessSel.classList.remove('hidden');
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

loadHosts();
