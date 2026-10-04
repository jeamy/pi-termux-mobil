# pi-termux-mobile

> **Experimental software:** This is a personal prototype under active
> development. Remote sessions, the embedded Termux runtime, and Android
> background-process handling may still change or fail on individual devices.
>
> **Version 0.0.1** — still quick & dirty, see the [changelog](#changelog).

Minimal Android app that embeds Termux-built binaries (Node.js 26.4.0, bash,
coreutils, git, ripgrep, fd, openssh, npm, util-linux `script`, …) plus a
**pi-durable** harness (`@earendil-works/pi-durable` 1.0.2 + pi-ai/chord, with
pi-coding-agent 1.0.2 bundled for the CLI + TUI) behind a tiny
HTTP/SSE/WebSocket bridge (`runtime/server.mjs`). UI is a local WebView on
`http://127.0.0.1:<port>` (ephemeral port → `files/home/.pi-mobile/port`,
token → `…/token`).

The durable harness gives: SQLite-backed conversations
(`files/home/.pi-mobile/harness.sqlite` — survive process death,
`harness.resume()` continues interrupted runs), a `subagent` tool (child
conversations owned by the calling task), model selection per conversation,
and per-conversation execution environments — including remote hosts.

## App pages

- **Chat** (`/`) — durable pi conversation (prompt, abort, new session,
  model dropdown). `pi mobile` header links back here from every page.
- **Accounts** (`keys.html`) — API-key management plus OAuth/subscription
  sign-in. Credentials are stored as `~/.pi/agent/auth.json` in pi CLI format.
- **Sessions** (`sessions.html`) — local durable-session browser: create,
  open, rename, fork (continue from a session's newest entry), or stop and
  remove a session from the visible list.
- **Clients** (`clients.html`) — remote SSH host registry + device keypair
  (ed25519): generate, show pubkey, interactive `ssh-copy-id` in the
  terminal page.
- **Remote** (`remote.html`) — attach to durable sessions on other machines
  via the pi-server protocol: choose a saved SSH host, select/create/remove a
  session, and choose that remote session's model (see below).
- **pi CLI** (`terminal.html`) — real pi TUI over WebSocket → `script` PTY
  → `node cli.js`, with on-screen extra keys (esc/tab/ctrl/arrows/pgup/pgdn)
  for menus and scrollback. `?ssh=user@host` runs `ssh -tt <host> pi`
  instead — full remote pi TUI.

## Accounts: API keys and OAuth

The **Accounts** page supports both API keys and provider OAuth/subscription
logins. Select an OAuth provider under **OAuth / subscription**, then choose
**sign in**. When a provider offers multiple methods, the app shows a dialog
for example for **Browser login** or **Device code login**. Browser flows open
in the Android browser and return through the app's loopback callback; device
flows show the verification URL and code in the app. Completed credentials are
stored in `~/.pi/agent/auth.json` and immediately become available to the
model picker.

## Remote control, two ways

### 1. SSH pi TUI (immediate, full fidelity)

`ssh`/`ssh-copy-id`/`ssh-keygen` ship in the rootfs. Workflow:
Clients → *generate key* → *add client* (`user@host[:port]`) → `⇧key`
(interactive ssh-copy-id, type remote password) → `▸_` connects. The menu
item *pi CLI (ssh)* does a one-off connect without saving a host.

### 2. pi-server protocol (multi-client attach to durable sessions)

`runtime/pi-serverd.mjs` is a `pi-server` (`createUnixServer`) host app:
durable Harness + own SQLite under `~/.pi-serverd/`, services
`sessions.list/create/delete/attach/models` and
`chat.prompt/abort/state/configure/history/events` (events via long-poll
cursor — Chord subscriptions deliberately skipped).

```bash
# on the remote machine (Node >= 22, same runtime dir, uses ~/.pi/agent/auth.json)
node pi-serverd.mjs        # socket: ~/.pi-serverd/server.sock
```

The phone bridge (`runtime/remote-client.mjs`) forwards the remote unix
socket through the saved SSH client entry to a unix socket in the app-private
directory (`ssh -N -L ~/.pi-mobile/tunnels/<id>.sock:~/.pi-serverd/server.sock`,
OpenSSH 6.7+). A loopback TCP port would be reachable by every app on the
phone, and pi-server does not authenticate peers; SSH is the only auth. It then
attaches via `@earendil-works/pi-client`'s unix transport. A dropped tunnel is
rebuilt with backoff and the session is re-attached; prompts carry a
`requestId`, so a retried prompt is answered exactly once. `user@host:port` is converted to OpenSSH's `-p port`
form. The Remote page connects and loads sessions as soon as a host is
selected, creates one automatically when the host has none, opens the newest
session first, restores its transcript, and displays a model picker using the
remote host's available models. Remote uses non-interactive SSH key login, so
run **⇧key** / `ssh-copy-id` for a host before using it here.
Endpoints: `/api/remote/{connect,status,sessions,models,model,create,delete,attach,prompt,abort,compact,state,history,events,disconnect}`.
Events are long-polled with a sequence number and an epoch (`?after=<seq>&epoch=<id>`);
several clients can read the same session, a lost response is fetched again,
and a client that fell behind or saw a daemon restart gets `reset` and reloads
the transcript.

The session list is a pi-durable document (`app.sessions`) in
`~/.pi-serverd/harness.sqlite`, written in the same commit that creates a
conversation; an old `sessions.json` is imported once. Deleting a session first
aborts its running work, then removes its registry entry, so it no longer
appears or can be attached through Remote. Its transcript is kept in SQLite; it
is not a destructive purge. The state directory is `0700` and the socket `0600`. `pi-client` runs
on the phone as the protocol client, while the durable harness, model calls,
and tools run in `pi-serverd` on the remote host. For the full interactive Pi
TUI instead, use **Clients → ▸_** or **pi CLI (ssh)**; run it in `tmux` when an
SSH disconnect must not end the TUI process.

### 3. env-server (remote *tool execution*, different thing)

A conversation whose cwd is `remote:<name>:/path` runs its tools on that
host via `runtime/remote-env.mjs` (client) + `runtime/env-server.mjs`:

```bash
# on the remote machine — Node >= 22, no deps; binds 127.0.0.1 by default
PI_REMOTE_TOKEN=<secret, >=16 chars> PI_REMOTE_PORT=7842 node env-server.mjs
# reach it via ssh -L or a VPN address: PI_REMOTE_HOST=<tailscale-ip>

# on the phone: files/home/.pi-mobile/remotes.json (or PI_REMOTES env)
{"workstation": {"url": "http://127.0.0.1:7842", "token": "<secret>"}}
```

Output is streamed (NDJSON); aborting a tool call kills the command's whole
process group on the remote host. Never expose env-server on a LAN without a
tunnel/VPN — it executes arbitrary commands.

## Layout

- `android/` — Gradle project (app module, Java only, no NDK)
- `runtime/` — `server.mjs` (durable bridge + `/pty` WS + remote attach),
  `common.mjs` (shared harness setup, credential store with file lock, durable
  session registry, sequenced event hub, single-owner lock),
  `pi-serverd.mjs` (remote session daemon), `remote-client.mjs` (pi-client
  + ssh tunnel), `remote-env.mjs`/`env-server.mjs` (tool exec),
  `public/` (chat, keys, clients, remote, terminal pages + shared menu),
  package.json for prod node_modules
- `debs/` — Termux apt packages (aarch64) + extracted `rootfs/` used to build
  `rootfs.bin` (see below)
- `tools/` — local toolchain (JDK 21, Android SDK, Gradle 8.10.2) — not committed

## Build

```bash
cd android
JAVA_HOME=<path-to>/tools/jdk21 ./gradlew assembleDebug
# APK: app/build/outputs/apk/debug/app-debug.apk (~107 MB, aarch64 only content)
```

Toolchain notes:

- JDK 21 (Temurin) — Gradle/AGP 8.7.3 does not support the system JDK 25.
- compileSdk 35, minSdk 26, targetSdk **28** — keeps direct `execve()` of
  app-private binaries working (Android 10+ SELinux blocks it for
  targetSdk >= 29). `PiService` falls back to launching node via
  `/system/bin/linker64` if direct exec ever fails, so targetSdk can be raised.
- `RUNTIME_VERSION` in `RuntimeInstaller.java` gates re-extraction — bump it
  whenever assets change. An upgrade replaces `usr/` and `runtime/` entirely
  (archives are streamed into tar); `home/` and `work/` are kept.

## Repackaging assets

```bash
# rootfs.bin = gzipped tar of the Termux usr/ tree
cd debs/rootfs/data/data/com.termux/files
tar czf ../../../../../android/app/src/main/assets/rootfs.bin usr

# runtime.bin = gzipped tar of the pi runtime as runtime/ prefix
# IMPORTANT: strip node_modules/.bin dirs + dangling symlinks first —
# toybox tar on-device exits non-zero on them and extraction aborts
cd runtime
find node_modules -type d -name .bin -exec rm -rf {} +    # npm recreates these!
find node_modules -type l ! -exec test -e {} \; -delete
tar czf ../android/app/src/main/assets/runtime.bin --transform 's,^,runtime/,' \
  server.mjs common.mjs remote-env.mjs env-server.mjs pi-serverd.mjs remote-client.mjs \
  package.json package-lock.json public node_modules
```

(.bin suffix because aapt decompresses *.gz assets into the APK uncompressed.
`RuntimeInstaller` tolerates tar's non-zero exit when the expected payload
files are present — bad-symlink warnings are only logged.)

## Install / run

```bash
adb install android/app/build/outputs/apk/debug/app-debug.apk
# or wireless: ./install-wifi.sh (pairs via mDNS, installs, starts)
```

First launch extracts ~170 MB to app-private storage, then a foreground
service starts `node runtime/server.mjs`. The service runs exactly one bridge:
reopening the app attaches to the running one instead of restarting it, a
crashed bridge is restarted with backoff, and stopping sends SIGTERM so the
harness closes cleanly. `server.mjs` holds `~/.pi-mobile/server.lock`
(pi-durable allows one storage owner) and stops an orphaned predecessor. Open the app → **Accounts** page to
store a provider key or sign in through OAuth, then prompt. Local conversation state lives in
`files/home/.pi-mobile/harness.sqlite` and survives process death. The session
registry and the active session are a pi-durable document in the same
database (an old `sessions.json` is imported once), so a restart reopens the
session that was active. The chat streams answers, shows tool output (tap a
tool line), subagent children, usage, and offers *steer* while a run is busy;
every prompt carries a `requestId` so retries are exactly-once.

Caveats on device:

- MIUI kills the process aggressively in the background (foreground works
  fine): Settings → Apps → pi mobile → battery saver "no restrictions" +
  autostart.
- Android 12+: phantom-process killer may kill node/bash subprocesses;
  workaround needs `adb shell settings put global
  settings_enable_monitor_phantom_procs false` or the Android 14+ developer
  option. Foreground service + PARTIAL_WAKE_LOCK are held while running.
- Termux scripts inside the bundle have `com.termux` shebangs and will fail;
  binaries are invoked directly by absolute path (npm CLI shim may need
  `node $PREFIX/lib/node_modules/npm/bin/npm-cli.js` instead of `npm`).
- `stty -F /dev/pts/N` is used to push terminal resizes into the `script`
  PTY (control frames are `\x01`-prefixed JSON on the WS).

See ANALYSE.md for the full evaluation and upstream facts.

## Changelog

### 0.0.1 — 2026-10-04

Lots of bugfixes around durable sessions, security and the Android service.

**Security**

- Remote attach tunnels a unix socket in the app-private directory
  (`ssh -L local.sock:remote.sock`) instead of a loopback TCP port that every
  app on the phone could reach — pi-server does not authenticate peers.
- An unauthenticated request for a directory (e.g. `GET /vendor`) no longer
  crashes the bridge (unhandled `EISDIR`); static serving is confined to
  `public/`.
- Host-header check against DNS rebinding, constant-time token comparison,
  request body limit, token removed from the visible URL/history.
- SSH targets are validated (`user@host[:port]`); option-like targets such as
  `-oProxyCommand=…` are rejected, `--` is passed before the host.
- `env-server.mjs` binds `127.0.0.1` by default, requires a token of at least
  16 characters, compares it in constant time and limits body size.
- `pi-serverd` keeps its state directory at `0700` and its socket at `0600`.
- `auth.json` is written atomically under a lock file (bridge and pi-serverd),
  so a concurrent OAuth refresh cannot lose a rotated refresh token.
- Cleartext HTTP is allowed only for `127.0.0.1`/`localhost`
  (network security config instead of `usesCleartextTraffic`).
- The remote host key fingerprint is shown on connect (trust on first use).

**Durable sessions**

- The selected model is no longer overwritten before every prompt and on every
  remote attach (the code read `viewState().value.agent`, which does not exist;
  agent choices live in `docs['pi.agent']`). `busy` is derived from
  `docs['pi.live'].run`.
- Prompts carry a client-generated `requestId`: retries after a dropped
  connection are exactly-once.
- Every SSE client gets its own `watchEvents()` stream, so a reconnecting chat
  shows the current state instead of the snapshot from when the session was
  opened; pi-durable's `snapshot` and `agent_changed` events are handled.
- Remote events are sequence-numbered with an epoch: several clients can read
  one session, a lost response is fetched again, and a client that fell behind
  or saw a daemon restart reloads the transcript.
- A dropped remote tunnel is rebuilt with backoff and the session re-attached.
- The session registry and the active session are a pi-durable document in
  the same SQLite database, written in the same commit as the conversation;
  old `sessions.json` files are imported once. The active session survives a
  restart.
- Deleting a session aborts its running work first.
- The subagent tool returns the child's answer again (the child handle has no
  `commit()`); its child conversation is shown in the transcript.
- One storage owner: `server.mjs`/`pi-serverd.mjs` take a lock file and stop an
  orphaned predecessor; both close the harness on `SIGTERM`.

**Android**

- Opening the app no longer restarts the running bridge (which interrupted
  running tool calls and briefly opened the database twice). The service runs
  exactly one node process, restarts it with backoff if it dies, and stops it
  with `SIGTERM` + grace period.
- One non-reference-counted wake lock instead of one per start.
- Runtime archives are streamed into `tar` (no temporary 170 MB copy); an
  upgrade replaces `usr/` and `runtime/` completely, user data in `home/` and
  `work/` is kept. `RUNTIME_VERSION` 43.
- Node log rotation; longer first-start wait in the WebView.

**UI**

- Answers stream live (the old code expected a non-existent event shape),
  tool output can be expanded, subagent children and usage/cost are shown.
- *Steer* while a run is busy, *Compact context*, fork and rename sessions,
  remote abort/compact and a reconnect status.
- Shared transcript renderer for local and remote chat, deduplicated by entry
  id; generic `.hidden` CSS rule (remote controls were never hidden).

**Other**

- `env-server`: streamed output (NDJSON); aborting a tool call kills the
  command's whole process group. Remotes can be configured in
  `~/.pi-mobile/remotes.json`.
- Shared `runtime/common.mjs` for both servers; `PI_TEST_FAUX=1` provides a
  scripted offline model for tests.
- `start_server.sh` now actually passes `PI_WORKDIR` to pi-serverd (it was set
  as an unexported shell variable).

## Device test report (0.0.1)

Tested on 2026-10-04, upgrading an installed 0.1.0 build (runtime 42) in place. Remote host: Fedora with OpenSSH, reached over Wi-Fi with the phone's Termux OpenSSH.

| Test | Result |
|---|---|
| Upgrade runtime 42 → 43 | ✅ toybox `tar` reads from stdin, done in ~13 s; `usr/` and `runtime/` replaced, credentials and sessions kept |
| Legacy `sessions.json` | ✅ imported into the durable registry; "Main" and the active session kept |
| `GET /vendor`, foreign `Host`, missing token | ✅ bridge keeps running / 421 / 401 |
| Model choice + real prompt | ✅ `claude-haiku-4-5` stays selected after the prompt, answer "pong" |
| Same `requestId` sent twice | ✅ one submission |
| Activity recreated 3× (`onCreate`) | ✅ node keeps the same PID, no bridge restart |
| Agent kills its own bridge during a bash call | ✅ supervisor restarts node after ~1 s, `resume()` continues the run, bash returns `interrupted`, the model answers |
| WebView UI | ✅ loads over `127.0.0.1` with the network security config; tool line, usage and menu work |
| Remote over Termux OpenSSH | ✅ tunnel socket `0600` in a `0700` directory, host key fingerprint matches the host, daemon socket `0600` |
| Phone's sshd session killed | ✅ status `reconnecting`, reconnected after ~2 s, retried prompt runs exactly once |
| Remote page in the app | ✅ host selected, session attached with full history, model and usage shown |

Not tested on the device: the service's own `SIGTERM` stop path
(`onDestroy`), which cannot be triggered from outside for a non-exported
service.

---

*vibe coding fun with pi* — [Earendil Pi on GitHub](https://github.com/earendil-works/pi)
