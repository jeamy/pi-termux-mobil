// test-remote-client.mjs — exercises pi-serverd end-to-end over the unix socket.
// Usage: node test-remote-client.mjs [socketPath] [serverId]
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from '@earendil-works/pi-client';
import { createUnixTransportFactory } from '@earendil-works/pi-client/unix';

const home = process.env.HOME;
const sock = process.argv[2] || `${home}/.pi-serverd/server.sock`;
const serverId = process.argv[3] || readFileSync(`${home}/.pi-serverd/server-id`, 'utf8').trim();

const client = await Client.connect({
  serverId,
  transportFactory: createUnixTransportFactory({ path: sock }),
});
console.log('connected, hello:', JSON.stringify(client.hello));

const server = { serverId };
const list = await client.request(server, { serviceId: 'sessions', member: 'list', args: [] });
console.log('list:', JSON.stringify(list));

const created = await client.request(server, { serviceId: 'sessions', member: 'create', args: [{ name: 'test' }] });
console.log('created:', JSON.stringify(created));
const sessionId = created.id;

await client.request(server, { serviceId: 'sessions', member: 'attach', args: [sessionId] });
console.log('attached, target:', JSON.stringify(client.attachment));
const target = client.attachment;

const state = await client.request(target, { serviceId: 'chat', member: 'state', args: [] });
console.log('state: model', JSON.stringify(state.docs?.['pi.agent']?.model), 'busy', state.busy);

const history = await client.request(target, { serviceId: 'chat', member: 'history', args: [{ limit: 50 }] });
let after = history.cursor;
const epoch = history.epoch;

// the same requestId twice must yield one submission (exactly-once)
const requestId = randomUUID();
const p1 = await client.request(target, { serviceId: 'chat', member: 'prompt', args: [{ message: 'say just the word pong', requestId }] });
const p2 = await client.request(target, { serviceId: 'chat', member: 'prompt', args: [{ message: 'say just the word pong', requestId }] });
console.log('prompt:', JSON.stringify(p1), 'retry same id:', p1.submissionId === p2.submissionId ? 'deduplicated' : 'DUPLICATE');

let done = false;
for (let i = 0; i < 20 && !done; i++) {
  const r = await client.request(target, { serviceId: 'chat', member: 'events', args: [{ after, epoch }] });
  after = r.cursor;
  for (const e of r.events ?? []) {
    const txt = e?.entry?.model?.[0]?.content;
    const text = typeof txt === 'string' ? txt : txt?.filter?.((c) => c?.type === 'text')?.[0]?.text;
    console.log(`event #${e.seq}:`, e.type, text ? `| ${text.slice(0, 80)}` : '');
    if (e.type === 'submission' && e.record?.status === 'done') { console.log('SUBMISSION: done'); done = true; }
  }
}
await client.dispose();
process.exit(done ? 0 : 1);
