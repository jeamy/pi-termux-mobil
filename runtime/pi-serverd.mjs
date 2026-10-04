// pi-serverd.mjs — durable pi sessions over the pi-server protocol (unix socket).
// Remote attach flow: `ssh -L <local.sock>:<socket>` from the client machine,
// then pi-client over the unix transport; same machine: connect the socket directly.
//
// Env: HOME (storage root), PI_SERVERD_SOCK (socket path, default
// $HOME/.pi-serverd/server.sock), PI_SERVERD_ID (stable serverId, default:
// persisted random uuid), PI_WORKDIR (agent cwd), PI_PROVIDER/PI_MODEL.
import { chmodSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { createUnixServer } from '@earendil-works/pi-server/unix';
import { SessionNotFoundError } from '@earendil-works/pi-server';
import {
  acquireOwnerLock, createCredentialStore, createEventHub, createModelCatalog,
  ensureModel, isBusy, openHarness, pickModel, readJson, requestIdOf, sessionStore, Subagent,
  whenBusyOf, writeFileAtomic,
} from './common.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || ROOT;
const STATE_DIR = `${HOME}/.pi-serverd`;
const SOCK_PATH = process.env.PI_SERVERD_SOCK || `${STATE_DIR}/server.sock`;
const WORKDIR = process.env.PI_WORKDIR || HOME;
const LEGACY_MANIFEST = `${STATE_DIR}/sessions.json`;
const DB = `${STATE_DIR}/harness.sqlite`;

// private state dir: pi-server does not authenticate unix-socket peers
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
try { chmodSync(STATE_DIR, 0o700); } catch {}
mkdirSync(path.dirname(SOCK_PATH), { recursive: true, mode: 0o700 });
mkdirSync(WORKDIR, { recursive: true });

const releaseLock = await acquireOwnerLock(`${STATE_DIR}/serverd.lock`, 'pi-serverd.mjs');

const ID_FILE = `${STATE_DIR}/server-id`;
let serverId = process.env.PI_SERVERD_ID;
if (!serverId) {
  try { serverId = readFileSync(ID_FILE, 'utf8').trim(); } catch {}
  if (!serverId) { serverId = randomUUID(); writeFileAtomic(ID_FILE, serverId, 0o644); }
}

// --- harness ----------------------------------------------------------------

const ctx = BACKGROUND_CONTEXT;
const credentials = createCredentialStore(`${HOME}/.pi/agent/auth.json`);
const models = await createModelCatalog(credentials);
const env = new NodeExecutionEnv({ cwd: WORKDIR, env: process.env });
const harness = await openHarness({
  dbPath: DB,
  models,
  env: ({ cwd }) => (cwd && cwd !== WORKDIR ? new NodeExecutionEnv({ cwd, env: process.env }) : env),
  extensions: [Subagent],
}, ctx);
const sessions = sessionStore(harness, ctx);

// one-time import of the old JSON manifest
{
  const legacy = readJson(LEGACY_MANIFEST, null)?.sessions;
  if (legacy && Object.keys(legacy).length && !(await sessions.list()).length) {
    const n = await sessions.migrate(legacy);
    writeFileAtomic(`${LEGACY_MANIFEST}.migrated`, JSON.stringify({ sessions: legacy }, null, 2));
    try { unlinkSync(LEGACY_MANIFEST); } catch {}
    console.log(`migrated ${n} sessions from ${LEGACY_MANIFEST}`);
  }
}
harness.resume();

const events = createEventHub(harness, ctx);

async function conversationOf(sessionId) {
  if (!(await sessions.get(sessionId))) throw new SessionNotFoundError(`unknown session: ${sessionId}`);
  const conv = await harness.conversation(Number(sessionId), ctx);
  if (!conv) throw new SessionNotFoundError(`session unavailable: ${sessionId}`);
  return conv;
}

// --- routed session handles ---------------------------------------------------

function routedSession(sessionId) {
  return {
    async attachClient() {
      const conv = await conversationOf(sessionId);
      // Sessions created before a credential existed have no model: give them
      // the current default. Never overrides an explicit choice.
      await ensureModel(conv, models, ctx);
      return {
        async invokeService(call, publish, context) {
          if (call.serviceId !== 'chat') throw new Error(`unknown service: ${call.serviceId}`);
          const c = context ?? ctx;
          const arg = call.args[0] ?? {};
          switch (call.member) {
            case 'prompt': {
              const text = String(arg.message ?? (typeof arg === 'string' ? arg : ''));
              if (!(await ensureModel(conv, models, c))) {
                throw new Error('no model: add a credential on the server');
              }
              const sub = await conv.submit({
                type: 'input',
                content: text,
                requestId: requestIdOf(arg.requestId), // exactly-once across retries
                whenBusy: whenBusyOf(arg.whenBusy),
              }, c);
              return { submissionId: sub.id };
            }
            case 'abort':
              await conv.abort(c);
              return { ok: true };
            case 'compact': {
              const taskId = await conv.compact(typeof arg.instructions === 'string' ? arg.instructions : undefined, c);
              return { ok: true, taskId };
            }
            case 'state': {
              const view = await conv.viewState(c);
              try { return { ...view.value, busy: isBusy(view) }; } finally { view.dispose?.(); }
            }
            case 'configure': {
              if (arg.model?.provider && arg.model?.modelId) {
                await conv.configure({ model: { provider: String(arg.model.provider), modelId: String(arg.model.modelId) } }, c);
              }
              return { ok: true };
            }
            case 'history': {
              // entries() is newest-first; the UI needs chronological messages.
              const limit = Math.min(Math.max(Number(arg.limit) || 200, 1), 500);
              // position before the page: nothing is lost; repeats are deduped by entry id in the UI
              const position = await events.position(sessionId);
              const page = await conv.entries({}, limit, undefined, c);
              return { entries: [...page.items].reverse(), ...position };
            }
            case 'events': {
              // long-poll; `after` is the last sequence number this client has seen
              const after = Number(arg.after ?? -1);
              const epoch = typeof arg.epoch === 'string' ? arg.epoch : undefined;
              return events.poll(sessionId, after, { epoch, waitMs: 25_000, signal: c?.abortSignal });
            }
            default:
              throw new Error(`unknown member: ${call.member}`);
          }
        },
        release() {},
      };
    },
    terminated: new Promise(() => {}),
    async close() {},
  };
}

const host = {
  serverServices: {
    attachClient(presentation) {
      return {
        async invokeService(call, publish, context) {
          if (call.serviceId !== 'sessions') throw new Error(`unknown service: ${call.serviceId}`);
          const c = context ?? ctx;
          switch (call.member) {
            case 'list':
              return { sessions: (await sessions.list()).map((s) => ({ cwd: WORKDIR, ...s })) };
            case 'models': {
              const available = await models.getAvailable();
              return { models: available.map((m) => ({ provider: m.provider, modelId: m.id })) };
            }
            case 'create': {
              const opts = call.args[0] ?? {};
              const conv = await sessions.create(
                { name: typeof opts.name === 'string' ? opts.name.slice(0, 100) : undefined, cwd: WORKDIR },
                { agent: { model: await pickModel(models) } },
              );
              return { id: String(conv.id) };
            }
            case 'delete': {
              const id = String(call.args[0]);
              const conv = await conversationOf(id);
              // stop running work first; a hidden session must not keep using tools
              await conv.abort(c);
              // the transcript stays in SQLite; the registry entry is removed
              await sessions.remove(id);
              return { ok: true };
            }
            case 'attach': {
              const id = String(call.args[0]);
              await conversationOf(id);
              await presentation.attachSession(id, c);
              return { ok: true };
            }
            default:
              throw new Error(`unknown member: ${call.member}`);
          }
        },
        release() {},
      };
    },
  },
  async resolveSession(sessionId) {
    if (!(await sessions.get(sessionId))) throw new SessionNotFoundError(`unknown session: ${sessionId}`);
    return { id: String(sessionId) };
  },
  async openSession(metadata) {
    return routedSession(metadata.id);
  },
};

const server = createUnixServer(host, { serverId, path: SOCK_PATH, mode: 0o600 });
await server.start();
console.log(`pi-serverd on ${SOCK_PATH} (serverId ${serverId})`);

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`pi-serverd: ${signal}, closing`);
  try { await server.close?.(); } catch {}
  try { await events.close(); } catch {}
  try { await harness.close(ctx); } catch (e) { console.error('harness.close:', e?.message || e); }
  releaseLock();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
