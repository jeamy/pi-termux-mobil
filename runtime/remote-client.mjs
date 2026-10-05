// remote-client.mjs — attach to a remote pi-serverd over ssh unix-socket
// forwarding. Usage (in server.mjs):
//   const remote = await attachRemote({ ssh: 'user@host[:port]', prefix, socketDir });
//   await remote.list() / remote.attach(id) / remote.request(member, args)
//   remote.onLost(cb); await remote.reconnect();
//
// The tunnel forwards a unix socket in the app-private directory to the remote
// socket (-L local.sock:remote.sock). A loopback TCP port would be reachable by
// every app on the phone, and pi-server does not authenticate peers.
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { Client } from '@earendil-works/pi-client';
import { createUnixTransportFactory } from '@earendil-works/pi-client/unix';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the protocol is strict JSON: drop undefined fields instead of sending them
const strictJson = (args) => JSON.parse(JSON.stringify(args ?? []));

/**
 * Parse and validate `user@host[:port]`. Rejects anything ssh could read as an
 * option (leading '-') or that needs shell quoting.
 */
export function parseSshTarget(value) {
  const target = String(value || '').trim();
  const match = /^([A-Za-z0-9_][A-Za-z0-9_.-]*@)?([A-Za-z0-9_][A-Za-z0-9_.-]*)(?::(\d{1,5}))?$/.exec(target);
  if (!match) throw new Error('invalid SSH target (expected user@host[:port])');
  const port = match[3] ? Number(match[3]) : undefined;
  if (port !== undefined && (port < 1 || port > 65535)) throw new Error('invalid SSH target port');
  return { host: `${match[1] ?? ''}${match[2]}`, port };
}

/** Non-interactive ssh options shared by the tunnel and the provisioning calls. */
export function sshBaseOptions(home, port) {
  return ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${home}/.ssh/known_hosts`, '-i', `${home}/.ssh/id_ed25519`,
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    ...(port ? ['-p', String(port)] : [])];
}

export async function attachRemote({ ssh, prefix = '', socketDir, serverId, remoteSock }) {
  const sshBin = `${prefix}/bin/ssh`;
  const { host: sshHost, port: sshPort } = parseSshTarget(ssh);
  const home = process.env.HOME || '/tmp';
  // sun_path is limited to ~108 bytes: fall back to a short private dir
  const name = `${crypto.randomBytes(6).toString('hex')}.sock`;
  let dir = socketDir || path.join(home, '.pi-mobile', 'tunnels');
  if (Buffer.byteLength(path.join(dir, name)) > 100) dir = path.join(os.tmpdir(), `pi-tun-${process.getuid?.() ?? 'u'}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const localSock = path.join(dir, name);
  const sshOpts = sshBaseOptions(home, sshPort);

  const sshExec = (remoteCmd) => new Promise((resolve, reject) => {
    const c = spawn(sshBin, [...sshOpts, '--', sshHost, remoteCmd], { env: process.env });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('exit', (code) => code === 0
      ? resolve(out.trim())
      : reject(new Error(`ssh "${remoteCmd}" failed (${code}): ${err.trim() || 'no stderr'}`)));
    c.on('error', reject);
  });

  // -L does not expand ~ for the remote socket
  let remotePath = remoteSock;
  if (!remotePath) {
    let remoteHome;
    try { remoteHome = await sshExec('echo $HOME'); } catch (e) { throw new Error(`ssh exec failed: ${e.message}`); }
    remotePath = `${remoteHome}/.pi-serverd/server.sock`;
  }
  const sid = serverId || await sshExec('cat ~/.pi-serverd/server-id');

  // StrictHostKeyChecking=accept-new trusts the first key it sees (TOFU):
  // report the stored fingerprint so the user can compare it once.
  const bareHost = sshHost.replace(/^.*@/, '');
  const hostKey = await new Promise((resolve) => {
    const kg = spawn(`${prefix}/bin/ssh-keygen`, ['-l', '-F', sshPort ? `[${bareHost}]:${sshPort}` : bareHost,
      '-f', `${home}/.ssh/known_hosts`], { env: process.env });
    let out = '';
    kg.stdout.on('data', (d) => { out += d; });
    kg.on('exit', () => resolve(/(SHA256:\S+)/.exec(out)?.[1] ?? null));
    kg.on('error', () => resolve(null));
  });

  let tunnel = null;
  let client = null;
  let closed = false;
  let lostHandlers = new Set();
  let lostFired = false;
  const fireLost = (why) => {
    if (closed || lostFired) return;
    lostFired = true;
    for (const h of lostHandlers) { try { h(why); } catch {} }
  };

  async function openTunnel() {
    try { unlinkSync(localSock); } catch {}
    const t = spawn(sshBin, ['-N', ...sshOpts, '-o', 'ExitOnForwardFailure=yes',
      '-o', 'StreamLocalBindUnlink=yes', '-o', 'StreamLocalBindMask=0177',
      '-L', `${localSock}:${remotePath}`, '--', sshHost], { env: process.env });
    let err = '';
    let exited = null;
    t.stderr.on('data', (d) => { err += d; });
    t.on('exit', (code) => { exited = code ?? -1; if (tunnel === t) fireLost(`ssh tunnel exited ${exited}`); });
    t.on('error', (e) => { exited = -1; err += e.message; });
    // wait until ssh has bound the local socket (or failed)
    const deadline = Date.now() + 15_000;
    while (!existsSync(localSock)) {
      if (exited !== null) throw new Error(`ssh tunnel exited ${exited}: ${err.trim()}`);
      if (Date.now() > deadline) { t.kill('SIGKILL'); throw new Error(`ssh tunnel timeout: ${err.trim()}`); }
      await sleep(100);
    }
    return t;
  }

  async function open() {
    tunnel = await openTunnel();
    lostFired = false;
    let lastError;
    for (let i = 0; i < 20; i++) { // the socket exists before the remote side answers
      try {
        const c = await Client.connect({ serverId: sid, transportFactory: createUnixTransportFactory({ path: localSock }) });
        c.onConnectionStateChange((change) => {
          if (client === c && change.state === 'disconnected') fireLost('connection closed');
        });
        client = c;
        break;
      } catch (e) { lastError = e; await sleep(150); }
    }
    if (!client) { try { tunnel.kill('SIGKILL'); } catch {} throw lastError ?? new Error('connect failed'); }
  }

  async function teardown() {
    const c = client; const t = tunnel;
    client = null; tunnel = null;
    try { await c?.dispose(); } catch {}
    try { t?.kill('SIGKILL'); } catch {}
    try { unlinkSync(localSock); } catch {}
  }

  await open();

  const serverCall = (member, args = []) =>
    client.request({ serverId: sid }, { serviceId: 'sessions', member, args: strictJson(args) });

  return {
    get client() { return client; },
    serverId: sid,
    target: ssh,
    hostKey,
    get connected() { return Boolean(client?.connected) && !lostFired; },
    onLost(handler) { lostHandlers.add(handler); return () => lostHandlers.delete(handler); },
    list: () => serverCall('list'),
    models: () => serverCall('models'),
    create: (opts = {}) => serverCall('create', [opts]),
    delete: (id) => serverCall('delete', [id]),
    attach: (id) => serverCall('attach', [id]),
    async request(member, args = []) {
      if (!client?.attachment) throw new Error('not attached');
      return client.request(client.attachment, { serviceId: 'chat', member, args: strictJson(args) });
    },
    /** New tunnel + client; the caller re-attaches its session. */
    async reconnect() {
      if (closed) throw new Error('disconnected');
      await teardown();
      await open();
    },
    async disconnect() {
      closed = true;
      lostHandlers = new Set();
      await teardown();
    },
  };
}
