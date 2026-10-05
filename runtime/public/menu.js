import { API } from './constants.js';

// Shared header setup and bottom navigation for every page.
// renderMenu() is called once per page and returns the session token.
export function renderMenu() {
  const token = new URLSearchParams(location.search).get('token')
    || localStorage.getItem('pi-token') || '';
  if (token) localStorage.setItem('pi-token', token);

  // strip the token from the visible URL and WebView history
  const params = new URLSearchParams(location.search);
  if (params.has('token')) {
    params.delete('token');
    const rest = params.toString();
    history.replaceState(null, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`);
  }
  const q = (p) => `${p}?token=${encodeURIComponent(token)}`;

  const bar = document.getElementById('menubar');
  if (!bar) return token;

  // Brand link
  const brand = document.createElement('a');
  brand.id = 'brand';
  brand.href = q('/');
  brand.innerHTML = '<span class="brand-pi">π</span> mobile';
  bar.prepend(brand);

  const page = document.body.dataset.page;

  // ── Terminal page: hamburger → slide-up nav sheet ─────────────────────────
  if (page === 'term') {
    const menuBtn = document.createElement('button');
    menuBtn.id = 'btn-menu';
    menuBtn.title = 'Navigation';
    menuBtn.textContent = '≡';
    menuBtn.style.marginLeft = 'auto';
    bar.appendChild(menuBtn);

    const overlay = document.createElement('div');
    overlay.id = 'nav-sheet-overlay';
    overlay.className = 'hidden';
    const sheet = document.createElement('div');
    sheet.id = 'nav-sheet';
    const tabs = [
      { href: '/',             icon: '💬', label: 'Chat' },
      { href: '/remote.html',  icon: '⌁',  label: 'Remote' },
      { href: '/terminal.html',icon: '>_', label: 'pi CLI (local)' },
      { href: '/clients.html', icon: '⊟',  label: 'Clients' },
      { href: '/keys.html',    icon: '⚿',  label: 'Accounts' },
    ];
    for (const t of tabs) {
      const a = document.createElement('a');
      a.href = q(t.href);
      a.innerHTML = `<span class="nav-icon">${t.icon}</span>${t.label}`;
      sheet.appendChild(a);
    }
    // SSH target option
    const sshA = document.createElement('a');
    sshA.href = '#';
    sshA.innerHTML = '<span class="nav-icon">⌁</span>pi CLI (ssh)…';
    sshA.addEventListener('click', (e) => {
      e.preventDefault();
      overlay.classList.add('hidden');
      const target = prompt('SSH target (user@host[:port]):', localStorage.getItem('pi-ssh-target') || '');
      if (!target) return;
      localStorage.setItem('pi-ssh-target', target);
      location.href = `/terminal.html?token=${encodeURIComponent(token)}&ssh=${encodeURIComponent(target)}`;
    });
    sheet.appendChild(sshA);
    const close = document.createElement('span');
    close.id = 'nav-sheet-close';
    close.textContent = '✕  close';
    sheet.appendChild(close);
    overlay.appendChild(sheet);
    document.body.appendChild(overlay);

    const showSheet = () => overlay.classList.remove('hidden');
    const hideSheet = () => overlay.classList.add('hidden');
    menuBtn.addEventListener('click', showSheet);
    close.addEventListener('click', hideSheet);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) hideSheet(); });
    return token;
  }

  // ── All other pages: bottom navigation bar ────────────────────────────────
  const nav = document.createElement('nav');
  nav.id = 'bottom-nav';
  const PAGES = {
    chat:     ['chat', 'sessions'],
    remote:   ['remote'],
    term:     ['term'],
    clients:  ['clients'],
    keys:     ['keys'],
  };
  const tabs = [
    { key: 'chat',    href: '/',             icon: '💬', label: 'Chat' },
    { key: 'remote',  href: '/remote.html',  icon: '⌁',  label: 'Remote' },
    { key: 'term',    href: '/terminal.html',icon: '>_', label: 'CLI' },
    { key: 'clients', href: '/clients.html', icon: '⊟',  label: 'Clients' },
    { key: 'keys',    href: '/keys.html',    icon: '⚿',  label: 'Keys' },
  ];
  for (const tab of tabs) {
    const a = document.createElement('a');
    a.href = q(tab.href);
    if ((PAGES[tab.key] ?? []).includes(page)) a.className = 'active';
    a.innerHTML = `<span class="nav-icon">${tab.icon}</span><span class="nav-label">${tab.label}</span>`;
    nav.appendChild(a);
  }
  document.body.appendChild(nav);
  return token;
}
