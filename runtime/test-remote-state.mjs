import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteState } from './remote-state.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(overrides = {}) {
  const remote = {
    onLost() {}, async disconnect() {}, async reconnect() {}, async attach() {},
  };
  const state = createRemoteState({
    stateDir: '/tmp/pi-state-tests', ensure: async () => {}, attach: async () => remote,
    wait: async () => {}, ...overrides,
  });
  return { state, remote };
}

test('disconnect during reconnect does not resurrect connection or reattach', async () => {
  const { state, remote } = fixture();
  await state.connect('host');
  state.sessionId = '123';
  const pending = deferred(), entered = deferred();
  remote.reconnect = () => { entered.resolve(); return pending.promise; };
  remote.attach = () => assert.fail('cancelled recovery reattached');
  const recovering = state.recover(remote, 'lost');
  await entered.promise;
  await state.disconnect();
  pending.resolve();
  await recovering;
  assert.equal(state.status, 'disconnected');
  assert.equal(state.remote, null);
});

test('disconnect during reattach leaves disconnected state', async () => {
  const { state, remote } = fixture();
  await state.connect('host');
  state.sessionId = '123';
  const pending = deferred(), entered = deferred();
  remote.attach = () => { entered.resolve(); return pending.promise; };
  const recovering = state.recover(remote, 'lost');
  await entered.promise;
  await state.disconnect();
  pending.resolve();
  await recovering;
  assert.equal(state.status, 'disconnected');
});

test('obsolete provisioning failure cannot clobber a newer host', async () => {
  const old = deferred(), entered = deferred();
  const { state, remote } = fixture({ ensure: ({ ssh }) => {
    if (ssh === 'old') { entered.resolve(); return old.promise; }
  } });
  const first = state.connect('old');
  const rejected = assert.rejects(first, /connection cancelled/);
  await entered.promise;
  await state.connect('new');
  old.reject(new Error('obsolete ssh failure'));
  await rejected;
  assert.equal(state.status, 'connected');
  assert.equal(state.remote, remote);
  assert.equal(state.lastError, null);
  await state.disconnect();
});

test('simultaneous connect requests give ownership to the newest generation', async () => {
  const { state, remote } = fixture();
  const first = state.connect('old');
  const rejected = assert.rejects(first, /connection cancelled/);
  await state.connect('new');
  await rejected;
  assert.equal(state.remote, remote);
  assert.equal(state.status, 'connected');
  await state.disconnect();
});

test('healthy recovery reattaches the selected session', async () => {
  const { state, remote } = fixture();
  await state.connect('host');
  state.sessionId = '123';
  let attached;
  remote.attach = async (id) => { attached = id; };
  await state.recover(remote, 'lost');
  assert.equal(attached, '123');
  assert.equal(state.status, 'connected');
  assert.equal(state.lastError, null);
  await state.disconnect();
});
