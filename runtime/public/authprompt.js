// One modal implementation for security decisions. Never interpolate remote text as HTML.
function ask(message, yes, no, danger = false) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box';
    const text = document.createElement('p');
    text.textContent = message;
    if (danger) text.className = 'danger-text';
    const row = document.createElement('div');
    row.className = 'modal-row';
    const done = (v) => { overlay.remove(); resolve(v); };
    for (const [label, v] of [[yes, true], [no, false]]) {
      const button = document.createElement('button');
      button.textContent = label;
      if (v && danger) button.className = 'danger-btn';
      button.addEventListener('click', () => done(v));
      row.appendChild(button);
    }
    box.append(text, row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}
export const askTrustHost = (target, fingerprint) => ask(
  `Verify the SSH host fingerprint for ${target} OUTSIDE this app before continuing: ${fingerprint}. A fake host could steal all API keys and OAuth tokens from this phone. Do you trust this fingerprint?`,
  'Fingerprint verified', 'Cancel', true);
export const askCopyAuth = (target) => ask(
  `WARNING: ${target} has no auth.json. Copy ALL API keys and OAuth tokens stored on this phone to the host? Anyone with access to that host could use them.`,
  'Yes, copy', 'No', true);
export const askInstallKey = (target) => ask(
  `${target} does not accept this device's SSH key. Install it with ssh-copy-id? You will be asked for the host password once.`,
  'Yes, install key', 'No');
export const askUpdate = (target, info) => ask(
  `pi-serverd on ${target} is outdated (${info.installed || 'unknown'} → ${info.available}). Update it now? Running work is interrupted; durable sessions resume afterwards.`,
  'Yes, update', 'No, keep old version');
