// Offline end-to-end tests: real daemon + protocol + private socket tunnel,
// with a local SSH stand-in. No SSH host, credentials or model API calls needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { attachRemote } from './remote-client.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
function fixture(mode = 'proxy') {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-remote-test-'));
  mkdirSync(path.join(dir, 'bin'));
  const ssh = `#!${process.execPath}
const net = require('node:net');
const fs = require('node:fs');
const args = process.argv.slice(2);
if (!args.includes('-N')) {
  if (${JSON.stringify(mode)} === 'metadata-hang') setInterval(() => {}, 1000);
  else if (args.at(-1) === 'echo $HOME') console.log(${JSON.stringify(dir)});
  else console.log(fs.readFileSync(${JSON.stringify(dir + '/.pi-serverd/server-id')}, 'utf8').trim());
} else {
  const [local, remote] = args[args.indexOf('-L') + 1].split(':');
  const peers = new Set();
  const server = net.createServer((socket) => {
    peers.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => peers.delete(socket));
    if (${JSON.stringify(mode)} === 'handshake-hang') return;
    const upstream = net.connect(remote);
    peers.add(upstream);
    upstream.on('error', () => socket.destroy());
    upstream.on('close', () => { peers.delete(upstream); socket.destroy(); });
    socket.on('close', () => upstream.destroy());
    socket.pipe(upstream).pipe(socket);
  });
  server.listen(local);
  process.on('SIGTERM', () => { for (const peer of peers) peer.destroy(); server.close(() => process.exit()); });
}
`;
  writeFileSync(path.join(dir, 'bin/ssh'), ssh, { mode: 0o700 });
  writeFileSync(path.join(dir, 'bin/ssh-keygen'), '#!/bin/sh\necho "256 SHA256:test-host test (ED25519)"\n', { mode: 0o700 });
  return { dir, prefix: dir, socketDir: path.join(dir, 'tunnels'), ssh: 'test@host',
    cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function daemon(home, t) {
  let output = '';
  const child = spawn(process.execPath, [path.join(root, 'pi-serverd.mjs')], {
    env: { ...process.env, HOME: home, PI_TEST_FAUX: '1', PI_WORKDIR: home,
      PI_SERVERD_SOCK: `${home}/.pi-serverd/server.sock`, PI_SERVERD_ID: '', PI_PROVIDER: '', PI_MODEL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      try { await closed; } finally { clearTimeout(timer); }
    }
  });
  const deadline = Date.now() + 10_000;
  while (!output.includes('pi-serverd on ')) {
    assert.equal(child.exitCode, null, output);
    assert.ok(Date.now() < deadline, `daemon startup timeout: ${output}`);
    await sleep(25);
  }
  return {
    serverId: readFileSync(`${home}/.pi-serverd/server-id`, 'utf8').trim(),
    remoteSock: `${home}/.pi-serverd/server.sock`,
  };
}

test('metadata commands and silent protocol handshakes have deadlines', async () => {
  for (const mode of ['metadata-hang', 'handshake-hang']) {
    const f = fixture(mode);
    try {
      const options = mode === 'handshake-hang'
        ? { serverId: randomUUID(), remoteSock: '/unused.sock' } : {};
      await assert.rejects(attachRemote({ ...f, ...options, timeoutMs: 500 }), /timeout/);
      await sleep(100);
      assert.deepEqual(readdirSync(f.socketDir), [], 'failed attach left a socket behind');
    } finally { f.cleanup(); }
  }
});

test('rename routes to sessions; deleted sessions reject every existing attachment', async (t) => {
  const f = fixture();
  // Register cleanup before daemon cleanup: after hooks execute in registration order.
  const opts = await daemon(f.dir, t);
  let first, second;
  t.after(async () => {
    await first?.disconnect();
    await second?.disconnect();
    f.cleanup();
  });
  first = await attachRemote({ ...f, ...opts });
  second = await attachRemote({ ...f, ...opts });
  const { id } = await first.create({ name: 'test' });
  await first.attach(id);
  await second.attach(id);
  assert.deepEqual(await first.rename(id, 'renamed'), { ok: true });
  assert.equal((await first.list()).sessions[0].name, 'renamed');
  const requestId = randomUUID();
  const a = await first.request('prompt', [{ message: 'hello', requestId }]);
  const b = await first.request('prompt', [{ message: 'hello', requestId }]);
  assert.equal(a.submissionId, b.submissionId, 'prompt retries must stay deduplicated');
  // A racing prompt either finishes before deletion's abort, or is rejected.
  const racing = second.request('prompt', [{ message: 'racing', requestId: randomUUID() }]).catch(() => {});
  await first.delete(id);
  await racing;
  assert.deepEqual((await first.list()).sessions, []);
  for (const remote of [first, second]) {
    for (const [member, args] of [
      ['prompt', [{ message: 'after deletion', requestId: randomUUID() }]],
      ['compact', [{}]], ['state', []], ['history', []],
    ]) await assert.rejects(remote.request(member, args));
    await assert.rejects(remote.attach(id));
  }
});

test('hung RPC times out and disconnect during reconnect cancels the tunnel', async (t) => {
  const f = fixture();
  const opts = await daemon(f.dir, t);
  let remote;
  t.after(async () => { await remote?.disconnect(); f.cleanup(); });
  remote = await attachRemote({ ...f, ...opts, requestTimeoutMs: 150 });
  const { id } = await remote.create();
  await remote.attach(id);
  const history = await remote.request('history');
  // Long poll normally waits 25 seconds, deliberately longer than this deadline.
  await assert.rejects(remote.request('events', [{ after: history.cursor, epoch: history.epoch }]), /timeout/);
  // Replace SSH with a silent handshake for the reconnect attempt.
  const silent = fixture('handshake-hang');
  writeFileSync(path.join(f.prefix, 'bin/ssh'), readFileSync(path.join(silent.prefix, 'bin/ssh')));
  silent.cleanup();
  const pending = remote.reconnect();
  const rejected = assert.rejects(pending, /disconnected|abort/i);
  await sleep(150);
  await remote.disconnect();
  await rejected;
  assert.equal(remote.connected, false);
  await sleep(100);
  assert.deepEqual(readdirSync(f.socketDir), []);
  await assert.rejects(remote.reconnect(), /disconnected/);
});
