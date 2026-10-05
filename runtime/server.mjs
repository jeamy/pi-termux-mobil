// Minimal HTTP+SSE bridge: web UI <-> pi-durable Harness (crash-safe, SQLite storage).
// Env: HOME (set by app), PI_PORT (default 0=ephemeral, port written to
// $HOME/.pi-mobile/port), PI_WORKDIR (agent cwd), PI_SHELL (bash path),
// PI_REMOTES (JSON: {"name": {"url": "http://host:port", "token": "..."}}, merged
// over $HOME/.pi-mobile/remotes.json) — a conversation whose cwd is
// "remote:<name>:/path" runs its tools on that host.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { createReadStream, existsSync, readdirSync, readFileSync, readlinkSync, statSync, unlinkSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { watchEvents } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { RemoteExecutionEnv } from './remote-env.mjs';
import { attachRemote, parseSshTarget, sshHostFingerprint } from './remote-client.mjs';
import { copyAuthTo, ensureRemoteServer, probeRemote, remoteBash, runtimeHash } from './remote-provision.mjs';
import {
  acquireOwnerLock, agentOf, createCredentialStore, createModelCatalog, ensureModel, isBusy,
  openHarness, pickModel, readJson, requestIdOf, sessionStore, Subagent, whenBusyOf,
  writeFileAtomic,
} from './common.mjs';

const ctx = BACKGROUND_CONTEXT;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOME_DIR = process.env.HOME || ROOT;
const WORKDIR = process.env.PI_WORKDIR || HOME_DIR;
const AGENT_DIR = path.join(HOME_DIR, '.pi', 'agent');
const AUTH_PATH = path.join(AGENT_DIR, 'auth.json');
const STATE_DIR = path.join(HOME_DIR, '.pi-mobile');
const PORT_FILE = path.join(STATE_DIR, 'port');
const TOKEN_FILE = path.join(STATE_DIR, 'token');
const LEGACY_SESSIONS_FILE = path.join(STATE_DIR, 'sessions.json');
const DEVICE_ID_FILE = path.join(STATE_DIR, 'device-id');
const CLIENTS_FILE = path.join(STATE_DIR, 'clients.json');
const TRUST_FILE = path.join(STATE_DIR, 'trusted-hosts.json');
async function trustStatus(target) {
  parseSshTarget(target);
  const fingerprint = await sshHostFingerprint(target, process.env.PREFIX || '');
  if (!fingerprint) throw new Error('SSH host fingerprint not available: cannot transfer credentials');
  return { fingerprint, trusted: readJson(TRUST_FILE, {})[target] === fingerprint };
}
async function assertTrusted(target) {
  if (!(await trustStatus(target)).trusted) throw Object.assign(new Error('confirm the SSH host fingerprint before copying credentials'), { status: 403 });
}
const PUBLIC = path.join(ROOT, 'public');
const REMOTES = {
  ...readJson(path.join(STATE_DIR, 'remotes.json'), {}),
  ...JSON.parse(process.env.PI_REMOTES || '{}'),
};
const MAX_BODY = 1024 * 1024;
const PI_PKG = '@earendil-works/pi-coding-agent';
const EARENDIL_PKGS = ['@earendil-works/pi-coding-agent','@earendil-works/pi-durable',
  '@earendil-works/pi-ai','@earendil-works/pi-client','@earendil-works/pi-server','@earendil-works/chord'];
function piInstalledVersion() {
  try { return JSON.parse(readFileSync(path.join(ROOT,'node_modules',PI_PKG,'package.json'),'utf8')).version; } catch { return null; }
}
async function piLatestVersion() {
  try {
    const r = await fetch(`https://registry.npmjs.org/${PI_PKG}/latest`,{ signal: AbortSignal.timeout(8000) });
    return (await r.json()).version ?? null;
  } catch { return null; }
}
const piUpdate = { running: false, done: false, ok: false, version: null, error: null, log: [] };
function startPiUpdate() {
  if (piUpdate.running) return false;
  Object.assign(piUpdate, { running: true, done: false, ok: false, version: null, error: null, log: [] });
  const prefix = process.env.PREFIX || '';
  // Run npm via node to avoid Termux shebang incompatibility on Android.
  // Try: node <npm-cli.js>, fallback to direct npm binary.
  const nodeBin = process.execPath;
  const npmCli = prefix ? `${prefix}/lib/node_modules/npm/bin/npm-cli.js` : null;
  let spawnArgs;
  if (npmCli && existsSync(npmCli)) {
    spawnArgs = [nodeBin, [npmCli, 'install']];
  } else {
    const npmBin = prefix ? `${prefix}/bin/npm` : 'npm';
    spawnArgs = [npmBin, ['install']];
  }
  const pkgs = EARENDIL_PKGS.map(p => `${p}@latest`);
  const child = spawn(spawnArgs[0], [...spawnArgs[1], ...pkgs, '--no-fund', '--no-audit', '--ignore-scripts'], {
    cwd: ROOT, env: { ...process.env, npm_config_cache: path.join(HOME_DIR, '.npm') },
  });
  const addLog = (d) => { for (const l of String(d).split('\n')) { const t = l.trimEnd(); if (t) { piUpdate.log.push(t); if (piUpdate.log.length > 500) piUpdate.log.shift(); } } };
  child.stdout.on('data', addLog); child.stderr.on('data', addLog);
  child.on('close', (code) => {
    piUpdate.running = false; piUpdate.done = true;
    piUpdate.ok = code === 0; piUpdate.version = piInstalledVersion();
    piUpdate.error = code !== 0 ? `npm exited with code ${code}` : null;
    if (code === 0) { addLog(`pi updated to ${piUpdate.version} — restarting bridge…`); setTimeout(() => process.exit(0), 1500); }
  });
  child.on('error', (e) => { piUpdate.running = false; piUpdate.done = true; piUpdate.ok = false; piUpdate.error = e.message; });
  return true;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

await mkdir(STATE_DIR, { recursive: true });
// pi-durable allows one storage owner: stop an orphaned predecessor first
const releaseLock = await acquireOwnerLock(path.join(STATE_DIR, 'server.lock'), 'server.mjs');

// --- credentials / models ---------------------------------------------------------

const credentialStore = createCredentialStore(AUTH_PATH);
const models = await createModelCatalog(credentialStore);

// --- execution environment ---------------------------------------------------------

function envFor({ cwd } = {}) {
  const dir = cwd ?? WORKDIR;
  const m = /^remote:([^:]+):(.+)$/.exec(dir);
  if (m) {
    const remote = REMOTES[m[1]];
    if (!remote) throw new Error(`unknown remote "${m[1]}" (configure ${path.join(STATE_DIR, 'remotes.json')})`);
    return new RemoteExecutionEnv({ cwd: m[2], baseUrl: remote.url, token: remote.token });
  }
  const prefix = process.env.PREFIX;
  const bash = prefix && existsSync(path.join(prefix, 'bin/bash'))
    ? path.join(prefix, 'bin/bash') : undefined;
  const shellEnv = prefix
    ? { ...process.env, PATH: `${prefix}/bin:/system/bin:${process.env.PATH || ''}` }
    : undefined;
  return new NodeExecutionEnv({ cwd: dir, shellPath: process.env.PI_SHELL || bash, shellEnv });
}

// --- OAuth ---------------------------------------------------------------------------

const oauthLogins = new Map();
function deviceId() {
  try { return readFileSync(DEVICE_ID_FILE, 'utf8').trim(); } catch {}
  const id = crypto.randomUUID();
  writeFileAtomic(DEVICE_ID_FILE, id);
  return id;
}
function startOAuthLogin(providerId) {
  const provider = models.getProvider(providerId);
  if (!provider?.auth.oauth) throw new Error(`${providerId} does not support OAuth login`);
  const id = crypto.randomUUID();
  const login = { id, events: [], prompt: null, done: false, error: null, credential: null };
  oauthLogins.set(id, login);
  const interaction = {
    signal: new AbortController().signal,
    notify: (event) => login.events.push(event),
    prompt: (prompt) => new Promise((resolve, reject) => {
      login.prompt = { id: crypto.randomUUID(), prompt, resolve, reject };
    }),
  };
  models.login(providerId, 'oauth', interaction, { getDeviceId: deviceId })
    .then(async (credential) => {
      login.credential = credential;
      login.done = true;
      try { await models.refresh({ providers: [providerId] }); } catch {}
      await giveActiveSessionAModel();
    })
    .catch((error) => { login.error = String(error?.message || error); login.done = true; })
    .finally(() => setTimeout(() => oauthLogins.delete(id), 10 * 60_000).unref());
  return login;
}

// --- harness + durable session registry ---------------------------------------------

const harness = await openHarness({ dbPath: path.join(STATE_DIR, 'harness.sqlite'), models, env: envFor, extensions: [Subagent] }, ctx);
const sessions = sessionStore(harness, ctx);
let active = null; // the conversation the chat page shows

async function initHarness() {
  const root = await harness.root(ctx, { agent: { model: await pickModel(models) } });
  // one-time import of the old JSON side file
  const legacy = readJson(LEGACY_SESSIONS_FILE, null)?.sessions;
  if (legacy && Object.keys(legacy).length) {
    await sessions.migrate(legacy);
    writeFileAtomic(`${LEGACY_SESSIONS_FILE}.migrated`, JSON.stringify({ sessions: legacy }, null, 2));
    try { unlinkSync(LEGACY_SESSIONS_FILE); } catch {}
  }
  await sessions.register(root.id, { name: 'Main' });
  // reopen the session that was active before the restart
  const remembered = await sessions.activeId();
  const conv = (remembered && (await sessions.get(remembered)) && await harness.conversation(Number(remembered), ctx)) || root;
  await activate(conv, { persist: false });
  await ensureModel(active, models, ctx);
  harness.resume(); // continue runs the last process left unfinished
}

async function activate(conversation, { persist = true } = {}) {
  active = conversation;
  if (persist) await sessions.setActive(conversation.id);
  for (const client of sseClients) await attachSse(client);
}

async function currentModel(conv) {
  const view = await conv.viewState(ctx);
  try { return agentOf(view).model; } finally { view.dispose?.(); }
}

async function giveActiveSessionAModel() {
  if (active) { try { await ensureModel(active, models, ctx); } catch {} }
}

// --- SSE: one watchEvents stream per client -------------------------------------------
// A stream's snapshot is the state at attach time; giving every (re)connecting
// client its own stream delivers the current state plus deltas (late join).

const sseClients = new Set();

function sseWrite(client, event) {
  try { client.res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
}

async function attachSse(client) {
  const previous = client.stream;
  client.stream = null;
  if (previous) { try { await previous.stop(); } catch {} }
  if (!active || client.closed) return;
  const conversationId = active.id;
  const stream = await watchEvents(harness, conversationId, ctx);
  if (client.closed) { await stream.stop(); return; }
  client.stream = stream;
  const meta = await sessions.get(conversationId);
  sseWrite(client, {
    type: 'bridge_snapshot', snapshot: stream.snapshot,
    sessionId: String(conversationId), sessionName: meta?.name ?? `Session ${conversationId}`,
  });
  stream.start(async (events) => {
    if (client.stream !== stream) return;
    for (const e of events) sseWrite(client, e);
  });
}

setInterval(() => {
  for (const client of sseClients) { try { client.res.write(': ping\n\n'); } catch {} }
}, 20_000).unref();

// --- HTTP helpers -------------------------------------------------------------------

const token = existsSync(TOKEN_FILE)
  ? (await readFile(TOKEN_FILE, 'utf8')).trim()
  : await (async () => {
      const t = crypto.randomBytes(24).toString('base64url');
      await writeFile(TOKEN_FILE, t, { mode: 0o600 });
      return t;
    })();
const tokenBuf = Buffer.from(token);

function authed(req) {
  const url = new URL(req.url, 'http://localhost');
  const given = String(req.headers['x-token'] || url.searchParams.get('token') || '');
  const buf = Buffer.from(given);
  return buf.length === tokenBuf.length && crypto.timingSafeEqual(buf, tokenBuf);
}
let listenPort = 0;
// DNS-rebinding guard: only the loopback names the WebView uses
function hostAllowed(req) {
  const h = String(req.headers.host || '');
  return h === `127.0.0.1:${listenPort}` || h === `localhost:${listenPort}`;
}
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}
const str = (v, max = 200) => String(v ?? '').slice(0, max);

function serveStatic(res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname); } catch { res.writeHead(400); return res.end(); }
  let filePath = path.resolve(PUBLIC, `.${rel}`);
  if (filePath !== PUBLIC && !filePath.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  let st = null;
  try { st = statSync(filePath); } catch {}
  if (!st?.isFile()) { filePath = path.join(PUBLIC, 'index.html'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
  const stream = createReadStream(filePath);
  stream.on('error', () => { try { res.destroy(); } catch {} });
  stream.pipe(res);
}

// --- remote pi-server attach state ------------------------------------------------------
// pi-client never reconnects on its own: a lost tunnel is rebuilt here with
// backoff and the last session is attached again. Prompts carry a requestId,
// so a retried prompt is never answered twice.

const remoteState = {
  remote: null,
  sessionId: null,
  status: 'disconnected', // connected | reconnecting | disconnected
  lastError: null,
  log: [],
  generation: 0,
  async connect(target, { copyAuth = false, allowUpdate = false } = {}) {
    await this.disconnect();
    const generation = this.generation;
    const prefix = process.env.PREFIX || '';
    // make sure a pi-serverd runs there (installs + starts it in tmux if not)
    this.log = [];
    this.status = 'provisioning';
    this.lastError = null;
    try {
      if (copyAuth) await assertTrusted(target);
      await ensureRemoteServer({ ssh: target, prefix, copyAuth, allowUpdate, authFile: AUTH_PATH, log: (l) => { this.log.push(l); if (this.log.length > 200) this.log.shift(); } });
    } catch (e) {
      this.status = 'disconnected';
      this.lastError = String(e?.message || e);
      throw e;
    }
    if (generation !== this.generation) throw Object.assign(new Error('connection cancelled'), { status: 409 });
    let remote;
    try { remote = await attachRemote({ ssh: target, prefix, socketDir: path.join(STATE_DIR, 'tunnels') }); }
    catch (e) { this.status = 'disconnected'; this.lastError = String(e?.message || e); throw e; }
    if (generation !== this.generation) { await remote.disconnect(); throw Object.assign(new Error('connection cancelled'), { status: 409 }); }
    this.remote = remote;
    this.status = 'connected';
    remote.onLost((why) => this.recover(remote, why));
    return remote;
  },
  async recover(remote, why) {
    if (this.remote !== remote || this.status === 'reconnecting') return;
    this.status = 'reconnecting';
    this.lastError = why;
    console.error('remote lost:', why);
    for (let attempt = 0; this.remote === remote; attempt++) {
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** attempt)));
      if (this.remote !== remote) return;
      try {
        await remote.reconnect();
        if (this.sessionId) await remote.attach(this.sessionId);
        this.status = 'connected';
        this.lastError = null;
        console.log('remote reconnected');
        return;
      } catch (e) { this.lastError = String(e?.message || e); }
    }
  },
  async disconnect() {
    this.generation++;
    const r = this.remote;
    this.remote = null;
    this.sessionId = null;
    this.status = 'disconnected';
    if (r) { try { await r.disconnect(); } catch {} }
  },
  require() {
    if (!this.remote) throw Object.assign(new Error('not connected'), { status: 400 });
    if (this.status !== 'connected') {
      throw Object.assign(new Error(`reconnecting: ${this.lastError || ''}`), { status: 503, reconnecting: true });
    }
    return this.remote;
  },
};

// --- client host registry + ssh key helpers ----------------------------------------------

const readClients = () => readJson(CLIENTS_FILE, []);
const writeClients = (clients) => writeFileAtomic(CLIENTS_FILE, JSON.stringify(clients, null, 2));
function sshKeyInfo() {
  const pub = `${HOME_DIR}/.ssh/id_ed25519.pub`;
  const priv = `${HOME_DIR}/.ssh/id_ed25519`;
  if (existsSync(pub) && existsSync(priv)) {
    try { return { exists: true, pubkey: readFileSync(pub, 'utf8').trim() }; } catch { return { exists: true, pubkey: null }; }
  }
  return { exists: false, pubkey: null };
}

// --- API -----------------------------------------------------------------------------

async function activeState() {
  const view = active ? await active.viewState(ctx) : null;
  try {
    const meta = active ? await sessions.get(active.id) : null;
    return {
      model: agentOf(view).model ?? null,
      busy: isBusy(view),
      inbox: view?.value?.docs?.['pi.inbox'] ?? null,
      usage: view?.value?.docs?.['pi.usage'] ?? null,
      cwd: agentOf(view).cwd ?? WORKDIR,
      sessionId: active ? String(active.id) : null,
      sessionName: meta?.name ?? 'Main',
      remotes: Object.keys(REMOTES),
    };
  } finally { view?.dispose?.(); }
}

async function handleApi(req, res, url, p) {
  const body = req.method === 'POST' ? await readBody(req) : {};
  if (!active && !p.startsWith('/api/oauth') && p !== '/api/auth' && p !== '/api/providers') {
    throw Object.assign(new Error('harness not ready'), { status: 503 });
  }

  if (p === '/api/pi-version' && req.method === 'GET') {
    const installed = piInstalledVersion();
    const latest = await piLatestVersion();
    const semverGt = (a, b) => { if (!a || !b) return false; const p = (v) => v.split('.').map(Number); const [A,B] = [p(a),p(b)]; for (let i=0;i<3;i++) { if ((B[i]||0) > (A[i]||0)) return true; if ((B[i]||0) < (A[i]||0)) return false; } return false; };
    return json(res, 200, { installed, latest, updateAvailable: semverGt(installed, latest) });
  }
  if (p === '/api/pi-update' && req.method === 'POST') {
    return json(res, 200, { started: startPiUpdate() });
  }
  if (p === '/api/pi-update-status' && req.method === 'GET') {
    return json(res, 200, piUpdate);
  }
  if (p === '/api/state') return json(res, 200, await activeState());

  // --- local sessions
  if (p === '/api/sessions' && req.method === 'GET') {
    return json(res, 200, { activeId: active ? String(active.id) : null, sessions: await sessions.list() });
  }
  if (p === '/api/sessions/new' && req.method === 'POST') {
    // a new session starts with the model the current one uses
    const conversation = await sessions.create(
      { name: str(body.name, 100) || undefined },
      { agent: { model: (await currentModel(active)) ?? await pickModel(models) } },
    );
    await activate(conversation);
    return json(res, 200, { ok: true, activeId: String(conversation.id) });
  }
  if (p === '/api/sessions/fork' && req.method === 'POST') {
    // fork the given (or active) session at its newest entry
    const sourceId = str(body.id || active.id);
    if (!(await sessions.get(sourceId))) return json(res, 404, { error: 'unknown session' });
    const source = await harness.conversation(Number(sourceId), ctx);
    const newest = (await source.entries({}, 1, undefined, ctx)).items[0];
    if (!newest) return json(res, 400, { error: 'nothing to fork yet' });
    const srcMeta = await sessions.get(sourceId);
    const fork = await sessions.create({ name: `${srcMeta?.name || `Session ${sourceId}`} (fork)` }, { fork: { conv: source, entryId: newest.id } });
    await activate(fork);
    return json(res, 200, { ok: true, activeId: String(fork.id) });
  }
  if (p === '/api/sessions/select' && req.method === 'POST') {
    const id = str(body.id);
    if (!(await sessions.get(id))) return json(res, 404, { error: 'unknown session' });
    const conversation = await harness.conversation(Number(id), ctx);
    if (!conversation) return json(res, 404, { error: 'session unavailable' });
    await activate(conversation);
    return json(res, 200, { ok: true, activeId: String(conversation.id) });
  }
  if (p === '/api/sessions/rename' && req.method === 'POST') {
    const id = str(body.id);
    if (!(await sessions.get(id))) return json(res, 404, { error: 'unknown session' });
    await sessions.update(id, { name: str(body.name, 100) || undefined });
    return json(res, 200, { ok: true });
  }
  if (p === '/api/sessions/delete' && req.method === 'POST') {
    const id = str(body.id);
    if (!(await sessions.get(id))) return json(res, 404, { error: 'unknown session' });
    if (id === String(active.id)) return json(res, 400, { error: 'select another session first' });
    // stop its work first: a hidden session must not keep running tools
    const conversation = await harness.conversation(Number(id), ctx);
    if (conversation) await conversation.abort(ctx);
    await sessions.remove(id); // transcript stays in SQLite
    return json(res, 200, { ok: true });
  }

  // --- active conversation
  if (p === '/api/prompt' && req.method === 'POST') {
    if (!(await ensureModel(active, models, ctx))) return json(res, 400, { error: 'no model: set an API key first' });
    const sub = await active.submit({
      type: 'input',
      content: String(body.message || ''),
      requestId: requestIdOf(body.requestId), // exactly-once across client retries
      whenBusy: whenBusyOf(body.whenBusy),
    }, ctx);
    return json(res, 200, { ok: true, submissionId: sub.id });
  }
  if (p === '/api/abort' && req.method === 'POST') {
    await active.abort(ctx);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/new' && req.method === 'POST') {
    await active.reset(typeof body.note === 'string' ? body.note : undefined, ctx);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/compact' && req.method === 'POST') {
    const taskId = await active.compact(typeof body.instructions === 'string' ? body.instructions : undefined, ctx);
    return json(res, 200, { ok: true, taskId });
  }
  if (p === '/api/usage' && req.method === 'GET') {
    return json(res, 200, { session: (await activeState()).usage, total: await harness.usage(ctx) });
  }
  if (p === '/api/result' && req.method === 'POST') {
    const sub = await harness.submission(Number(body.id), ctx);
    if (!sub) return json(res, 404, { error: 'unknown submission' });
    const settled = await sub.wait(ctx);
    return json(res, 200, { status: settled.status });
  }
  if (p === '/api/models' && req.method === 'GET') {
    const avail = await models.getAvailable();
    return json(res, 200, { models: avail.map((m) => ({ provider: m.provider, modelId: m.id })) });
  }
  if (p === '/api/model' && req.method === 'POST') {
    if (!body.provider || !body.modelId) return json(res, 400, { error: 'provider+modelId required' });
    await active.configure({ model: { provider: str(body.provider), modelId: str(body.modelId) } }, ctx);
    const view = await active.viewState(ctx);
    try { return json(res, 200, { ok: true, applied: agentOf(view).model }); } finally { view.dispose?.(); }
  }

  // --- ssh clients
  if (p === '/api/clients' && req.method === 'GET') return json(res, 200, { clients: readClients() });
  if (p === '/api/clients' && req.method === 'POST') {
    if (body.delete) {
      writeClients(readClients().filter((c) => c.name !== str(body.delete)));
      return json(res, 200, { ok: true });
    }
    if (!body.target) return json(res, 400, { error: 'target required' });
    const target = str(body.target);
    parseSshTarget(target); // throws on invalid / option-like targets
    const name = str(body.name || target, 100);
    const clients = readClients().filter((c) => c.name !== name);
    clients.push({ name, target });
    writeClients(clients);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/sshkey' && req.method === 'GET') return json(res, 200, sshKeyInfo());
  if (p === '/api/sshkey' && req.method === 'POST') {
    if (sshKeyInfo().exists) return json(res, 200, { ok: true, ...sshKeyInfo() });
    const prefix = process.env.PREFIX || '';
    const sshDir = `${HOME_DIR}/.ssh`;
    await mkdir(sshDir, { recursive: true, mode: 0o700 });
    const r = await new Promise((resolve) => {
      const kg = spawn(`${prefix}/bin/ssh-keygen`, ['-t', 'ed25519', '-N', '', '-f', `${sshDir}/id_ed25519`, '-C', 'pi-mobile'], { env: process.env });
      kg.on('exit', (c) => resolve(c));
      kg.on('error', () => resolve(-1));
    });
    return json(res, r === 0 ? 200 : 500, { ok: r === 0, ...sshKeyInfo() });
  }

  // --- remote pi-server attach
  if (p === '/api/remote/trust-host' && req.method === 'POST') {
    const target = str(body.target);
    const { fingerprint } = await trustStatus(target);
    if (body.fingerprint !== fingerprint) return json(res, 409, { error: 'host fingerprint changed' });
    writeFileAtomic(TRUST_FILE, JSON.stringify({ ...readJson(TRUST_FILE, {}), [target]: fingerprint }), 0o600);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/remote/auth-status' && req.method === 'POST') {
    let info;
    try { info = await probeRemote({ ssh: str(body.target), prefix: process.env.PREFIX || '' }); } catch (e) {
      // key login rejected (key not installed on the host) vs. other failures
      const loginFailed = /ssh login failed/.test(String(e?.message));
      return json(res, 200, { ok: false, loginFailed, error: String(e?.message || e) });
    }
    const trust = await trustStatus(str(body.target));
    return json(res, 200, { ok: true, needsAuth: info.auth !== '1' && existsSync(AUTH_PATH), ...trust });
  }
  if (p === '/api/remote/copy-auth' && req.method === 'POST') {
    if (!existsSync(AUTH_PATH)) return json(res, 400, { error: 'no auth.json on this device' });
    await assertTrusted(str(body.target));
    const info = await probeRemote({ ssh: str(body.target), prefix: process.env.PREFIX || '' });
    if (info.auth === '1') return json(res, 409, { error: 'auth.json already exists on host' });
    await copyAuthTo({ ssh: str(body.target), prefix: process.env.PREFIX || '', authFile: AUTH_PATH });
    return json(res, 200, { ok: true });
  }
  if (p === '/api/remote/connect' && req.method === 'POST') {
    const target = str(body.target);
    // Ask before anything sensitive happens on the host: copying auth.json, or restarting an outdated daemon.
    const askAuth = body.copyAuth === undefined && existsSync(AUTH_PATH);
    const askUpdate = body.allowUpdate === undefined;
    if (askAuth || askUpdate) {
      let info;
      try { info = await probeRemote({ ssh: target, prefix: process.env.PREFIX || '' }); } catch (e) {
        const msg = String(e?.message || e);
        return json(res, 200, { ok: false, loginFailed: /ssh login failed/.test(msg), error: msg });
      }
      if (askAuth && info.auth !== '1') {
        const trust = await trustStatus(target);
        if (!trust.trusted) return json(res, 200, { ok: false, needsTrust: true, target, ...trust });
        return json(res, 200, { ok: false, needsAuth: true, target });
      }
      if (askUpdate && info.running === '1' && info.ver !== runtimeHash()) {
        return json(res, 200, { ok: false, needsUpdate: true, target, installed: info.ver || null, available: runtimeHash() });
      }
    }
    const remote = await remoteState.connect(target, { copyAuth: body.copyAuth === true, allowUpdate: body.allowUpdate === true });
    return json(res, 200, { ok: true, serverId: remote.serverId, hostKey: remote.hostKey, sessions: await remote.list() });
  }
  if (p === '/api/remote/status' && req.method === 'GET') {
    return json(res, 200, { status: remoteState.status, error: remoteState.lastError, sessionId: remoteState.sessionId, log: remoteState.log, target: remoteState.remote?.target ?? null });
  }
  if (p === '/api/remote/disconnect' && req.method === 'POST') {
    await remoteState.disconnect();
    return json(res, 200, { ok: true });
  }
  if (p.startsWith('/api/remote/')) {
    const remote = remoteState.require();
    switch (`${req.method} ${p}`) {
      case 'GET /api/remote/sessions': return json(res, 200, await remote.list());
      case 'GET /api/remote/models': return json(res, 200, await remote.models());
      case 'POST /api/remote/model':
        if (!body.provider || !body.modelId) return json(res, 400, { error: 'provider+modelId required' });
        return json(res, 200, await remote.request('configure', [{ model: { provider: str(body.provider), modelId: str(body.modelId) } }]));
      case 'POST /api/remote/create': return json(res, 200, await remote.create({ name: str(body.name, 100) || undefined }));
      case 'POST /api/remote/rename':
        return json(res, 200, await remote.request('rename', [str(body.id), str(body.name, 100)]));
      case 'POST /api/remote/delete':
        if (str(body.id) === remoteState.sessionId) remoteState.sessionId = null;
        return json(res, 200, await remote.delete(str(body.id)));
      case 'POST /api/remote/attach':
        await remote.attach(str(body.id));
        remoteState.sessionId = str(body.id);
        return json(res, 200, { ok: true, target: remote.client.attachment });
      case 'POST /api/remote/prompt':
        return json(res, 200, await remote.request('prompt', [{
          message: String(body.message ?? ''), requestId: requestIdOf(body.requestId), whenBusy: whenBusyOf(body.whenBusy),
        }]));
      case 'POST /api/remote/abort': return json(res, 200, await remote.request('abort', []));
      case 'POST /api/remote/compact': return json(res, 200, await remote.request('compact', [{}]));
      case 'GET /api/remote/state': return json(res, 200, await remote.request('state', []));
      case 'GET /api/remote/history': return json(res, 200, await remote.request('history', [{ limit: 200 }]));
      case 'GET /api/remote/events': {
        const after = Number(url.searchParams.get('after') ?? -1);
        const epoch = url.searchParams.get('epoch') || undefined;
        return json(res, 200, await remote.request('events', [{ after, epoch }]));
      }
      default: return json(res, 404, { error: 'not found' });
    }
  }

  // --- accounts
  if (p === '/api/oauth/providers' && req.method === 'GET') {
    return json(res, 200, { providers: models.getProviders()
      .filter((provider) => Boolean(provider.auth.oauth))
      .map((provider) => ({ id: provider.id, name: provider.name, label: provider.auth.oauth?.loginLabel || provider.auth.oauth?.name })) });
  }
  if (p === '/api/oauth/start' && req.method === 'POST') {
    const login = startOAuthLogin(str(body.provider));
    return json(res, 200, { id: login.id });
  }
  if (p === '/api/oauth/status' && req.method === 'GET') {
    const login = oauthLogins.get(url.searchParams.get('id'));
    if (!login) return json(res, 404, { error: 'unknown login' });
    const prompt = login.prompt?.prompt;
    return json(res, 200, {
      events: login.events.splice(0), done: login.done, error: login.error,
      prompt: prompt ? { id: login.prompt.id, type: prompt.type, message: prompt.message,
        placeholder: prompt.placeholder, options: prompt.options } : null,
    });
  }
  if (p === '/api/oauth/respond' && req.method === 'POST') {
    const login = oauthLogins.get(str(body.id));
    if (!login?.prompt || login.prompt.id !== body.promptId) return json(res, 400, { error: 'no matching prompt' });
    const pending = login.prompt;
    login.prompt = null;
    pending.resolve(String(body.value ?? ''));
    return json(res, 200, { ok: true });
  }
  if (p === '/api/auth' && req.method === 'POST') {
    if (!body.provider) return json(res, 400, { error: 'provider required' });
    const provider = str(body.provider);
    if (body.delete) {
      await credentialStore.delete(provider);
      return json(res, 200, { ok: true });
    }
    if (!body.key) return json(res, 400, { error: 'key required' });
    await credentialStore.modify(provider, async () => ({ type: 'api_key', key: String(body.key) }));
    try { await models.refresh(); } catch {}
    await giveActiveSessionAModel();
    return json(res, 200, { ok: true });
  }
  if (p === '/api/providers' && req.method === 'GET') {
    return json(res, 200, {
      providers: Object.entries(credentialStore.readAll()).map(([provider, c]) => ({
        provider,
        type: c?.type ?? 'api_key',
        keyHint: c?.key ? `…${String(c.key).slice(-4)}` : null,
      })),
    });
  }
  return json(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  if (!hostAllowed(req)) { res.writeHead(421); return res.end(); }
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/api/events' && req.method === 'GET') {
    if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'bridge_connected' })}\n\n`);
    const client = { res, stream: null, closed: false };
    sseClients.add(client);
    req.on('close', async () => {
      client.closed = true;
      sseClients.delete(client);
      try { await client.stream?.stop(); } catch {}
    });
    try { await attachSse(client); } catch (e) { sseWrite(client, { type: 'bridge_error', error: String(e?.message || e) }); }
    return;
  }

  if (p.startsWith('/api/')) {
    if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
    try {
      return await handleApi(req, res, url, p);
    } catch (e) {
      if (res.headersSent) { try { res.end(); } catch {} return; }
      const httpCode = (Number.isInteger(e?.status) && e.status >= 100 && e.status <= 599) ? e.status : 500;
      return json(res, httpCode, { error: String(e?.message || e), reconnecting: e?.reconnecting || undefined });
    }
  }

  return serveStatic(res, p);
});

// --- interactive pi CLI over WebSocket + util-linux `script` pty -------------

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/pty' || !hostAllowed(req) || !authed(req)) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => startPty(ws, url));
});

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
};

// Remote command for "pi CLI (ssh)": install pi if absent, otherwise compare it
// to npm's latest stable release and update only when newer. The update stays in
// ~/.local (no root); if npm/the registry is unreachable the existing pi starts.
const REMOTE_PI_SCRIPT = [
  'PKG=@earendil-works/pi-coding-agent;',
  'if ! command -v pi >/dev/null 2>&1; then',
  ' if ! command -v npm >/dev/null 2>&1; then echo "pi is missing; npm (and Node.js >= 22.19.0) is required."; read -r _; exit 1; fi;',
  ' echo "pi not found - installing latest $PKG into ~/.local ...";',
  ' npm install -g --prefix "$HOME/.local" "$PKG@latest" || { echo "pi installation failed"; read -r _; exit 1; };',
  'else',
  ' if command -v npm >/dev/null 2>&1; then',
  '  have=$(pi --version 2>/dev/null | head -n 1); latest=$(npm view "$PKG" version --fetch-timeout=10000 --fetch-retries=1 2>/dev/null | head -n 1);',
  '  if [ -n "$latest" ] && node -e "const p=s=>String(s).match(/^([0-9]+)\\.([0-9]+)\\.([0-9]+)/)?.slice(1).map(Number); const [a,b]=process.argv.slice(1).map(p); let c=0; if(a&&b) for(let i=0;i<3;i++) if(a[i]!==b[i]) { c=b[i]-a[i]; break; } process.exit(c>0?0:1)" "$have" "$latest"; then',
  '   echo "updating pi: $have -> $latest ..."; npm install -g --prefix "$HOME/.local" "$PKG@latest" || echo "pi update failed; starting $have";',
  '  elif [ -z "$latest" ]; then echo "could not check for pi updates; starting $have"; fi;',
  ' fi;',
  'fi;',
  'exec pi',
].join(' ');
// single-quoted for the local `sh -c`: the base64 payload has no quote characters
const REMOTE_PI_CMD = `'${remoteBash(REMOTE_PI_SCRIPT)}'`;

function startPty(ws, url) {
  const cols = clampInt(url.searchParams.get('cols'), 10, 1000, 120);
  const rows = clampInt(url.searchParams.get('rows'), 5, 500, 30);
  const cli = path.join(ROOT, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
  const prefix = process.env.PREFIX || '';
  const scriptBin = prefix && existsSync(`${prefix}/bin/script`) ? `${prefix}/bin/script` : 'script';
  const sshParam = url.searchParams.get('ssh');
  const sshCmd = url.searchParams.get('sshop'); // 'copyid' -> interactive ssh-copy-id
  let inner;
  if (sshParam) {
    let target;
    try { target = parseSshTarget(sshParam); } catch (e) { ws.close(1008, e.message); return; }
    const portFlag = target.port ? `-p ${target.port}` : '';
    if (sshCmd === 'copyid') {
      // run ssh-copy-id inside the pty so password entry is interactive
      inner = `stty cols ${cols} rows ${rows}; "${prefix}/bin/bash" "${prefix}/bin/ssh-copy-id" -i "$HOME/.ssh/id_ed25519" ${portFlag} -o "UserKnownHostsFile=$HOME/.ssh/known_hosts" -- "${target.host}"; rc=$?; echo; if [ "$rc" -eq 0 ]; then echo '[SSH_KEY_INSTALLED]'; else echo "[ssh-copy-id failed: $rc]"; fi; echo '[press Enter to continue]'; read -r _ 2>/dev/null`;
    } else {
      // remote pi session over ssh (keys via $HOME/.ssh on this device)
      inner = `stty cols ${cols} rows ${rows}; exec "${prefix}/bin/ssh" -tt ${portFlag} -o "StrictHostKeyChecking=accept-new" -o "UserKnownHostsFile=$HOME/.ssh/known_hosts" -i "$HOME/.ssh/id_ed25519" -- "${target.host}" ${REMOTE_PI_CMD}`;
    }
  } else {
    // -c runs under sh inside the pty: set size first, then replace with pi
    inner = `stty cols ${cols} rows ${rows}; exec "${process.execPath}" "${cli}"`;
  }
  const child = spawn(scriptBin, ['-qfec', inner, '/dev/null'], {
    env: { ...process.env, TERM: 'xterm-256color', COLUMNS: String(cols), LINES: String(rows) },
    cwd: WORKDIR,
  });
  child.stdout.on('data', (d) => { if (ws.readyState === 1) ws.send(d); });
  child.stderr.on('data', (d) => { if (ws.readyState === 1) ws.send(d); });
  child.on('exit', () => { try { ws.close(1000, 'pty exited'); } catch {} });
  child.on('error', (e) => { try { ws.send(`\r\n[pty error] ${e.message}\r\n`); } catch {} });

  // discover the pty slave path so we can push resizes via stty -F
  let ptsPath = null;
  const findPts = setInterval(() => {
    if (ptsPath || !child.pid) { clearInterval(findPts); return; }
    try {
      for (const fd of readdirSync(`/proc/${child.pid}/fd`)) {
        const l = readlinkSync(`/proc/${child.pid}/fd/${fd}`);
        if (l.startsWith('/dev/pts/')) { ptsPath = l; break; }
      }
      if (ptsPath) clearInterval(findPts);
    } catch {}
  }, 300);
  setTimeout(() => clearInterval(findPts), 15000);

  ws.on('message', (data) => {
    // \x01-prefixed frames are JSON control messages, everything else is stdin
    const s = data.toString();
    if (s.charCodeAt(0) === 1) {
      try {
        const msg = JSON.parse(s.slice(1));
        if (msg.resize && ptsPath) {
          const c = clampInt(msg.resize.cols, 10, 1000, cols);
          const r = clampInt(msg.resize.rows, 5, 500, rows);
          spawn(`${prefix}/bin/stty`, ['-F', ptsPath, 'cols', String(c), 'rows', String(r)]);
        }
      } catch {}
      return;
    }
    child.stdin.write(data);
  });
  ws.on('close', () => child.kill('SIGKILL'));
}

// --- start / stop ------------------------------------------------------------

await mkdir(WORKDIR, { recursive: true });
try {
  await initHarness();
} catch (e) {
  // a bridge without a harness is useless: exit so PiService restarts it with backoff
  console.error('initHarness:', e?.stack || e);
  try { await harness.close(ctx); } catch {}
  releaseLock();
  process.exit(1);
}
server.listen(Number(process.env.PI_PORT || 0), '127.0.0.1', async () => {
  listenPort = server.address().port;
  writeFileAtomic(PORT_FILE, String(listenPort), 0o600);
  console.log(`pi-mobile durable bridge on 127.0.0.1:${listenPort}`);
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`bridge: ${signal}, closing`);
  try { unlinkSync(PORT_FILE); } catch {}
  server.close();
  for (const client of sseClients) { try { await client.stream?.stop(); client.res.end(); } catch {} }
  await remoteState.disconnect();
  try { await harness.close(ctx); } catch (e) { console.error('harness.close:', e?.message || e); }
  releaseLock();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
