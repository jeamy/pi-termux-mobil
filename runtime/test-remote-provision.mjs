import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { nodeSupported, runtimeHash, remoteBash } from './remote-provision.mjs';
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
