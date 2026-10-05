// Provision the remote daemon over key-authenticated SSH. A complete release is
// staged before stopping the old daemon; failed starts roll back to the prior release.
import { spawn } from 'node:child_process';
import { createGzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachRemote, parseSshTarget, sshBaseOptions } from './remote-client.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const REMOTE_FILES = ['pi-serverd.mjs', 'common.mjs', 'package.json', 'package-lock.json'];
export const REMOTE_DIR = '.pi-mobile-remote/runtime';
export const TMUX_SESSION = 'pi-serverd';
export const PRELUDE = 'export PATH="$HOME/.local/bin:$HOME/.volta/bin:$HOME/.asdf/shims:$HOME/.nodenv/shims:/opt/homebrew/bin:/usr/local/bin:$PATH"; '
  + 'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; '
  + 'command -v node >/dev/null 2>&1 || { for d in "$HOME/.local/share/fnm" "$HOME/.fnm"; do [ -x "$d/fnm" ] && export PATH="$d:$PATH" && eval "$(fnm env 2>/dev/null)" && break; done; }; ';

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export const remoteBash = (script) => `bash -l -c "$(echo ${Buffer.from(PRELUDE + script).toString('base64')} | base64 -d)"`;
export function runtimeHash(root = ROOT, files = REMOTE_FILES) {
  const h = createHash('sha256');
  for (const f of files) { h.update(f); h.update(readFileSync(path.join(root, f))); }
  return h.digest('hex').slice(0, 16);
}
export function nodeSupported(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version || '');
  if (!m) return false;
  const [major, minor, patch] = m.slice(1).map(Number);
  return major > 22 || (major === 22 && (minor > 19 || (minor === 19 && patch >= 0)));
}
function makeCtx(ssh, prefix) {
  const { host, port } = parseSshTarget(ssh);
  return { prefix, host, port, home: process.env.HOME || '/tmp' };
}

export function sshRun({ prefix, host, port, home }, script, { stdin, onLine, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(`${prefix}/bin/ssh`, [...sshBaseOptions(home, port), '--', host, remoteBash(script)], { env: process.env });
    let out = '', err = '', done = false;
    const tail = (v, d) => (v + d).slice(-32_768); // don't keep unlimited npm output
    let lineBuffer = '';
    const emit = (v) => {
      lineBuffer += String(v);
      let i;
      while ((i = lineBuffer.indexOf('\n')) >= 0) {
        const line = lineBuffer.slice(0, i); lineBuffer = lineBuffer.slice(i + 1);
        if (line.trim()) onLine?.(line.trimEnd());
      }
      if (lineBuffer.length > 8192) { onLine?.(lineBuffer.slice(-8192)); lineBuffer = ''; }
    };
    c.stdout.on('data', (d) => { out = tail(out, d); emit(d); });
    c.stderr.on('data', (d) => { err = tail(err, d); emit(d); });
    const timer = setTimeout(() => { c.kill('SIGKILL'); finish(new Error(`ssh timeout after ${timeoutMs / 1000}s`)); }, timeoutMs);
    const finish = (e, code) => { if (done) return; done = true; clearTimeout(timer); if (e) reject(e); else resolve({ code, out: out.trim(), err: err.trim() }); };
    c.on('error', finish);
    c.on('close', (code) => finish(null, code));
    if (stdin !== undefined) c.stdin.end(stdin); else c.stdin.end();
  });
}

// The lock is owned by pi-serverd. Inspect /proc for the exact PID and expected
// command, not a system-wide pgrep/pkill matching unrelated user processes.
const PID = 'p=$(node -p "try { JSON.parse(require(\'fs\').readFileSync(process.env.HOME+\'/.pi-serverd/serverd.lock\')).pid } catch { 0 }" 2>/dev/null); '
  + 'case "$p" in ""|0|*[!0-9]*) p=0;; esac; '
  + 'if [ "$p" != 0 ] && [ -r "/proc/$p/cmdline" ] && tr "\\0" " " < "/proc/$p/cmdline" | grep -Eq "(^|/)node( |$).*pi-serverd[.]mjs"; then :; else p=0; fi; ';
const PROBE = `
echo "node=$(node -p 'process.versions.node' 2>/dev/null)"
echo "npm=$(command -v npm 2>/dev/null)"
echo "tmux=$(command -v tmux 2>/dev/null)"
echo "auth=$([ -s "$HOME/.pi/agent/auth.json" ] && echo 1 || echo 0)"
D="$HOME/${REMOTE_DIR}"
echo "ver=$(cat "$D/.version" 2>/dev/null)"
echo "deps=$(cat "$D/.deps" 2>/dev/null)"
echo "nm=$([ -d "$D/node_modules/@earendil-works/pi-server" ] && echo 1 || echo 0)"
${PID}
if [ "$p" != 0 ] && [ -S "$HOME/.pi-serverd/server.sock" ]; then echo running=1; else echo running=0; fi
`;
async function probeHost(ctx) {
  const r = await sshRun(ctx, PROBE);
  if (r.code !== 0) throw new Error(`ssh login failed (${r.code}): ${r.err || 'no stderr'}`);
  return Object.fromEntries(r.out.split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
}
export const probeRemote = ({ ssh, prefix = '' }) => probeHost(makeCtx(ssh, prefix));
const COPY_AUTH = 'umask 077; mkdir -p "$HOME/.pi/agent" && chmod 700 "$HOME/.pi/agent" && '
  + 'test ! -e "$HOME/.pi/agent/auth.json" && cat > "$HOME/.pi/agent/auth.json.tmp" && '
  + 'chmod 600 "$HOME/.pi/agent/auth.json.tmp" && ln "$HOME/.pi/agent/auth.json.tmp" "$HOME/.pi/agent/auth.json" && rm "$HOME/.pi/agent/auth.json.tmp"';
export async function copyAuthTo({ ssh, prefix = '', authFile }) {
  const r = await sshRun(makeCtx(ssh, prefix), COPY_AUTH, { stdin: readFileSync(authFile) });
  if (r.code !== 0) throw new Error(`auth.json upload failed: ${r.err || 'file already exists?'}`);
}

const INSTALL_TMUX = `
if [ "$(id -u)" = 0 ]; then S=""; elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then S="sudo -n"; else S=none; fi
try() { [ "$S" = none ] && return 1; $S "$@"; }
export DEBIAN_FRONTEND=noninteractive
if command -v pkg >/dev/null 2>&1 && [ -n "$TERMUX_VERSION" ]; then pkg install -y tmux
elif command -v apt-get >/dev/null 2>&1; then try apt-get install -y tmux || { try apt-get update && try apt-get install -y tmux; }
elif command -v dnf >/dev/null 2>&1; then try dnf install -y tmux
elif command -v yum >/dev/null 2>&1; then try yum install -y tmux
elif command -v pacman >/dev/null 2>&1; then try pacman -S --noconfirm tmux
elif command -v apk >/dev/null 2>&1; then try apk add tmux
elif command -v zypper >/dev/null 2>&1; then try zypper --non-interactive install tmux
elif command -v brew >/dev/null 2>&1; then brew install tmux
fi
command -v tmux >/dev/null 2>&1 && echo tmux-installed
true`;
const STOP = `${PID} [ "$p" != 0 ] || exit 1; kill -TERM "$p"; for i in $(seq 1 20); do kill -0 "$p" 2>/dev/null || exit 0; sleep .5; done; kill -KILL "$p" 2>/dev/null;`;
const RUN_CMD = `${PRELUDE}cd "$HOME/${REMOTE_DIR}" && exec node pi-serverd.mjs`;
const START_TMUX = `tmux has-session -t ${TMUX_SESSION} 2>/dev/null && exit 1; tmux new-session -d -s ${TMUX_SESSION} ${shq(`exec bash -l -c ${shq(RUN_CMD)}`)}`;
const START_NOHUP = `cd "$HOME/${REMOTE_DIR}" || exit 1; if command -v setsid >/dev/null 2>&1; then L=setsid; else L=""; fi; nohup $L bash -l -c ${shq(RUN_CMD)} >> "$HOME/${REMOTE_DIR}/serverd.log" 2>&1 < /dev/null &`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function ensureRemoteServer({ ssh, prefix = '', log = () => {}, copyAuth = false, allowUpdate = false, authFile }) {
  const ctx = makeCtx(ssh, prefix);
  const run = (cmd, opts) => sshRun(ctx, cmd, { onLine: log, ...opts });
  log('checking remote host…');
  const info = await probeHost(ctx);
  if (info.auth !== '1') {
    if (copyAuth && authFile) { await copyAuthTo({ ssh, prefix, authFile }); log('auth.json copied'); }
    else log('WARNING: no auth.json on host; no models available');
  }
  const want = runtimeHash(), deps = runtimeHash(ROOT, ['package.json', 'package-lock.json']);
  const outdated = info.ver !== want;
  if (info.running === '1' && !outdated) {
    // A socket and PID can be stale or hung; verify the actual pi-server protocol.
    try {
      const peer = await attachRemote({ ssh, prefix });
      try { await peer.list(); } finally { await peer.disconnect(); }
      log(`pi-serverd healthy (${want})`);
      return { started: false };
    } catch (e) {
      log(`pi-serverd health check failed: ${e?.message || e}; restarting it`);
      const stopped = await run(STOP);
      if (stopped.code !== 0) throw new Error(`could not stop unhealthy daemon: ${stopped.err}`);
      info.running = '0';
    }
  }
  if (info.running === '1' && !allowUpdate) { log('outdated daemon: update skipped'); return { started: false }; }
  if (!nodeSupported(info.node)) throw new Error(`Node.js >=22.19.0 required (found ${info.node || 'none'}). Update Node on the host first.`);
  if (!info.npm) throw new Error('npm not found on host');
  const base = `$HOME/.pi-mobile-remote`;
  const stage = `${base}/stage-${want}`;
  let staged = false, swapped = false;
  try {
    if (outdated) {
      log(`staging pi-serverd ${want}…`);
      // build gzip tar in-process: avoids spawning external gzip (fails in Android sandbox)
      const tarBuf = await new Promise((resolve, reject) => {
        const chunks = [];
        const gz = createGzip();
        gz.on('data', (d) => chunks.push(d));
        gz.on('end',  () => resolve(Buffer.concat(chunks)));
        gz.on('error', reject);
        const tarBin = prefix ? `${prefix}/bin/tar` : 'tar';
        const t = spawn(tarBin, ['cf', '-', ...REMOTE_FILES], { cwd: ROOT });
        t.stdout.pipe(gz);
        let tarErr = '';
        t.stderr.on('data', (d) => { tarErr += d; });
        t.on('error', reject);
        t.on('close', (code) => { if (code !== 0) { gz.destroy(); reject(new Error(`tar failed (${code}): ${tarErr.trim()}`)); } });
      });
      const uploaded = await run(`umask 077; mkdir -p "${base}" && rm -rf "${stage}" && mkdir "${stage}" && tar xzf - -C "${stage}"`, { stdin: tarBuf });
      if (uploaded.code !== 0) throw new Error(`upload failed: ${uploaded.err}`);
      staged = true;
      if (info.deps === deps && info.nm === '1') {
        const copied = await run(`cp -a "${base}/runtime/node_modules" "${stage}/node_modules"`);
        if (copied.code !== 0) throw new Error(`dependency copy failed: ${copied.err}`);
      } else {
        log('npm ci (may take minutes)…');
        const installed = await run(`cd "${stage}" && npm ci --omit=dev --no-audit --no-fund 2>&1`, { timeoutMs: 15 * 60_000 });
        if (installed.code !== 0) throw new Error(`npm ci failed: ${installed.err || installed.out}`);
      }
      const markers = await run(`printf '%s\\n' ${shq(want)} > "${stage}/.version" && printf '%s\\n' ${shq(deps)} > "${stage}/.deps"`);
      if (markers.code !== 0) throw new Error(`markers failed: ${markers.err}`);
    }
    let tmux = Boolean(info.tmux);
    if (!tmux) {
      log('tmux missing; attempting install…');
      const r = await run(INSTALL_TMUX, { timeoutMs: 10 * 60_000 });
      tmux = r.out.includes('tmux-installed');
      if (!tmux) log('using nohup instead');
    }
    if (info.running === '1') {
      log('staging complete; stopping old daemon…');
      const r = await run(STOP);
      if (r.code !== 0) throw new Error(`could not stop old daemon: ${r.err}`);
    }
    if (staged) {
      // Preserve the old release for rollback. All renames are within one filesystem.
      const r = await run(`rm -rf "${base}/runtime.prev" && { [ ! -e "${base}/runtime" ] || mv "${base}/runtime" "${base}/runtime.prev"; } && mv "${stage}" "${base}/runtime"`);
      if (r.code !== 0) throw new Error(`release swap failed: ${r.err}`);
      swapped = true;
    }
    const start = await run(tmux ? START_TMUX : START_NOHUP);
    if (start.code !== 0) throw new Error(`daemon start failed: ${start.err || start.out}`);
    // Check for a live process AND a socket, not just a stale socket pathname.
    for (let i = 0; i < 40; i++) {
      await sleep(750);
      const p = await probeHost(ctx);
      if (p.running === '1') {
        const peer = await attachRemote({ ssh, prefix });
        try { await peer.list(); } finally { await peer.disconnect(); }
        log('pi-serverd answered sessions.list');
        return { started: true, mode: tmux ? 'tmux' : 'nohup' };
      }
    }
    throw new Error('pi-serverd did not start in 30s');
  } catch (e) {
    if (staged && !swapped) await run(`rm -rf "${stage}"`);
    if (swapped) {
      log(`start failed (${e.message}); rolling back…`);
      await run(`${PID} if [ "$p" != 0 ]; then kill -TERM "$p" 2>/dev/null; fi; rm -rf "${base}/runtime.failed"; mv "${base}/runtime" "${base}/runtime.failed"; if [ -d "${base}/runtime.prev" ]; then mv "${base}/runtime.prev" "${base}/runtime"; ${START_NOHUP}; fi`);
    }
    throw e;
  }
}
