// env-server.mjs — dependency-free remote execution environment for
// pi-termux-mobile. Run on any host with Node >= 22:
//
//   PI_REMOTE_TOKEN=<secret> PI_REMOTE_PORT=7842 node env-server.mjs
//
// Binds 127.0.0.1 by default: reach it through `ssh -L` or a VPN address set
// with PI_REMOTE_HOST. It executes arbitrary commands — never expose it on a LAN
// without a tunnel.
//
// Endpoints (all POST, JSON, bearer auth):
//   /exec { command, cwd?, env?, timeout?, stream? } -> { exitCode, output }
//         stream: true -> NDJSON lines {output} … {exitCode, timedOut}
//   /fs   { op, path?, ... }                         -> per-op payload
// fs ops: read write append truncate rename info list exists mkdir remove
//         canonical tempdir tempfile
// A client that disconnects (abort) kills the command's whole process group.
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const TOKEN = process.env.PI_REMOTE_TOKEN || '';
const PORT = Number(process.env.PI_REMOTE_PORT || 7842);
const HOST = process.env.PI_REMOTE_HOST || '127.0.0.1';
const SHELL = process.env.PI_REMOTE_SHELL || '/bin/bash';
const MAX_OUTPUT = 8 * 1024 * 1024;
const MAX_BODY = 64 * 1024 * 1024; // base64 file writes

if (TOKEN.length < 16) {
  console.error('PI_REMOTE_TOKEN is required (at least 16 characters)');
  process.exit(1);
}
const expected = Buffer.from(`Bearer ${TOKEN}`);
function authorized(req) {
  const given = Buffer.from(String(req.headers.authorization || ''));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function fe(code, message, p) { return { code, message, path: p }; }

function killGroup(child) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
}

function execCmd(body, res) {
  return new Promise((resolve) => {
    const env = body.inheritEnv === false
      ? (body.env || {})
      : { ...process.env, ...(body.env || {}) };
    const child = spawn(SHELL, ['-c', String(body.command)], {
      cwd: body.cwd || process.cwd(), env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group, so timeout/abort reach grandchildren
    });
    const stream = body.stream === true;
    if (stream) res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    let out = ''; let killed = false; let finished = false;
    const timer = body.timeout ? setTimeout(() => { killed = true; killGroup(child); }, body.timeout) : null;
    // client went away (abort): stop the command
    res.on('close', () => { if (!finished) killGroup(child); });
    const onData = (d) => {
      const text = d.toString('utf8');
      if (stream) { res.write(`${JSON.stringify({ output: text })}\n`); return; }
      if (out.length < MAX_OUTPUT) out += text;
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const done = (result) => {
      finished = true;
      if (timer) clearTimeout(timer);
      if (stream) res.end(`${JSON.stringify(result)}\n`);
      else json(res, 200, { ...result, output: out });
      resolve();
    };
    child.on('close', (code) => done({ exitCode: killed ? 124 : (code ?? 1), timedOut: killed }));
    child.on('error', (e) => done({ exitCode: 127, output: String(e.message) }));
  });
}

function fsOp(b) {
  const p = b.path;
  switch (b.op) {
    case 'read': return { contentB64: fs.readFileSync(p).toString('base64') };
    case 'write': fs.writeFileSync(p, Buffer.from(b.contentB64, 'base64')); return { ok: true };
    case 'append': fs.appendFileSync(p, Buffer.from(b.contentB64, 'base64')); return { ok: true };
    case 'truncate': fs.truncateSync(p, b.size); return { ok: true };
    case 'rename': fs.renameSync(p, b.dest); return { ok: true };
    case 'info': {
      const s = fs.lstatSync(p);
      return { info: { name: path.basename(p), path: p, kind: s.isDirectory() ? 'directory' : s.isSymbolicLink() ? 'symlink' : 'file', size: s.size, mtimeMs: s.mtimeMs } };
    }
    case 'list': {
      return {
        entries: fs.readdirSync(p, { withFileTypes: true }).map((d) => {
          const fp = path.join(p, d.name);
          let size = 0, mtimeMs = 0;
          try { const s = fs.statSync(fp); size = s.size; mtimeMs = s.mtimeMs; } catch {}
          return { name: d.name, path: fp, kind: d.isDirectory() ? 'directory' : d.isSymbolicLink() ? 'symlink' : 'file', size, mtimeMs };
        }),
      };
    }
    case 'exists': return { exists: fs.existsSync(p) };
    case 'mkdir': fs.mkdirSync(p, { recursive: Boolean(b.recursive) }); return { ok: true };
    case 'remove': fs.rmSync(p, { recursive: Boolean(b.recursive), force: b.force !== false }); return { ok: true };
    case 'canonical': return { path: fs.realpathSync(p) };
    case 'tempdir': return { path: fs.mkdtempSync(path.join(os.tmpdir(), path.basename(String(p || 'pi-')))) };
    case 'tempfile': {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), path.basename(String(b.prefix || 'pi-'))));
      const fp = path.join(dir, `f${path.basename(String(b.suffix || ''))}`);
      fs.writeFileSync(fp, '');
      return { path: fp };
    }
    default: throw fe('invalid', `unknown op ${b.op}`, p);
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
  let body;
  try { body = await readBody(req); } catch (e) { return json(res, e.status || 400, { error: { code: 'invalid', message: e.message } }); }
  try {
    if (req.url === '/exec') return await execCmd(body, res);
    if (req.url === '/fs') return json(res, 200, fsOp(body));
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    const code = e.code === 'ENOENT' ? 'not_found' : e.code === 'EACCES' || e.code === 'EPERM' ? 'permission_denied' : 'unknown';
    if (res.headersSent) return res.end();
    return json(res, 400, { error: { code, message: String(e.message || e), path: e.path } });
  }
});
server.requestTimeout = 0; // long-running commands are bounded by their own timeout

server.listen(PORT, HOST, () => console.log(`env-server on ${HOST}:${PORT}`));
