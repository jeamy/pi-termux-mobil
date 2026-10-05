// remote-provision.mjs — make sure a pi-serverd is running on a remote host.
//
//   const r = await ensureRemoteServer({ ssh, prefix, log });
//   -> { started: false }                      daemon was already running and up to date
//   -> { started: true, mode: 'tmux'|'nohup' } files installed / daemon (re)started;
//      a running daemon whose files hash differs from this device's is updated + restarted
//
// Steps (each reported through log(line)):
//   1. probe over ssh (key login only): node, npm, tmux, running daemon
//   2. daemon missing: copy pi-serverd.mjs + common.mjs + package files to
//      ~/.pi-mobile-remote/runtime and `npm ci --omit=dev` (when changed)
//   3. tmux missing: try to install it with the host's package manager
//      (root or `sudo -n`); if that fails, fall back to nohup + setsid
//   4. start `node pi-serverd.mjs` in tmux session "pi-serverd", wait for socket
//
// Node >= 22 itself is a prerequisite and is not installed automatically.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSshTarget, sshBaseOptions } from './remote-client.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const REMOTE_FILES = ['pi-serverd.mjs', 'common.mjs', 'package.json', 'package-lock.json'];
export const REMOTE_DIR = '.pi-mobile-remote/runtime'; // relative to remote $HOME
export const TMUX_SESSION = 'pi-serverd';

/**
 * Makes node/npm findable in non-interactive shells: version managers (nvm, fnm,
 * volta, asdf, nodenv) set PATH in ~/.bashrc, which `bash -l -c` does not read.
 * Single line, safe to embed.
 */
export const PRELUDE = 'export PATH="$HOME/.local/bin:$HOME/.volta/bin:$HOME/.asdf/shims:$HOME/.nodenv/shims:/opt/homebrew/bin:/usr/local/bin:$PATH"; '
  + 'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; '
  + 'command -v node >/dev/null 2>&1 || { for d in "$HOME/.local/share/fnm" "$HOME/.fnm"; do [ -x "$d/fnm" ] && export PATH="$d:$PATH" && eval "$(fnm env 2>/dev/null)" && break; done; }; ';

/** `bash -l -c` command line carrying `script` base64-encoded (no quoting issues, stdin stays free). */
export function remoteBash(script) {
  return `bash -l -c "$(echo ${Buffer.from(PRELUDE + script).toString('base64')} | base64 -d)"`;
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function runtimeHash(root = ROOT, files = REMOTE_FILES) {
  const h = createHash('sha256');
  for (const f of files) { h.update(f); h.update(readFileSync(path.join(root, f))); }
  return h.digest('hex').slice(0, 16);
}

/** Run a script on the host through `bash -l -c` (login shell: finds node/npm from profile). */
function sshRun({ prefix, host, port, home }, script, { stdin, onLine, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = [...sshBaseOptions(home, port), '--', host, remoteBash(script)];
    const c = spawn(`${prefix}/bin/ssh`, args, { env: process.env });
    let out = '';
    let err = '';
    const feed = (buf, tail) => {
      tail.text += buf;
      let i;
      while ((i = tail.text.indexOf('\n')) >= 0) { const l = tail.text.slice(0, i).trimEnd(); tail.text = tail.text.slice(i + 1); if (l && onLine) onLine(l); }
    };
    const so = { text: '' };
    const se = { text: '' };
    c.stdout.on('data', (d) => { out += d; feed(d, so); });
    c.stderr.on('data', (d) => { err += d; feed(d, se); });
    const timer = setTimeout(() => { c.kill('SIGKILL'); reject(new Error(`timeout after ${timeoutMs / 1000}s`)); }, timeoutMs);
    c.on('error', (e) => { clearTimeout(timer); reject(e); });
    c.on('exit', (code) => {
      clearTimeout(timer);
      if (so.text.trim() && onLine) onLine(so.text.trim());
      if (se.text.trim() && onLine) onLine(se.text.trim());
      resolve({ code, out: out.trim(), err: err.trim() });
    });
    if (stdin !== undefined) c.stdin.end(stdin); else c.stdin.end();
  });
}

const PROBE = `
echo "node=$(node -p 'process.versions.node' 2>/dev/null)"
echo "npm=$(command -v npm 2>/dev/null)"
echo "tmux=$(command -v tmux 2>/dev/null)"
echo "uid=$(id -u)"
echo "auth=$([ -s "$HOME/.pi/agent/auth.json" ] && echo 1 || echo 0)"
D="$HOME/${REMOTE_DIR}"
echo "ver=$(cat "$D/.version" 2>/dev/null)"
echo "deps=$(cat "$D/.deps" 2>/dev/null)"
echo "nm=$([ -d "$D/node_modules/@earendil-works/pi-server" ] && echo 1 || echo 0)"
if [ -S "$HOME/.pi-serverd/server.sock" ] && pgrep -f 'pi-serverd[.]mjs' >/dev/null 2>&1; then echo running=1; else echo running=0; fi
`;

// Installs tmux; prints "tmux-installed" on success. Never fails the shell.
const INSTALL_TMUX = `
if [ "$(id -u)" = 0 ]; then S=""; elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then S="sudo -n"; else S=none; fi
try() { [ "$S" = none ] && { echo "no root/sudo -n for: $*"; return 1; }; $S "$@"; }
export DEBIAN_FRONTEND=noninteractive
if command -v pkg >/dev/null 2>&1 && [ -n "$TERMUX_VERSION" ]; then pkg install -y tmux
elif command -v apt-get >/dev/null 2>&1; then try apt-get install -y tmux || { try apt-get update && try apt-get install -y tmux; }
elif command -v dnf >/dev/null 2>&1; then try dnf install -y tmux
elif command -v yum >/dev/null 2>&1; then try yum install -y tmux
elif command -v pacman >/dev/null 2>&1; then try pacman -S --noconfirm tmux
elif command -v apk >/dev/null 2>&1; then try apk add tmux
elif command -v zypper >/dev/null 2>&1; then try zypper --non-interactive install tmux
elif command -v brew >/dev/null 2>&1; then brew install tmux
else echo "no known package manager"; fi
command -v tmux >/dev/null 2>&1 && echo tmux-installed
true
`;

// stop a running daemon (tmux session or nohup process); must not contain the literal script name
const STOP = `
tmux kill-session -t ${TMUX_SESSION} 2>/dev/null
pkill -TERM -f 'pi-serverd[.]mjs' 2>/dev/null
for i in $(seq 1 20); do pgrep -f 'pi-serverd[.]mjs' >/dev/null 2>&1 || break; sleep 0.5; done
pkill -KILL -f 'pi-serverd[.]mjs' 2>/dev/null
rm -f "$HOME/.pi-serverd/server.sock"
true
`;

const RUN_CMD = `${PRELUDE}cd "$HOME/${REMOTE_DIR}" && exec node pi-serverd.mjs`;
const START_TMUX = `
tmux kill-session -t ${TMUX_SESSION} 2>/dev/null
tmux new-session -d -s ${TMUX_SESSION} ${shq(`exec bash -l -c ${shq(RUN_CMD)}`)}
`;
const START_NOHUP = `
cd "$HOME/${REMOTE_DIR}" || exit 1
if command -v setsid >/dev/null 2>&1; then L=setsid; else L=""; fi
nohup $L bash -l -c ${shq(RUN_CMD)} >> "$HOME/${REMOTE_DIR}/serverd.log" 2>&1 < /dev/null &
`;

function makeCtx(ssh, prefix) {
  const { host, port } = parseSshTarget(ssh);
  return { prefix, host, port, home: process.env.HOME || '/tmp' };
}

async function probeHost(ctx) {
  const probe = await sshRun(ctx, PROBE);
  if (probe.code !== 0) throw new Error(`ssh login failed (${probe.code}): ${probe.err || 'no stderr'}. Is the key installed (⇧key)?`);
  return Object.fromEntries(probe.out.split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
}

const COPY_AUTH = 'umask 077 && mkdir -p "$HOME/.pi/agent" && cat > "$HOME/.pi/agent/auth.json.tmp" && chmod 600 "$HOME/.pi/agent/auth.json.tmp" && mv "$HOME/.pi/agent/auth.json.tmp" "$HOME/.pi/agent/auth.json"';

async function copyAuth_(ctx, authFile, run = (sc, o) => sshRun(ctx, sc, o)) {
  const r = await run(COPY_AUTH, { stdin: readFileSync(authFile) });
  if (r.code !== 0) throw new Error(`copying auth.json failed: ${r.err}`);
}

/** Copy `authFile` to the host's ~/.pi/agent/auth.json (mode 600). Caller must have asked the user. */
export const copyAuthTo = ({ ssh, prefix = '', authFile }) => copyAuth_(makeCtx(ssh, prefix), authFile);

/** Cheap check: { auth: '1'|'0', running: '1'|'0', ... } of the host. */
export const probeRemote = ({ ssh, prefix = '' }) => probeHost(makeCtx(ssh, prefix));

/**
 * copyAuth: true  -> copy `authFile` to the host's ~/.pi/agent/auth.json when it has none
 *           false -> never copy
 * allowUpdate: restart a running daemon whose files differ from this device's (default: leave it)
 */
export async function ensureRemoteServer({ ssh, prefix = '', log = () => {}, copyAuth = false, allowUpdate = false, authFile }) {
  const ctx = makeCtx(ssh, prefix);
  const run = (script, opts) => sshRun(ctx, script, { onLine: (l) => log(`  ${l}`), ...opts });

  log('checking remote host…');
  const info = await probeHost(ctx);
  if (info.auth !== '1') {
    if (copyAuth && authFile) {
      log('copying auth.json to ~/.pi/agent/auth.json (mode 600)…');
      await copyAuth_(ctx, authFile, run);
    } else {
      log('WARNING: no ~/.pi/agent/auth.json on the host: no models, prompts fail with "Internal server error".');
      log('         Add a key there (run `pi` once and /login, or copy auth.json).');
    }
  }
  const want = runtimeHash();
  const wantDeps = runtimeHash(ROOT, ['package.json', 'package-lock.json']);
  const outdated = info.ver !== want;
  if (info.running === '1') {
    if (!outdated) { log(`pi-serverd already running (version ${want})`); return { started: false }; }
    if (!allowUpdate) { log(`pi-serverd is outdated (${info.ver || 'unknown'} -> ${want}); update skipped`); return { started: false }; }
    log(`pi-serverd is outdated (${info.ver || 'unknown'} -> ${want}): updating and restarting…`);
    log('  (running work is interrupted; durable sessions resume after the restart)');
    await run(STOP);
  } else {
    log('pi-serverd not running');
  }
  const major = Number.parseInt(info.node, 10);
  if (!info.node || !(major >= 22)) {
    throw new Error(`Node.js >= 22 is required on the host (found: ${info.node || 'none'}${info.node ? '' : ', node not in PATH of a login shell and not found via nvm/fnm/volta/asdf'}). Install it there first.`);
  }
  if (!info.npm) throw new Error('npm not found on the host');

  // 2. runtime files + dependencies
  if (outdated) {
    log(`installing server files to ~/${REMOTE_DIR}`);
    for (const f of REMOTE_FILES) {
      const r = await run(`mkdir -p "$HOME/${REMOTE_DIR}" && cat > "$HOME/${REMOTE_DIR}/${f}.tmp" && mv "$HOME/${REMOTE_DIR}/${f}.tmp" "$HOME/${REMOTE_DIR}/${f}"`,
        { stdin: readFileSync(path.join(ROOT, f)) });
      if (r.code !== 0) throw new Error(`upload of ${f} failed: ${r.err}`);
    }
    if (info.deps !== wantDeps || info.nm !== '1') {
      log('npm ci (may take a few minutes)…');
      const n = await run(`cd "$HOME/${REMOTE_DIR}" && npm ci --omit=dev --no-audit --no-fund 2>&1 && echo ${wantDeps} > .deps`, { timeoutMs: 15 * 60_000 });
      if (n.code !== 0) throw new Error(`npm ci failed (${n.code})`);
    }
    await run(`echo ${want} > "$HOME/${REMOTE_DIR}/.version"`);
  } else {
    log('server files up to date');
  }

  // 3. tmux
  let tmux = Boolean(info.tmux);
  if (!tmux) {
    log('tmux missing, trying to install…');
    const t = await run(INSTALL_TMUX, { timeoutMs: 10 * 60_000 });
    tmux = /tmux-installed/.test(t.out);
    if (!tmux) log('tmux could not be installed, falling back to nohup');
  }

  // 4. start
  log(tmux ? `starting in tmux session "${TMUX_SESSION}"…` : 'starting with nohup…');
  const s = await run(tmux ? START_TMUX : START_NOHUP);
  if (s.code !== 0) throw new Error(`could not start pi-serverd: ${s.err || s.out}`);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 750));
    const p = await sshRun(ctx, 'test -S "$HOME/.pi-serverd/server.sock" && test -s "$HOME/.pi-serverd/server-id" && echo up');
    if (/up/.test(p.out)) { log('pi-serverd is up'); return { started: true, mode: tmux ? 'tmux' : 'nohup' }; }
  }
  const tail = await sshRun(ctx, tmux ? `tmux capture-pane -p -t ${TMUX_SESSION} 2>&1 | tail -15` : `tail -15 "$HOME/${REMOTE_DIR}/serverd.log"`);
  throw new Error(`pi-serverd did not come up in 30s:\n${tail.out}`);
}
