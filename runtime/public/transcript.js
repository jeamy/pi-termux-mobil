// transcript.js — renders a pi-durable conversation from its committed entries
// and watchEvents() agent events. Shared by the local chat and the Remote page.
// Entries are deduplicated by id, so a snapshot followed by overlapping events
// (late join, reconnect, history + poll) never shows a message twice.

export function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
}

export class Transcript {
  constructor(chat, { onBusy, onModel, onUsage, onInbox } = {}) {
    this.chat = chat;
    this.hooks = { onBusy, onModel, onUsage, onInbox };
    this.clear();
  }

  clear() {
    this.chat.innerHTML = '';
    this.seen = new Set();      // rendered entry ids
    this.pending = [];          // optimistic user bubbles: { text, el }
    this.live = null;           // in-flight assistant: { el, parts: [] }
    this.tools = new Map();     // toolCallId -> { el, out }
  }

  #el(cls, text) {
    const d = document.createElement('div');
    d.className = cls;
    if (text !== undefined) d.textContent = text;
    const stick = this.chat.scrollHeight - this.chat.scrollTop - this.chat.clientHeight < 40;
    this.chat.appendChild(d);
    if (stick) this.chat.scrollTop = this.chat.scrollHeight;
    return d;
  }
  #scroll() { this.chat.scrollTop = this.chat.scrollHeight; }

  sys(text) { return this.#el('msg sys', text); }

  /** Show the user's text at once; the committed entry confirms it later. */
  addPendingUser(text) {
    const el = this.#el('msg user pending', text);
    this.pending.push({ text, el });
    this.#scroll();
    return el;
  }
  failPending(el, error) {
    this.pending = this.pending.filter((p) => p.el !== el);
    el.classList.remove('pending');
    el.classList.add('failed');
    this.sys(`error: ${error}`);
  }

  #renderEntry(entry) {
    if (entry?.id !== undefined) {
      if (this.seen.has(entry.id)) return;
      this.seen.add(entry.id);
    }
    if (entry?.kind === 'pi.reset') { this.sys('— context reset —'); return; }
    if (entry?.kind === 'pi.compaction') { this.sys('— earlier messages compacted —'); return; }
    for (const m of entry?.model ?? []) {
      if (m.role === 'user') {
        const text = messageText(m);
        const i = this.pending.findIndex((p) => p.text === text);
        if (i >= 0) { this.pending[i].el.classList.remove('pending'); this.pending.splice(i, 1); }
        else if (text) this.#el('msg user', text);
      } else if (m.role === 'assistant') {
        const text = messageText(m);
        if (text) this.#el('msg assistant', text);
        for (const c of Array.isArray(m.content) ? m.content : []) {
          if (c?.type === 'toolCall') this.#toolStart(c.id, c.name, c.arguments);
        }
        if (m.stopReason === 'aborted') this.sys('(interrupted)');
        if (m.stopReason === 'error' && m.errorMessage) this.sys(`error: ${m.errorMessage}`);
      } else if (m.role === 'toolResult') {
        const el = this.tools.get(m.toolCallId)?.el;
        const child = m.details?.conversationId;
        if (el && child !== undefined && !el.dataset.child) {
          el.dataset.child = String(child);
          el.firstChild.textContent += `  → subagent #${child}`;
        }
        if (el) el.classList.toggle('error', Boolean(m.isError));
        else this.#el(`msg tool${m.isError ? ' error' : ''}`, `⚙ ${m.toolName || 'tool'}`);
      }
    }
  }

  /** Render a watchEvents snapshot (or pi-durable's lag `snapshot` event). */
  renderSnapshot(snapshot) {
    this.clear();
    for (const e of snapshot?.entries ?? []) this.#renderEntry(e);
    const partial = snapshot?.generation?.message;
    if (partial) {
      this.live = { el: this.#el('msg assistant live', messageText(partial)), parts: [] };
    }
    for (const t of snapshot?.tools ?? []) { // ToolSlot: { callId, name, status, output, details }
      if (!t?.callId || this.tools.has(t.callId) || t.status === 'done') continue;
      this.#toolStart(t.callId, t.name);
      const slot = this.tools.get(t.callId);
      if (t.output) slot.out.textContent = t.output;
      if (t.details?.conversationId !== undefined) slot.el.firstChild.textContent += `  → subagent #${t.details.conversationId}`;
    }
    if (snapshot?.agent) this.hooks.onModel?.(snapshot.agent.model ?? null);
    if (snapshot?.usage) this.hooks.onUsage?.(snapshot.usage);
    this.hooks.onInbox?.(snapshot?.inbox ?? []);
    this.hooks.onBusy?.(Boolean(snapshot?.run));
    this.#scroll();
  }

  /** Chronological committed entries (history page). */
  renderEntries(entries) { for (const e of entries ?? []) this.#renderEntry(e); this.#scroll(); }

  #toolStart(id, name, args) {
    if (id !== undefined && this.tools.has(id)) return; // committed call and live event are the same tool
    const brief = args ? (args.command || args.path || args.pattern || args.task || JSON.stringify(args).slice(0, 80)) : '';
    const el = this.#el('msg tool', `⚙ ${name || 'tool'}${brief ? `  ${String(brief).slice(0, 200)}` : ''}`);
    const out = document.createElement('pre');
    out.className = 'tool-out hidden';
    el.appendChild(out);
    el.addEventListener('click', () => out.classList.toggle('hidden'));
    this.tools.set(id, { el, out });
  }

  handleEvent(ev) {
    switch (ev.type) {
      case 'snapshot': this.renderSnapshot(ev); break;
      case 'run_start': this.hooks.onBusy?.(true); break;
      case 'run_end': this.live = null; this.hooks.onBusy?.(false); break;
      case 'message_start': {
        if (ev.message?.role === 'assistant') {
          this.live = { el: this.#el('msg assistant live', messageText(ev.message)), parts: [] };
        }
        break;
      }
      case 'message_update': {
        if (!this.live) this.live = { el: this.#el('msg assistant live', ''), parts: [] };
        for (const c of ev.changes ?? []) {
          if (c.type === 'text_delta') this.live.el.textContent += c.delta;
          else if (c.type === 'message') this.live.el.textContent = messageText(c.message);
        }
        this.#scroll();
        break;
      }
      case 'message_end': {
        const isAssistant = ev.entry?.model?.[0]?.role === 'assistant';
        if (isAssistant && this.live) { this.live.el.remove(); this.live = null; }
        this.#renderEntry(ev.entry);
        break;
      }
      case 'entry_appended': this.#renderEntry(ev.entry); break;
      case 'tool_execution_start': this.#toolStart(ev.toolCallId, ev.toolName, ev.args); break;
      case 'tool_execution_update': {
        const t = this.tools.get(ev.toolCallId);
        if (!t) break;
        if (ev.output?.set !== undefined) t.out.textContent = ev.output.set;
        else if (ev.output) {
          if (ev.output.trimStart) t.out.textContent = t.out.textContent.slice(ev.output.trimStart);
          if (ev.output.append) t.out.textContent += ev.output.append;
        }
        const child = ev.details?.conversationId;
        if (child !== undefined && !t.el.dataset.child) {
          t.el.dataset.child = String(child);
          t.el.firstChild.textContent += `  → subagent #${child}`;
        }
        break;
      }
      case 'tool_execution_end': {
        const t = this.tools.get(ev.toolCallId);
        const failed = !ev.entry || ev.entry.model?.[0]?.isError;
        if (t) t.el.classList.toggle('error', Boolean(failed));
        if (ev.entry) this.seen.add(ev.entry.id);
        break;
      }
      case 'agent_changed': this.hooks.onModel?.(ev.agent?.model ?? null); break;
      case 'usage_changed': this.hooks.onUsage?.(ev.usage); break;
      case 'inbox_update': this.hooks.onInbox?.(ev.items ?? []); break;
      case 'compaction_start': this.sys('compacting…'); break;
      case 'compaction_end': this.sys('compaction finished'); break;
      case 'auto_retry_start': this.sys(`retry ${ev.attempt}: ${ev.errorMessage || ''}`); break;
      case 'task_failed': this.sys(`error (${ev.kind}): ${ev.message}`); break;
      case 'submission': {
        const r = ev.record;
        if (r?.status === 'unanswered') this.sys(`not answered: ${r.reason?.type || r.reason || 'failed'}`);
        break;
      }
      default: break;
    }
  }
}

export function usageText(usage) {
  let tokens = 0;
  let cost = 0;
  for (const u of Object.values(usage?.models ?? {})) {
    tokens += u.totalTokens || 0;
    cost += u.cost?.total || 0;
  }
  if (!tokens) return '';
  return `${tokens.toLocaleString()} tok${cost ? ` · $${cost.toFixed(3)}` : ''}`;
}

/** fetch JSON; network failures are retried with the same body (idempotent requestId). */
export async function postJson(url, token, body, { retries = 0 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-token': token },
        body: JSON.stringify(body ?? {}),
      });
      const j = await r.json().catch(() => ({ error: `http ${r.status}` }));
      if ((r.status === 503 && j.reconnecting) && attempt < retries) {
        await new Promise((res) => setTimeout(res, 1500));
        continue;
      }
      return j;
    } catch (e) {
      if (attempt >= retries) return { error: String(e?.message || e) };
      await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
    }
  }
}

export const newRequestId = () => (crypto.randomUUID ? crypto.randomUUID()
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);
