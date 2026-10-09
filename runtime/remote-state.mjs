// One bridge attachment, owned by a generation. Late connection/recovery
// completions must never overwrite a newer host or resurrect a disconnected one.
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { attachRemote } from './remote-client.mjs';
import { ensureRemoteServer } from './remote-provision.mjs';

export function createRemoteState({ prefix = '', stateDir, authFile, assertTrusted,
  attach = attachRemote, ensure = ensureRemoteServer, wait = sleep }) {
  return {
    remote: null, sessionId: null, status: 'disconnected', lastError: null,
    log: [], generation: 0, controller: null,
    async connect(target, { copyAuth = false, allowUpdate = false } = {}) {
      const disconnecting = this.disconnect();
      const generation = this.generation;
      await disconnecting;
      if (generation !== this.generation) throw Object.assign(new Error('connection cancelled'), { status: 409 });
      const controller = this.controller = new AbortController();
      const current = () => generation === this.generation && !controller.signal.aborted;
      this.log = [];
      this.status = 'provisioning';
      this.lastError = null;
      let remote;
      try {
        if (copyAuth) await assertTrusted(target);
        controller.signal.throwIfAborted();
        await ensure({ ssh: target, prefix, copyAuth, allowUpdate, authFile, signal: controller.signal,
          log: (l) => { if (current()) { this.log.push(l); if (this.log.length > 200) this.log.shift(); } } });
        controller.signal.throwIfAborted();
        remote = await attach({ ssh: target, prefix, socketDir: path.join(stateDir, 'tunnels'), signal: controller.signal });
        if (!current()) throw new Error('connection cancelled');
        this.remote = remote;
        this.status = 'connected';
        remote.onLost((why) => { void this.recover(remote, why); });
        return remote;
      } catch (e) {
        if (remote) await remote.disconnect();
        if (!current()) throw Object.assign(new Error('connection cancelled'), { status: 409 });
        this.status = 'disconnected';
        this.lastError = String(e?.message || e);
        throw e;
      }
    },
    async recover(remote, why) {
      if (this.remote !== remote || this.status === 'reconnecting') return;
      const generation = this.generation;
      const signal = this.controller.signal;
      const current = () => this.remote === remote && generation === this.generation && !signal.aborted;
      this.status = 'reconnecting';
      this.lastError = why;
      for (let attempt = 0; current(); attempt++) {
        try {
          await wait(Math.min(30_000, 1000 * 2 ** attempt), undefined, { signal });
          if (!current()) return;
          await remote.reconnect();
          if (!current()) return;
          if (this.sessionId) await remote.attach(this.sessionId);
          if (!current()) return;
          this.status = 'connected';
          this.lastError = null;
          return;
        } catch (e) {
          if (!current()) return;
          this.lastError = String(e?.message || e);
        }
      }
    },
    async disconnect() {
      this.generation++;
      const r = this.remote;
      this.remote = null;
      this.sessionId = null;
      this.status = 'disconnected';
      this.controller?.abort(new Error('connection cancelled'));
      this.controller = null;
      if (r) { try { await r.disconnect(); } catch {} }
    },
    require() {
      if (!this.remote) throw Object.assign(new Error('not connected'), { status: 400 });
      if (this.status !== 'connected') throw Object.assign(new Error(`reconnecting: ${this.lastError || ''}`), { status: 503, reconnecting: true });
      return this.remote;
    },
  };
}
