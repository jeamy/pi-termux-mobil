// Provision the remote daemon over key-authenticated SSH. A complete release is
// staged before stopping the old daemon; failed starts roll back to the prior release.
import { spawn } from 'node:child_process';
import { createGzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachRemote, parseSshTarget, sshBaseOptions, withDeadline } from './remote-client.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const REMOTE_FILES = ['pi-serverd.mjs', 'common.mjs', 'pi-spaces.mjs', 'package.json', 'package-lock.json'];
// Generated CLI examples are optional, not needed by the daemon. Hash and
// upload the same manifest so a fresh checkout remains deployable.
export function remoteFiles(root = ROOT) {
  const files = [...REMOTE_FILES];
  if (existsSync(path.join(root, 'space-examples'))) files.push('space-examples');
  for (const file of files) {
    if (!existsSync(path.join(root, file))) throw new Error(`Required remote runtime file missing: ${file}; restore the runtime bundle first`);
  }
  return files;
}
export const REMOTE_DIR = '.pi-mobile-remote/runtime';
export const TMUX_SESSION = 'pi-serverd';
export const PRELUDE = 'export PATH="$HOME/.local/bin:$HOME/.volta/bin:$HOME/.asdf/shims:$HOME/.nodenv/shims:/opt/homebrew/bin:/usr/local/bin:$PATH"; '
  + 'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; '
  + 'command -v node >/dev/null 2>&1 || { for d in "$HOME/.local/share/fnm" "$HOME/.fnm"; do [ -x "$d/fnm" ] && export PATH="$d:$PATH" && eval "$(fnm env 2>/dev/null)" && break; done; }; ';

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export const remoteBash = (script) => `bash -l -c "$(echo ${Buffer.from(PRELUDE + script).toString('base64')} | base64 -d)"`;
export function runtimeHash(root = ROOT, files = remoteFiles(root)) {
  const h = createHash('sha256');
  const hashPath = (relative) => {
    const full = path.join(root, relative);
    h.update(relative);
    if (statSync(full).isDirectory()) {
      for (const name of readdirSync(full).sort()) hashPath(path.posix.join(relative, name));
    } else h.update(readFileSync(full));
  };
  for (const f of files) hashPath(f);
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

export function sshRun({ prefix, host, port, home }, script, { stdin, onLine, timeoutMs = 60_000, signal } = {}) {
  return withDeadline((bounded) => new Promise((resolve, reject) => {
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
    const abort = () => { c.kill('SIGKILL'); finish(bounded.reason); };
    const finish = (e, code) => {
      if (done) return;
      done = true;
      bounded.removeEventListener('abort', abort);
      if (e) reject(e); else resolve({ code, out: out.trim(), err: err.trim() });
    };
    bounded.addEventListener('abort', abort, { once: true });
    c.on('error', finish);
    // Early SSH failure during upload must not crash the bridge with EPIPE.
    c.stdin.on('error', (e) => { c.kill('SIGKILL'); finish(e); });
    c.on('close', (code) => finish(null, code));
    if (stdin !== undefined) c.stdin.end(stdin); else c.stdin.end();
  }), { timeoutMs, signal });
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
async function probeHost(ctx, signal) {
  const r = await sshRun(ctx, PROBE, { signal });
  if (r.code !== 0) throw new Error(`ssh login failed (${r.code}): ${r.err || 'no stderr'}`);
  return Object.fromEntries(r.out.split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
}
export const probeRemote = ({ ssh, prefix = '' }) => probeHost(makeCtx(ssh, prefix));
const COPY_AUTH = 'umask 077; mkdir -p "$HOME/.pi/agent" && chmod 700 "$HOME/.pi/agent" && '
  + 'test ! -e "$HOME/.pi/agent/auth.json" && cat > "$HOME/.pi/agent/auth.json.tmp" && '
  + 'chmod 600 "$HOME/.pi/agent/auth.json.tmp" && ln "$HOME/.pi/agent/auth.json.tmp" "$HOME/.pi/agent/auth.json" && rm "$HOME/.pi/agent/auth.json.tmp"';
export async function copyAuthTo({ ssh, prefix = '', authFile, signal }) {
  const r = await sshRun(makeCtx(ssh, prefix), COPY_AUTH, { stdin: readFileSync(authFile), signal });
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
const STOP_PROCESS = 'kill -TERM "$p" 2>/dev/null || true; for i in $(seq 1 20); do kill -0 "$p" 2>/dev/null || break; sleep .5; done; if kill -0 "$p" 2>/dev/null; then kill -KILL "$p" || exit 1; fi;';
const STOP = `${PID} [ "$p" != 0 ] || exit 1; ${STOP_PROCESS}`;
// Stop the daemon on the host (also ends its tmux session, since node is exec'd in it).
// Returns false when no pi-serverd was running. Next connect provisions/updates again.
export async function stopRemoteServer({ ssh, prefix = '', log = () => {} }) {
  const ctx = makeCtx(ssh, prefix);
  const info = await probeHost(ctx);
  if (info.running !== '1') { await sshRun(ctx, `tmux kill-session -t ${TMUX_SESSION} 2>/dev/null; true`); return false; }
  const r = await sshRun(ctx, STOP, { onLine: log });
  if (r.code !== 0) throw new Error(`could not stop pi-serverd: ${r.err}`);
  await sshRun(ctx, `tmux kill-session -t ${TMUX_SESSION} 2>/dev/null; true`);
  return true;
}
const RUN_CMD = `${PRELUDE}cd "$HOME/${REMOTE_DIR}" && exec node pi-serverd.mjs`;
const START_TMUX = `tmux has-session -t ${TMUX_SESSION} 2>/dev/null && exit 1; tmux new-session -d -s ${TMUX_SESSION} ${shq(`exec bash -l -c ${shq(RUN_CMD)}`)}`;
const START_NOHUP = `cd "$HOME/${REMOTE_DIR}" || exit 1; if command -v setsid >/dev/null 2>&1; then L=setsid; else L=""; fi; nohup $L bash -l -c ${shq(RUN_CMD)} >> "$HOME/${REMOTE_DIR}/serverd.log" 2>&1 < /dev/null &`;
/** Recover a promoted release OR the gap between renames. Inspect remote
 * markers instead of relying on a local 'swapped' flag after a lost response.
 */
export function rollbackReleaseScript(base, want) {
  return `if [ "$(cat "${base}/runtime/.version" 2>/dev/null)" = ${shq(want)} ]; then
    ${PID} if [ "$p" != 0 ]; then ${STOP_PROCESS} fi
    rm -rf "${base}/runtime.failed" && mv "${base}/runtime" "${base}/runtime.failed" || exit 1
  fi
  if [ ! -e "${base}/runtime" ] && [ -d "${base}/runtime.prev" ]; then
    mv "${base}/runtime.prev" "${base}/runtime" || exit 1
  fi`;
}

export async function ensureRemoteServer({ ssh, prefix = '', log = () => {}, copyAuth = false, allowUpdate = false, authFile, signal }) {
  const ctx = makeCtx(ssh, prefix);
  const run = (cmd, opts) => sshRun(ctx, cmd, { onLine: log, signal, ...opts });
  log('checking remote host…');
  const info = await probeHost(ctx, signal);
  if (info.auth !== '1') {
    if (copyAuth && authFile) { await copyAuthTo({ ssh, prefix, authFile, signal }); log('auth.json copied'); }
    else log('WARNING: no auth.json on host; no models available');
  }
  const files = remoteFiles();
  const want = runtimeHash(ROOT, files), deps = runtimeHash(ROOT, ['package.json', 'package-lock.json']);
  const outdated = info.ver !== want;
  if (info.running === '1' && !outdated) {
    // A socket and PID can be stale or hung; verify the actual pi-server protocol.
    try {
      const peer = await attachRemote({ ssh, prefix, signal });
      try { await peer.list(); } finally { await peer.disconnect(); }
      log(`pi-serverd healthy (${want})`);
      return { started: false };
    } catch (e) {
      signal?.throwIfAborted();
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
  let staged = false, swapAttempted = false;
  try {
    if (outdated) {
      log(`staging pi-serverd ${want}…`);
      // build gzip tar in-process: avoids spawning external gzip (fails in Android sandbox)
      const tarBuf = await withDeadline((bounded) => new Promise((resolve, reject) => {
        const chunks = [];
        const gz = createGzip();
        gz.on('data', (d) => chunks.push(d));
        gz.on('end',  () => resolve(Buffer.concat(chunks)));
        gz.on('error', reject);
        const tarBin = prefix ? `${prefix}/bin/tar` : 'tar';
        const t = spawn(tarBin, ['cf', '-', ...files], { cwd: ROOT });
        const abort = () => { t.kill('SIGKILL'); gz.destroy(); reject(bounded.reason); };
        bounded.addEventListener('abort', abort, { once: true });
        t.stdout.pipe(gz);
        let tarErr = '';
        t.stderr.on('data', (d) => { tarErr += d; });
        t.on('error', reject);
        t.on('close', (code) => {
          bounded.removeEventListener('abort', abort);
          if (code !== 0) { gz.destroy(); reject(new Error(`tar failed (${code}): ${tarErr.trim()}`)); }
        });
      }), { signal, timeoutMs: 60_000 });
      staged = true;
      const uploaded = await run(`umask 077; mkdir -p "${base}" && rm -rf "${stage}" && mkdir "${stage}" && tar xzf - -C "${stage}"`, { stdin: tarBuf });
      if (uploaded.code !== 0) throw new Error(`upload failed: ${uploaded.err}`);
      if (info.deps === deps && info.nm === '1') {
        const copied = await run(`cp -a "${base}/runtime/node_modules" "${stage}/node_modules"`);
        if (copied.code !== 0) throw new Error(`dependency copy failed: ${copied.err}`);
      } else {
        log('npm install (may take minutes)…');
        const installed = await run(`cd "${stage}" && npm install --omit=dev --no-audit --no-fund --ignore-scripts --no-package-lock 2>&1`, { timeoutMs: 15 * 60_000 });
        if (installed.code !== 0) throw new Error(`npm install failed: ${installed.err || installed.out}`);
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
      // Mark BEFORE dispatch: failures between renames and lost SSH responses
      // must both restore the preceding release and restart it.
      swapAttempted = true;
      const r = await run(`rm -rf "${base}/runtime.prev" && { [ ! -e "${base}/runtime" ] || mv "${base}/runtime" "${base}/runtime.prev"; } && mv "${stage}" "${base}/runtime"`);
      if (r.code !== 0) throw new Error(`release swap failed: ${r.err}`);
    }
    const start = await run(tmux ? START_TMUX : START_NOHUP);
    if (start.code !== 0) throw new Error(`daemon start failed: ${start.err || start.out}`);
    // Check for a live process AND a socket, not just a stale socket pathname.
    for (let i = 0; i < 40; i++) {
      await sleep(750, undefined, { signal });
      const p = await probeHost(ctx, signal);
      if (p.running === '1') {
        const peer = await attachRemote({ ssh, prefix, signal });
        try { await peer.list(); } finally { await peer.disconnect(); }
        log('pi-serverd answered sessions.list');
        return { started: true, mode: tmux ? 'tmux' : 'nohup' };
      }
    }
    throw new Error('pi-serverd did not start in 30s');
  } catch (e) {
    // Recovery must still run after the caller cancelled provisioning.
    try {
      if (swapAttempted) {
        log(`deployment failed (${e.message}); rolling back…`);
        const r = await run(`${rollbackReleaseScript(base, want)}
          if [ -d "${base}/runtime" ]; then
            ${START_NOHUP}
          fi`, { signal: undefined });
        if (r.code !== 0) throw new Error(r.err || 'release restore failed');
      }
      if (staged) await run(`rm -rf "${stage}"`, { signal: undefined });
    } catch (rollbackError) {
      throw new Error(`${e.message}; rollback/cleanup failed: ${rollbackError.message}`, { cause: e });
    }
    throw e;
  }
}
