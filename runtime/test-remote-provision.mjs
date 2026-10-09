import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { nodeSupported, runtimeHash, remoteBash, remoteFiles, REMOTE_FILES, rollbackReleaseScript, sshRun, ensureRemoteServer } from './remote-provision.mjs';
import { parseSshTarget } from './remote-client.mjs';

test('Node engines >=22.19.0 (not any Node 22)', () => {
  for (const version of ['22.18.0', '22.9.9', '21.99.99', '']) assert.equal(nodeSupported(version), false);
  for (const version of ['22.19.0', '22.19.1', '22.20.0', '24.0.0']) assert.equal(nodeSupported(version), true);
});
test('SSH target validation and port', () => {
  assert.deepEqual(parseSshTarget('lux@server:2222'), { host: 'lux@server', port: 2222 });
  for (const target of ['-oProxyCommand=bad', 'a@b;touch /tmp/x', 'host:0', 'host:65536'])
    assert.throws(() => parseSshTarget(target));
});
test('release hash is stable, dependency hash differs', () => {
  assert.match(runtimeHash(), /^[0-9a-f]{16}$/);
  assert.notEqual(runtimeHash(), runtimeHash(undefined, ['package.json', 'package-lock.json']));
  assert.match(remoteBash('echo hello'), /^bash -l -c /);
});
test('release hash detects changed, added and removed bundled examples', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-mobile-hash-'));
  try {
    mkdirSync(path.join(dir, 'space-examples'));
    const file = path.join(dir, 'space-examples/sieve.mjs');
    writeFileSync(file, 'initial');
    const initial = runtimeHash(dir, ['space-examples']);
    writeFileSync(file, 'updated');
    const updated = runtimeHash(dir, ['space-examples']);
    assert.notEqual(updated, initial);
    const added = path.join(dir, 'space-examples/cache.mjs');
    writeFileSync(added, 'new example');
    assert.notEqual(runtimeHash(dir, ['space-examples']), updated);
    rmSync(added);
    assert.equal(runtimeHash(dir, ['space-examples']), updated);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fresh checkout works without generated examples; present examples are hashed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-mobile-manifest-'));
  try {
    for (const file of REMOTE_FILES) writeFileSync(path.join(dir, file), file);
    assert.deepEqual(remoteFiles(dir), REMOTE_FILES);
    const initial = runtimeHash(dir);
    mkdirSync(path.join(dir, 'space-examples'));
    writeFileSync(path.join(dir, 'space-examples/demo.mjs'), 'demo');
    assert.ok(remoteFiles(dir).includes('space-examples'));
    assert.notEqual(runtimeHash(dir), initial);
    rmSync(path.join(dir, 'common.mjs'));
    assert.throws(() => runtimeHash(dir), /Required remote runtime file missing: common.mjs/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const scenario of ['between-renames', 'promoted', 'before-renames', 'first-install']) {
  test(`rollback restores the preceding release: ${scenario}`, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pi-mobile-rollback-'));
    const makeRelease = (name, version) => {
      mkdirSync(path.join(dir, name));
      writeFileSync(path.join(dir, name, '.version'), version);
    };
    try {
      if (scenario === 'before-renames') makeRelease('runtime', 'old');
      if (['between-renames', 'promoted'].includes(scenario)) makeRelease('runtime.prev', 'old');
      if (['promoted', 'first-install'].includes(scenario)) makeRelease('runtime', 'new');
      const script = rollbackReleaseScript(dir, 'new');
      const result = spawnSync('bash', ['-c', script], { env: { ...process.env, HOME: dir }, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      if (scenario === 'first-install') assert.equal(existsSync(path.join(dir, 'runtime')), false);
      else assert.equal(readFileSync(path.join(dir, 'runtime/.version'), 'utf8'), 'old');
      if (['promoted', 'first-install'].includes(scenario)) {
        assert.equal(readFileSync(path.join(dir, 'runtime.failed/.version'), 'utf8'), 'new');
      }
      // Recovery may be repeated after an ambiguous SSH failure.
      assert.equal(spawnSync('bash', ['-c', script], { env: { ...process.env, HOME: dir } }).status, 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const failure of ['promotion', 'startup']) {
  test(`full provisioning rollback restarts the old release after ${failure} failure`, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pi-mobile-deploy-'));
    const root = path.dirname(fileURLToPath(import.meta.url));
    const runtime = path.join(dir, '.pi-mobile-remote/runtime');
    try {
      mkdirSync(path.join(dir, 'bin'));
      mkdirSync(runtime, { recursive: true });
      writeFileSync(path.join(runtime, '.version'), 'old');
      writeFileSync(path.join(runtime, '.deps'), runtimeHash(undefined, ['package.json', 'package-lock.json']));
      writeFileSync(path.join(runtime, 'pi-serverd.mjs'),
        `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(dir + '/restarted')}, 'old');`);
      symlinkSync(path.join(root, 'node_modules'), path.join(runtime, 'node_modules'));
      symlinkSync('/bin/tar', path.join(dir, 'bin/tar'));
      writeFileSync(path.join(dir, 'bin/tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
      // Execute the generated remote shell scripts locally, injecting a failure
      // only at the second rename. Other calls (upload, markers, rollback) are real.
      writeFileSync(path.join(dir, 'bin/ssh'), `#!${process.execPath}
const {spawn} = require('node:child_process');
let script = Buffer.from(/echo ([A-Za-z0-9+/=]+) \\| base64 -d/.exec(process.argv.at(-1))[1], 'base64').toString();
if (${JSON.stringify(failure)} === 'promotion' && script.includes('runtime.prev') && script.includes('&& mv "$HOME/.pi-mobile-remote/stage-')) {
  script = script.replace('&& mv "$HOME/.pi-mobile-remote/stage-', '&& false # mv "$HOME/.pi-mobile-remote/stage-');
}
// bash -l normally resets HOME on this CI image. Keep this local test account
// isolated, including when the production script launches a login shell.
script = script.replaceAll('bash -l -c', 'bash -c');
const child = spawn('bash', ['-c', script], { stdio: 'inherit', env: {...process.env,
  HOME: ${JSON.stringify(dir)}, PATH: ${JSON.stringify(dir + '/bin:')} + process.env.PATH} });
child.on('exit', code => process.exit(code ?? 1));
`, { mode: 0o700 });
      await assert.rejects(ensureRemoteServer({ ssh: 'test@host', prefix: dir }),
        failure === 'promotion' ? /release swap failed/ : /daemon start failed/);
      assert.equal(readFileSync(path.join(runtime, '.version'), 'utf8'), 'old');
      const deadline = Date.now() + 3000;
      while (!existsSync(path.join(dir, 'restarted')) && Date.now() < deadline) await sleep(25);
      assert.equal(readFileSync(path.join(dir, 'restarted'), 'utf8'), 'old');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('sshRun bounds hung commands and handles an early upload pipe failure', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-mobile-ssh-'));
  mkdirSync(path.join(dir, 'bin'));
  const ctx = { prefix: dir, host: 'host', home: dir };
  try {
    writeFileSync(path.join(dir, 'bin/ssh'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o700 });
    await assert.rejects(sshRun(ctx, 'ignored', { timeoutMs: 50 }), /timeout/);
    const cancelled = new AbortController();
    const pending = sshRun(ctx, 'ignored', { signal: cancelled.signal });
    cancelled.abort(new Error('test cancellation'));
    await assert.rejects(pending, /test cancellation/);
    writeFileSync(path.join(dir, 'bin/ssh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    // Depending on OS scheduling, either EPIPE or the exit status arrives first.
    try {
      const result = await sshRun(ctx, 'ignored', { stdin: Buffer.alloc(8 * 1024 * 1024), timeoutMs: 1000 });
      assert.notEqual(result.code, 0);
    } catch (e) { assert.match(e.code ?? e.message, /EPIPE|ECONNRESET/); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
