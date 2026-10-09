// SSH Unix-socket bridge. Private sockets keep other phone apps out of the
// unauthenticated pi-server protocol; SSH authenticates the remote peer.
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { Client } from '@earendil-works/pi-client';
import { createUnixTransportFactory } from '@earendil-works/pi-client/unix';

const strictJson = (args) => JSON.parse(JSON.stringify(args ?? []));

/** Bound operations even when the underlying peer never answers. */
export async function withDeadline(operation, { timeoutMs = 15_000, signal } = {}) {
  const timerController = new AbortController();
  const timer = setTimeout(() => timerController.abort(new Error(`remote timeout after ${timeoutMs / 1000}s`)), timeoutMs);
  const bounded = signal ? AbortSignal.any([signal, timerController.signal]) : timerController.signal;
  let onAbort;
  try {
    bounded.throwIfAborted();
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(bounded.reason);
      bounded.addEventListener('abort', onAbort, { once: true });
    });
    return await Promise.race([operation(bounded), cancelled]);
  } finally {
    clearTimeout(timer);
    if (onAbort) bounded.removeEventListener('abort', onAbort);
  }
}

/** Reject SSH options and anything requiring shell quoting. */
export function parseSshTarget(value) {
  const target = String(value || '').trim();
  const match = /^([A-Za-z0-9_][A-Za-z0-9_.-]*@)?([A-Za-z0-9_][A-Za-z0-9_.-]*)(?::(\d{1,5}))?$/.exec(target);
  if (!match) throw new Error('invalid SSH target (expected user@host[:port])');
  const port = match[3] ? Number(match[3]) : undefined;
  if (port !== undefined && (port < 1 || port > 65535)) throw new Error('invalid SSH target port');
  return { host: `${match[1] ?? ''}${match[2]}`, port };
}

export function sshBaseOptions(home, port) {
  return ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${home}/.ssh/known_hosts`, '-i', `${home}/.ssh/id_ed25519`,
    '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    ...(port ? ['-p', String(port)] : [])];
}

function capture(command, args, options) {
  return withDeadline((signal) => new Promise((resolve, reject) => {
    const c = spawn(command, args, { env: process.env });
    let out = '', err = '';
    const abort = () => { c.kill('SIGKILL'); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    c.stdout.on('data', (d) => { out = (out + d).slice(-32_768); });
    c.stderr.on('data', (d) => { err = (err + d).slice(-32_768); });
    c.on('error', reject);
    c.on('close', (code) => {
      signal.removeEventListener('abort', abort);
      code === 0 ? resolve(out.trim()) : reject(new Error(`ssh command failed (${code}): ${err.trim() || 'no stderr'}`));
    });
    c.stdin.end();
  }), options);
}

export async function sshHostFingerprint(ssh, prefix = '', options = {}) {
  const { host, port } = parseSshTarget(ssh);
  const home = process.env.HOME || '/tmp';
  const bare = host.replace(/^.*@/, '');
  try {
    const out = await capture(`${prefix}/bin/ssh-keygen`, ['-l', '-F', port ? `[${bare}]:${port}` : bare,
      '-f', `${home}/.ssh/known_hosts`], options);
    return /(SHA256:\S+)/.exec(out)?.[1] ?? null;
  } catch (e) {
    if (options.signal?.aborted) throw e;
    return null;
  }
}

export async function attachRemote({ ssh, prefix = '', socketDir, serverId, remoteSock,
  signal, timeoutMs = 15_000, requestTimeoutMs = 35_000 }) {
  const sshBin = `${prefix}/bin/ssh`;
  const { host: sshHost, port: sshPort } = parseSshTarget(ssh);
  const home = process.env.HOME || '/tmp';
  const lifetime = new AbortController();
  const alive = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  alive.throwIfAborted();
  const name = `${crypto.randomBytes(6).toString('hex')}.sock`;
  let dir = socketDir || path.join(home, '.pi-mobile', 'tunnels');
  if (Buffer.byteLength(path.join(dir, name)) > 100) dir = path.join(os.tmpdir(), `pi-tun-${process.getuid?.() ?? 'u'}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const localSock = path.join(dir, name);
  const sshOpts = sshBaseOptions(home, sshPort);
  const sshExec = (cmd) => capture(sshBin, [...sshOpts, '--', sshHost, cmd], { signal: alive, timeoutMs });
  const remotePath = remoteSock || `${await sshExec('echo $HOME')}/.pi-serverd/server.sock`;
  const sid = serverId || await sshExec('cat ~/.pi-serverd/server-id');
  const hostKey = await sshHostFingerprint(ssh, prefix, { signal: alive, timeoutMs });

  let tunnel = null, client = null, opening = null;
  let closed = false, lostFired = false;
  const lostHandlers = new Set();
  const fireLost = (why) => {
    if (closed || alive.aborted || lostFired) return;
    lostFired = true;
    for (const h of lostHandlers) { try { h(why); } catch {} }
  };

  async function teardown() {
    const c = client, t = tunnel;
    client = null; tunnel = null;
    try { await c?.dispose(); } catch {}
    try { t?.kill('SIGKILL'); } catch {}
    try { unlinkSync(localSock); } catch {}
  }

  async function open() {
    try {
      await withDeadline(async (bounded) => {
        try { unlinkSync(localSock); } catch {}
        const t = spawn(sshBin, ['-N', ...sshOpts, '-o', 'ExitOnForwardFailure=yes',
          '-o', 'StreamLocalBindUnlink=yes', '-o', 'StreamLocalBindMask=0177',
          '-L', `${localSock}:${remotePath}`, '--', sshHost], { env: process.env });
        tunnel = t;
        let err = '', exited = null;
        const abortTunnel = () => t.kill('SIGKILL');
        bounded.addEventListener('abort', abortTunnel, { once: true });
        t.stderr.on('data', (d) => { err = (err + d).slice(-32_768); });
        t.on('exit', (code) => { exited = code ?? -1; if (tunnel === t) fireLost(`ssh tunnel exited ${exited}`); });
        t.on('error', (e) => { exited = -1; err += e.message; });
        try {
          while (!existsSync(localSock)) {
            bounded.throwIfAborted();
            if (exited !== null) throw new Error(`ssh tunnel exited ${exited}: ${err.trim()}`);
            await sleep(100, undefined, { signal: bounded });
          }
          let lastError;
          for (let i = 0; i < 20; i++) {
            bounded.throwIfAborted();
            const c = new Client({ serverId: sid, transportFactory: createUnixTransportFactory({ path: localSock }) });
            const abortClient = () => { void c.dispose(); };
            bounded.addEventListener('abort', abortClient, { once: true });
            try {
              await c.connect();
              bounded.throwIfAborted();
              c.onConnectionStateChange((change) => {
                if (client === c && change.state === 'disconnected') fireLost('connection closed');
              });
              client = c;
              lostFired = false;
              return;
            } catch (e) {
              await c.dispose();
              bounded.throwIfAborted();
              lastError = e;
            } finally { bounded.removeEventListener('abort', abortClient); }
            await sleep(150, undefined, { signal: bounded });
          }
          throw lastError ?? new Error('connect failed');
        } finally { bounded.removeEventListener('abort', abortTunnel); }
      }, { signal: alive, timeoutMs });
      alive.throwIfAborted();
    } catch (e) { await teardown(); throw e; }
  }

  const onAbort = () => { void teardown(); };
  alive.addEventListener('abort', onAbort, { once: true });
  try { await open(); } catch (e) { alive.removeEventListener('abort', onAbort); throw e; }

  const call = (target, serviceId, member, args) => withDeadline((bounded) => {
    if (closed || !client?.connected) throw new Error('disconnected');
    return client.request(target, { serviceId, member, args: strictJson(args) }, bounded);
  }, { signal: alive, timeoutMs: requestTimeoutMs });
  const serverCall = (member, args = []) => call({ serverId: sid }, 'sessions', member, args);

  return {
    get client() { return client; },
    serverId: sid, target: ssh, hostKey,
    get connected() { return !closed && !alive.aborted && Boolean(client?.connected) && !lostFired; },
    onLost(handler) { lostHandlers.add(handler); return () => lostHandlers.delete(handler); },
    list: () => serverCall('list'),
    models: () => serverCall('models'),
    create: (opts = {}) => serverCall('create', [opts]),
    delete: (id) => serverCall('delete', [id]),
    rename: (id, name) => serverCall('rename', [id, name]),
    attach: (id) => serverCall('attach', [id]),
    async request(member, args = []) {
      if (!client?.attachment) throw new Error('not attached');
      return call(client.attachment, 'chat', member, args);
    },
    async reconnect() {
      if (closed || alive.aborted) throw new Error('disconnected');
      if (!opening) {
        opening = (async () => { await teardown(); alive.throwIfAborted(); await open(); })();
      }
      const pending = opening;
      try { await pending; } finally { if (opening === pending) opening = null; }
    },
    async disconnect() {
      closed = true;
      lostHandlers.clear();
      lifetime.abort(new Error('disconnected'));
      try { await opening; } catch {}
      await teardown();
      alive.removeEventListener('abort', onAbort);
    },
  };
}
