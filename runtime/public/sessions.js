import { API } from './constants.js';
import { renderMenu } from './menu.js';

const token = renderMenu();
const list = document.getElementById('session-list');
const msg = document.getElementById('msg');
const q = (path) => `${path}?token=${encodeURIComponent(token)}`;
const post = (path, body = {}) => fetch(path, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-token': token }, body: JSON.stringify(body),
}).then((r) => r.json()).catch((e) => ({ error: String(e?.message || e) }));

const goChat = (r) => { if (r.ok) location.href = q('/'); else msg.textContent = `error: ${r.error}`; };

document.getElementById('new-session').addEventListener('click', async () => {
  const name = prompt('Session name (optional):', '') ?? null;
  if (name === null) return;
  goChat(await post(API.sessionNew, { name }));
});

function button(text, title, onClick, cls) {
  const b = document.createElement('button');
  b.textContent = text;
  b.title = title;
  if (cls) b.className = cls;
  b.addEventListener('click', onClick);
  return b;
}

async function load() {
  const data = await fetch(q(API.sessions)).then((r) => r.json()).catch(() => ({ sessions: [] }));
  list.innerHTML = '';
  for (const session of data.sessions ?? []) {
    const label = session.name || `Session ${session.id}`;
    const row = document.createElement('div');
    row.className = 'key-row';
    const name = document.createElement('span');
    name.className = 'key-name';
    name.textContent = label;
    const hint = document.createElement('span');
    hint.className = 'key-hint';
    hint.textContent = session.id === data.activeId ? 'active' : `#${session.id}`;
    row.append(name, hint);
    if (session.id !== data.activeId) {
      row.append(button('open', 'Open this session', async () => goChat(await post(API.sessionSelect, { id: session.id }))));
    }
    row.append(button('⑂', 'Fork: new session continuing from this one', async () => goChat(await post(API.sessionFork, { id: session.id }))));
    row.append(button('✎', 'Rename', async () => {
      const next = prompt('Session name:', label);
      if (next === null) return;
      const r = await post(API.sessionRename, { id: session.id, name: next });
      if (r.ok) load(); else msg.textContent = `error: ${r.error}`;
    }));
    if (session.id !== data.activeId) {
      row.append(button('✕', 'Stop and remove from session list (transcript is kept)', async () => {
        if (!confirm(`Stop and remove ${label}?`)) return;
        const r = await post(API.sessionDelete, { id: session.id });
        if (r.ok) load(); else msg.textContent = `error: ${r.error}`;
      }, 'key-del'));
    }
    list.append(row);
  }
  if (!list.children.length) list.innerHTML = '<div class="key-empty">no sessions</div>';
}

load();
