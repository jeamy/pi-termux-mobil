/* global Terminal, FitAddon */
import { askCopyAuth, askInstallKey, askTrustHost } from './authprompt.js';
import { API } from './constants.js';
import { renderMenu } from './menu.js';
const token = renderMenu();

const term = new Terminal({
  fontFamily: 'monospace',
  fontSize: 10,
  cursorBlink: true,
  scrollback: 5000,
  convertEol: false,
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('term'));
fit.fit();

let ws;
const sshTarget = new URLSearchParams(location.search).get('ssh');
const sshOp = new URLSearchParams(location.search).get('sshop');
let keyInstallRun = false; // this pty run is ssh-copy-id; afterwards the checks start again
let keyInstallSucceeded = false;
let keyOutputTail = '';
function connect(op = sshOp) {
  const cols = term.cols || 120;
  const rows = term.rows || 30;
  let u = `ws://${location.host}/pty?token=${encodeURIComponent(token)}&cols=${cols}&rows=${rows}`;
  if (location.protocol === 'https:') u = u.replace('ws://', 'wss://');
  if (sshTarget) u += `&ssh=${encodeURIComponent(sshTarget)}`;
  if (op) u += `&sshop=${encodeURIComponent(op)}`;
  ws = new WebSocket(u);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { term.focus(); };
  ws.onmessage = (e) => {
    const bytes = new Uint8Array(e.data);
    keyOutputTail = (keyOutputTail + new TextDecoder().decode(bytes)).slice(-256);
    if (keyOutputTail.includes('[SSH_KEY_INSTALLED]')) keyInstallSucceeded = true;
    term.write(bytes);
  };
  ws.onclose = () => {
    const next = new URLSearchParams(location.search).get('next');
    if (sshOp === 'copyid' && next && next.startsWith('/') && !next.startsWith('//') && keyInstallSucceeded) { location.href = next; return; }
    if (keyInstallRun) {
      keyInstallRun = false;
      if (keyInstallSucceeded) { keyInstallSucceeded = false; term.reset(); start(); return; }
      term.write('\r\n[key installation failed — tap to retry]\r\n');
      return;
    }
    term.write('\r\n\r\n[disconnected — tap to respawn]\r\n');
    document.getElementById('status').textContent = 'disconnected';
  };
}
// registered once: connect() runs again for respawn / key install
term.onData((d) => {
  if (ws?.readyState !== 1) return;
  if (ctrlArmed && d.length === 1) {
    const c = d.toLowerCase().charCodeAt(0);
    if (c >= 97 && c <= 122) {
      ws.send(String.fromCharCode(c - 96)); // ctrl+letter
      ctrlArmed = false;
      document.querySelector('#keybar [data-k="ctrl"]')?.classList.remove('armed');
      return;
    }
  }
  ws.send(d);
});
document.getElementById('term').addEventListener('click', () => {
  if (ws?.readyState === 3) { term.reset(); start(); }
});
function sendSize() {
  fit.fit();
  if (ws?.readyState === 1 && term.cols && term.rows) {
    ws.send('\x01' + JSON.stringify({ resize: { cols: term.cols, rows: term.rows } }));
  }
}
window.addEventListener('resize', sendSize);
setTimeout(sendSize, 1500); // push real size once the ws is up
// Plain `pi` over ssh: offer to copy auth.json first when the host has none (asked once per page).
async function start() {
  if (sshTarget && !sshOp) {
    try {
      const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-token': token }, body: JSON.stringify(body) }).then((r) => r.json());
      term.write(`checking ${sshTarget}…\r\n`);
      const st = await post(API.remoteAuthStatus, { target: sshTarget });
      if (st.loginFailed) {
        if (await askInstallKey(sshTarget)) { keyInstallRun = true; connect('copyid'); return; }
        term.write('key not installed; ssh will ask for the password.\r\n');
      } else if (st.error) term.write(`[auth check failed: ${st.error}]\r\n`);
      else if (st.needsAuth) {
        let trusted = st.trusted;
        if (!trusted && await askTrustHost(sshTarget, st.fingerprint)) {
          const r = await post(API.remoteTrustHost, { target: sshTarget, fingerprint: st.fingerprint });
          trusted = r.ok;
          if (!trusted) term.write(`[fingerprint confirmation failed: ${r.error}]\r\n`);
        }
        if (trusted && await askCopyAuth(sshTarget)) {
          const r = await post(API.remoteCopyAuth, { target: sshTarget });
          term.write(r.ok ? 'auth.json copied.\r\n' : `[copy failed: ${r.error}]\r\n`);
        }
      }
    } catch (e) { term.write(`[auth check failed: ${e?.message || e}]\r\n`); }
  }
  connect();
}
start();

// --- extra keys bar ----------------------------------------------------------

const KEYS = {
  esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B',
  right: '\x1b[C', left: '\x1b[D', slash: '/', enter: '\r',
  pgup: '\x1b[5~', pgdn: '\x1b[6~',
};
let ctrlArmed = false;
const send = (d) => { if (ws?.readyState === 1) ws.send(d); };
for (const b of document.querySelectorAll('#keybar button')) {
  b.addEventListener('click', () => {
    const k = b.dataset.k;
    if (k === 'ctrl') {
      ctrlArmed = !ctrlArmed;
      b.classList.toggle('armed', ctrlArmed);
      return;
    }
    if (ctrlArmed) {
      ctrlArmed = false;
      document.querySelector('#keybar [data-k="ctrl"]').classList.remove('armed');
      const ch = k === 'enter' ? '\r' : k === 'tab' ? '\t' : k === 'slash' ? '/' : k[0];
      if (ch && ch.length === 1) {
        // ctrl+<letter> / common ctrl combos
        const map = { c: '\x03', d: '\x04', z: '\x1a', l: '\x0c', a: '\x01', e: '\x05', k: '\x0b', u: '\x15', w: '\x17', o: '\x0f', '/': '\x1f' };
        if (k === 'esc') send('\x1b\x1b');
        else if (k === 'up' || k === 'down') send(k === 'up' ? '\x10' : '\x0e'); // ctrl+p/n
        else if (map[ch]) send(map[ch]);
        else send('\x00');
      }
      return;
    }
    send(KEYS[k]);
    term.focus();
  });
}

