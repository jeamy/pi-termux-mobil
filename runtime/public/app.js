import { API } from './constants.js';
import { renderMenu } from './menu.js';
import { newRequestId, postJson, Transcript, usageText } from './transcript.js';

const token = renderMenu();

const chat = document.getElementById('chat');
const input = document.getElementById('input');
const statusEl = document.getElementById('status');
const sessionNameEl = document.getElementById('session-name');
const usageEl = document.getElementById('session-usage');
const steerWrap = document.getElementById('steer-wrap');
const steerBox = document.getElementById('steer');
const modelSelect = document.getElementById('model-select');

let busy = false;
let queued = 0;
let currentModel = null;

function status(t) { statusEl.textContent = t; }
function showBusy() {
  status(busy ? `running…${queued ? ` (${queued} queued)` : ''}` : 'idle');
  steerWrap.classList.toggle('hidden', !busy);
}

const transcript = new Transcript(chat, {
  onBusy: (b) => { busy = b; showBusy(); },
  onModel: (m) => { currentModel = m; syncModelSelect(); },
  onUsage: (u) => { usageEl.textContent = usageText(u); },
  onInbox: (items) => { queued = items.length; showBusy(); },
});

// --- events: every (re)connect gets a fresh snapshot of the current state ----

function connect() {
  const es = new EventSource(`${API.events}?token=${encodeURIComponent(token)}`);
  es.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.type === 'bridge_snapshot') {
      sessionNameEl.textContent = ev.sessionName || 'Main';
      transcript.renderSnapshot(ev.snapshot);
    } else if (ev.type === 'bridge_error') {
      transcript.sys(`error: ${ev.error}`);
    } else if (ev.type !== 'bridge_connected') {
      transcript.handleEvent(ev);
    }
  };
  es.onerror = () => status('reconnecting…');
}

// --- composer: requestId makes a retried prompt exactly-once ------------------

document.getElementById('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  const pending = transcript.addPendingUser(text);
  const body = { message: text, requestId: newRequestId() };
  if (busy && steerBox.checked) body.whenBusy = 'steer';
  const r = await postJson(API.prompt, token, body, { retries: 3 });
  if (r.error) transcript.failPending(pending, r.error);
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) document.getElementById('composer').requestSubmit();
});

// --- model picker ------------------------------------------------------------

function syncModelSelect() {
  if (!currentModel) { modelSelect.value = ''; return; }
  const v = `${currentModel.provider}|${currentModel.modelId}`;
  if (![...modelSelect.options].some((o) => o.value === v)) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = `${currentModel.provider}/${currentModel.modelId}`;
    modelSelect.appendChild(o);
  }
  modelSelect.value = v;
}

async function refreshModels() {
  try {
    const r = await fetch(`${API.models}?token=${encodeURIComponent(token)}`);
    const j = await r.json();
    modelSelect.innerHTML = '<option value="">no model</option>';
    for (const m of j.models ?? []) {
      const o = document.createElement('option');
      o.value = `${m.provider}|${m.modelId}`;
      o.textContent = `${m.provider}/${m.modelId}`;
      modelSelect.appendChild(o);
    }
    syncModelSelect();
  } catch {}
}

modelSelect.addEventListener('change', async () => {
  const [provider, modelId] = modelSelect.value.split('|');
  if (!modelId) return;
  const r = await postJson(API.model, token, { provider, modelId });
  if (!r.ok) transcript.sys(`error: ${r.error}`);
});

connect();
refreshModels();
