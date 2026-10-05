// Red warning dialog: copying auth.json hands the phone's API keys / OAuth tokens to the host.
export function askCopyAuth(target) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box';
    const warn = document.createElement('p');
    warn.className = 'danger-text';
    warn.textContent = `⚠ WARNING: ${target} has no auth.json. If you copy it, ALL API keys and OAuth tokens stored on this phone are copied to that machine (~/.pi/agent/auth.json) and can be used by anyone with access to it. Only do this for hosts you fully trust.`;
    const ask = document.createElement('p');
    ask.textContent = 'Copy auth.json to this host?';
    const row = document.createElement('div');
    row.className = 'modal-row';
    const done = (v) => { overlay.remove(); resolve(v); };
    for (const [label, v, cls] of [['Yes, copy', true, 'danger-btn'], ['No', false, '']]) {
      const b = document.createElement('button');
      b.textContent = label;
      if (cls) b.className = cls;
      b.addEventListener('click', () => done(v));
      row.appendChild(b);
    }
    box.append(warn, ask, row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}


/** Neutral yes/no dialog: offer to install this device's ssh key on the host (password needed once). */
export function askInstallKey(target) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box';
    const msg = document.createElement('p');
    msg.textContent = `${target} does not accept this device's SSH key. Install it now with ssh-copy-id? You will be asked for the host password once.`;
    const row = document.createElement('div');
    row.className = 'modal-row';
    const done = (v) => { overlay.remove(); resolve(v); };
    for (const [label, v] of [['Yes, install key', true], ['No', false]]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', () => done(v));
      row.appendChild(b);
    }
    box.append(msg, row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}

/** Neutral dialog: the daemon on the host is outdated; updating restarts it. */
export function askUpdate(target, info) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box';
    const msg = document.createElement('p');
    msg.textContent = `pi-serverd on ${target} is outdated (${info.installed || 'unknown'} → ${info.available}). Update it now? The daemon is restarted and running work is interrupted; durable sessions resume afterwards.`;
    const row = document.createElement('div');
    row.className = 'modal-row';
    const done = (v) => { overlay.remove(); resolve(v); };
    for (const [label, v] of [['Yes, update', true], ['No, keep old version', false]]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', () => done(v));
      row.appendChild(b);
    }
    box.append(msg, row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}
