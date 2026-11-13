// UI. All user-controlled strings are rendered with textContent — never innerHTML.

import { Engine, RETENTION_CHOICES, DEFAULT_RETENTION_DAYS } from './core/engine.js';
import { IDBStore } from './core/store.js';
import { Network } from './core/net.js';
import { LinkHost, LinkJoin, LINK_TTL_MS } from './core/link.js';
import { importCard, safetyNumber } from './core/crypto.js';
import { b64u, fromB64u, utf8, fromUtf8 } from './core/encoding.js';
import qrcode from './vendor/qrcode.js';

const $ = (id) => document.getElementById(id);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') el.style.cssText = v; // CSSOM is allowed by the CSP; style attributes are not
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

let engine, net;
let currentConv = null;
let currentTab = 'chats';

// ------------------------------------------------------------------ helpers

function toast(text, action, ms = 4000) {
  const t = $('toast');
  t.replaceChildren(h('span', { text }));
  if (action) t.append(h('button', { class: 'primary', text: action.label, onclick: () => { t.classList.remove('show'); action.run(); } }));
  t.classList.add('show');
  clearTimeout(toast.timer);
  if (!action) toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

function colorFor(fp) {
  const hue = parseInt(fp.slice(0, 4), 16) % 360;
  return `hsl(${hue} 55% 45%)`;
}

function avatar(fp, label, online) {
  return h('div', { class: 'avatar', style: `background:${colorFor(fp)}` },
    (label || '?').trim().charAt(0).toUpperCase() || '?',
    online !== undefined ? h('span', { class: 'dot ' + (online ? 'ok' : ''), title: online ? 'Online' : 'Offline' }) : null);
}

function fmtRetention(days) {
  if (days % 365 === 0) return days === 365 ? '1 year' : `${days / 365} years`;
  if (days % 30 === 0) return days === 30 ? '1 month' : `${days / 30} months`;
  if (days % 7 === 0) return days === 7 ? '1 week' : `${days / 7} weeks`;
  return `${days} day${days === 1 ? '' : 's'}`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtDay(ts) {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Today';
  const y = new Date(today); y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function qrCanvas(text) {
  const qr = qrcode(0, 'L');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount(), scale = 4;
  const c = h('canvas', { class: 'qr', width: n * scale, height: n * scale, role: 'img', 'aria-label': 'QR code' });
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#000';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) ctx.fillRect(x * scale, y * scale, scale, scale);
  return c;
}

async function copy(text, label = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(label); } catch { toast('Copy failed — select the text and copy it manually'); }
}

function myLink() {
  const base = location.origin + location.pathname;
  return base + '#add=' + b64u(utf8(JSON.stringify(engine.myLinkPayload())));
}

/** Accepts an invite link, a bare card code, or raw card JSON. */
function parseCardInput(text) {
  text = text.trim();
  const m = /#add=([A-Za-z0-9_-]+)/.exec(text);
  const code = m ? m[1] : text;
  try { return JSON.parse(fromUtf8(fromB64u(code))); } catch {}
  try { return JSON.parse(text); } catch {}
  throw new Error("That doesn't look like a contact link.");
}

// ------------------------------------------------------------------ dialogs

function openDialog(title, ...content) {
  const dlg = $('dialog');
  const body = $('dialogBody');
  body.replaceChildren(
    h('div', { class: 'dlg-head' }, h('h2', { text: title }), h('button', { class: 'icon', 'aria-label': 'Close', text: '✕', onclick: closeDialog })),
    ...content,
  );
  if (!dlg.open) dlg.showModal();
  return body;
}

function closeDialog() {
  const dlg = $('dialog');
  dlg.dispatchEvent(new Event('cleanup'));
  if (dlg.open) dlg.close();
}

function onDialogClose(fn) {
  $('dialog').addEventListener('cleanup', fn, { once: true });
  $('dialog').addEventListener('close', fn, { once: true });
}

function scanButton(onText) {
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) return null;
  return h('button', {
    type: 'button', text: '📷 Scan QR',
    onclick: async (e) => {
      const btn = e.currentTarget;
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); } catch { return toast('Camera unavailable'); }
      const video = h('video', { class: 'scan', autoplay: true, playsinline: true, muted: true });
      video.srcObject = stream;
      btn.replaceWith(video);
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      let stopped = false;
      const stop = () => { stopped = true; stream.getTracks().forEach((t) => t.stop()); };
      onDialogClose(stop);
      const tick = async () => {
        if (stopped) return;
        try {
          const codes = await detector.detect(video);
          if (codes.length) { stop(); video.remove(); return onText(codes[0].rawValue); }
        } catch {}
        setTimeout(tick, 250);
      };
      video.addEventListener('playing', tick, { once: true });
    },
  });
}

async function addContactFromText(text) {
  const card = parseCardInput(text);
  const c = await engine.addContact(card);
  toast('Added ' + engine.displayName(c.fp) + '. You\'ll connect when you\'re both online.');
  const conv = await engine.directConv(c.fp);
  closeDialog();
  render();
  openConv(conv.id);
}

function showAddContact(prefill = '') {
  const link = myLink();
  const input = h('textarea', { class: 'codebox', placeholder: 'Paste a contact link here', 'aria-label': 'Contact link' });
  input.value = prefill;
  const err = h('div', { class: 'small', style: 'color:var(--bad)' });
  const add = async () => {
    try { await addContactFromText(input.value); } catch (e) { err.textContent = e.message; }
  };
  openDialog('Add contact',
    h('h3', { text: 'Your contact link' }),
    h('p', { class: 'muted small', text: 'Share this with people you want to talk to. It contains only your public keys.' }),
    qrCanvas(link),
    h('div', { class: 'row' },
      h('input', { readonly: true, value: link, class: 'grow mono', onfocus: (e) => e.target.select(), 'aria-label': 'Your link' }),
      h('button', { text: 'Copy', onclick: () => copy(link, 'Link copied') }),
      navigator.share ? h('button', { text: 'Share', onclick: () => navigator.share({ title: 'Message me on Walkie-Talkie', url: link }).catch(() => {}) }) : null),
    h('div', { class: 'section' },
      h('h3', { text: "Add someone else's link" }),
      input, err,
      h('div', { class: 'row end', style: 'margin-top:.5em' },
        scanButton((t) => { input.value = t; add(); }),
        h('button', { class: 'primary', text: 'Add contact', onclick: add }))),
    h('p', { class: 'muted small' }, 'No internet or relays? Use ', h('button', { class: 'link', text: 'direct connection codes', onclick: showManual }), ' instead.'),
  );
}

function showNewGroup() {
  const contacts = [...engine.contacts.values()];
  if (!contacts.length) return toast('Add a contact first');
  const name = h('input', { placeholder: 'Group name', maxlength: 80 });
  const retention = h('select', { 'aria-label': 'Message retention' },
    RETENTION_CHOICES.map((d) => h('option', { value: String(d), selected: d === DEFAULT_RETENTION_DAYS, text: fmtRetention(d) })));
  const boxes = contacts.map((c) => {
    const cb = h('input', { type: 'checkbox', value: c.fp });
    return h('label', {}, cb, avatar(c.fp, engine.displayName(c.fp)), engine.displayName(c.fp));
  });
  openDialog('New group',
    h('label', {}, 'Name', name),
    h('label', {}, 'Messages disappear for everyone after', retention),
    h('h3', { text: 'Members' }),
    h('div', { class: 'checklist' }, boxes),
    h('p', { class: 'muted small', text: 'Members and the retention period are fixed when the group is created, so everyone deletes old messages at the same time. Any member can pass messages along to the others, so the group syncs even if not everyone is online at once.' }),
    h('div', { class: 'row end' }, h('button', {
      class: 'primary', text: 'Create group',
      onclick: async () => {
        const fps = boxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.value);
        if (!fps.length) return toast('Pick at least one member');
        const conv = await engine.createGroup(name.value || 'Group', fps, Number(retention.value));
        closeDialog();
        render();
        openConv(conv.id);
      },
    })),
  );
}

function showManual() {
  let sid = null;
  // Abandon an unanswered invite when the dialog is closed.
  onDialogClose(() => { const p = sid && net.pending.get(sid); if (p && p.state !== 'ready') p.close(); });
  const body = openDialog('Direct connection',
    h('p', { class: 'muted small', text: 'Connect without any relay by exchanging two codes (copy/paste, QR, or any messenger). Works on a local network even with no internet. Codes are single use.' }),
    h('div', { class: 'row' },
      h('button', { class: 'primary grow', text: 'Create an invite code', onclick: () => invite() }),
      h('button', { class: 'grow', text: 'I have a code', onclick: () => respond() })),
    h('div', { id: 'manualArea' }),
  );
  const area = body.querySelector('#manualArea');

  async function invite() {
    area.replaceChildren(h('p', { class: 'muted', text: 'Creating code…' }));
    try {
      const r = await net.createInvite();
      sid = r.sid;
      const reply = h('textarea', { class: 'codebox', placeholder: 'Paste their reply code here' });
      area.replaceChildren(
        h('ol', { class: 'steps' }, h('li', { text: 'Send this code to the other person.' }), h('li', { text: 'They tap "I have a code" and paste it.' }), h('li', { text: 'Paste the reply code they send back.' })),
        qrCanvas(r.code),
        h('textarea', { class: 'codebox', readonly: true, onfocus: (e) => e.target.select() }, r.code),
        h('div', { class: 'row end' }, h('button', { text: 'Copy code', onclick: () => copy(r.code) })),
        h('h3', { text: 'Their reply' }), reply,
        h('div', { class: 'row end', style: 'margin-top:.5em' },
          scanButton((t) => { reply.value = t; finish(reply.value); }),
          h('button', { class: 'primary', text: 'Connect', onclick: () => finish(reply.value) })),
      );
    } catch (e) { area.replaceChildren(h('p', { text: 'Failed: ' + e.message })); }
  }

  async function finish(code) {
    try {
      await net.acceptCode(code);
      area.replaceChildren(h('p', { class: 'muted', text: 'Connecting… this window will close when connected.' }));
      waitConnected();
    } catch (e) { toast(e.message); }
  }

  function respond() {
    const input = h('textarea', { class: 'codebox', placeholder: 'Paste the invite code' });
    const go = async () => {
      try {
        const reply = await net.acceptCode(input.value);
        if (!reply) { waitConnected(); return; }
        area.replaceChildren(
          h('p', { class: 'muted', text: 'Send this reply code back to the person who invited you:' }),
          qrCanvas(reply),
          h('textarea', { class: 'codebox', readonly: true, onfocus: (e) => e.target.select() }, reply),
          h('div', { class: 'row end' }, h('button', { class: 'primary', text: 'Copy reply', onclick: () => copy(reply) })),
          h('p', { class: 'muted small', text: 'This window closes automatically once you are connected.' }),
        );
        waitConnected();
      } catch (e) { toast(e.message); }
    };
    area.replaceChildren(h('h3', { text: 'Invite code' }), input,
      h('div', { class: 'row end', style: 'margin-top:.5em' },
        scanButton((t) => { input.value = t; go(); }),
        h('button', { class: 'primary', text: 'Create reply', onclick: go })));
  }

  function waitConnected() {
    const onPeer = async (e) => {
      if (!e.detail.online) return;
      net.removeEventListener('peers', onPeer);
      const conv = await engine.directConv(e.detail.fp);
      closeDialog();
      toast('Connected to ' + engine.displayName(e.detail.fp));
      render();
      openConv(conv.id);
    };
    net.addEventListener('peers', onPeer);
    onDialogClose(() => net.removeEventListener('peers', onPeer));
  }
}

async function showContact(fp) {
  const c = engine.contacts.get(fp);
  const k = engine.keyring.get(fp);
  const nick = h('input', { value: c?.nick || '', placeholder: k?.name || '', maxlength: 64 });
  const safety = await safetyNumber(engine.identity.fp, fp);
  openDialog(engine.displayName(fp),
    h('div', { class: 'row' }, avatar(fp, engine.displayName(fp), net.isOnline(fp)),
      h('div', {}, h('div', { class: 'strong', text: k?.name || '(no name)' }),
        h('div', { class: 'muted small', text: net.isOnline(fp) ? 'Connected directly now' : 'Not connected' }))),
    c ? h('label', {}, 'Nickname (only you see this)', nick) : h('p', { class: 'muted small', text: 'Not in your contacts — known because you share a group.' }),
    h('h3', { text: 'Safety number' }),
    h('div', { class: 'safety', text: safety }),
    h('p', { class: 'muted small', text: 'Compare this with what they see (in person or by phone). If it matches, nobody swapped keys when you exchanged links.' }),
    h('h3', { text: 'Their fingerprint' }),
    h('div', { class: 'mono', text: fp }),
    h('div', { class: 'row end', style: 'margin-top:1em' },
      c ? h('button', { class: 'danger', text: 'Remove contact', onclick: async () => {
        if (!confirm('Remove this contact? Your message history with them is kept.')) return;
        await engine.removeContact(fp); closeDialog(); render();
      } }) : h('button', { text: 'Add to contacts', onclick: async () => { await engine.addContact(k.card); closeDialog(); render(); } }),
      c ? h('button', { text: 'Save', onclick: async () => { await engine.setNick(fp, nick.value); closeDialog(); render(); } }) : null,
      h('button', { class: 'primary', text: 'Message', onclick: async () => { const conv = await engine.directConv(fp); closeDialog(); render(); openConv(conv.id); } })),
  );
}

function showGroup(convId) {
  const conv = engine.convs.get(convId);
  const view = engine.views.get(convId);
  const name = h('input', { value: view.name || '', maxlength: 80 });
  openDialog('Group info',
    h('label', {}, 'Group name', name),
    h('div', { class: 'row end' }, h('button', { text: 'Rename', onclick: async () => {
      if (name.value.trim() && name.value !== view.name) await engine.renameGroup(convId, name.value.trim());
      closeDialog(); render();
    } })),
    h('p', { class: 'muted small', text: `Messages are deleted for everyone after ${fmtRetention(engine.retentionDays(conv))}. Anyone away longer than that won't receive them.` }),
    h('h3', { text: `Members (${conv.members.length})` }),
    h('ul', { class: 'list' }, conv.members.map((fp) => h('li', {
      onclick: () => fp !== engine.identity.fp && showContact(fp),
      class: fp === engine.identity.fp ? 'static' : '',
    }, avatar(fp, engine.displayName(fp), fp === engine.identity.fp ? undefined : net.isOnline(fp)),
      h('div', { class: 'info' }, h('div', { class: 'title' }, h('span', { text: engine.displayName(fp) })),
        h('div', { class: 'preview', text: fp === conv.createdBy ? 'Created the group' : (engine.isContact(fp) ? 'Contact' : 'Not in your contacts') }))))),
  );
}

function showSettings() {
  const s = engine.settings;
  const name = h('input', { value: engine.identity.name, maxlength: 64 });
  const relays = h('textarea', { rows: 4, class: 'mono', 'aria-label': 'Relays' }, (s.relays || []).join('\n'));
  const ice = h('textarea', { rows: 3, class: 'mono', 'aria-label': 'ICE servers' }, (s.iceServers || []).join('\n'));
  const mailbox = h('textarea', { rows: 2, class: 'mono', 'aria-label': 'Mailbox relays', placeholder: 'wss://relay.example.org' }, (s.mailboxRelays || []).join('\n'));
  const bgStatus = h('div', { class: 'muted small', text: 'Background checks: …' });
  backgroundSyncState().then((st) => { bgStatus.textContent = 'Background checks: ' + BG_TEXT[st]; });
  const notif = h('input', { type: 'checkbox', checked: !!s.notifications });
  const pass = h('input', { type: 'password', placeholder: 'Backup passphrase', autocomplete: 'new-password' });

  openDialog('Settings',
    h('label', {}, 'Display name', name),
    h('h3', { text: 'Your fingerprint' }),
    h('div', { class: 'mono', text: engine.identity.fp }),
    h('label', {}, 'Signalling relays (Nostr, one per line). Used only to find peers who are online; they see nothing readable.', relays),
    h('label', {}, 'STUN/TURN servers (one per line). Help connections through NATs. Leave empty for LAN only.', ice),
    h('label', {}, 'Your mailbox relays (optional, up to 4). Only list Nostr relays you run or trust: contacts store encrypted messages there for you while you are offline, kept for at most 7 days. Public relays above never store anything.', mailbox),
    bgStatus,
    h('label', { class: 'row' }, notif, h('span', { text: 'Show notifications for new messages' })),
    h('div', { class: 'row end' }, h('button', { class: 'primary', text: 'Save settings', onclick: async () => {
      if (name.value.trim() && name.value !== engine.identity.name) await engine.setName(name.value);
      const lines = (t) => t.value.split(/\s+/).map((x) => x.trim()).filter(Boolean);
      if (notif.checked && 'Notification' in window && Notification.permission !== 'granted') {
        const p = await Notification.requestPermission();
        if (p !== 'granted') notif.checked = false;
      }
      const mb = lines(mailbox);
      if (mb.some((u) => !/^wss?:\/\//.test(u))) return toast('Mailbox relays must start with wss://');
      await engine.saveSettings({ relays: lines(relays), iceServers: lines(ice), mailboxRelays: mb, notifications: notif.checked });
      setupBackgroundSync();
      toast('Saved'); closeDialog(); render();
    } })),

    h('div', { class: 'section' },
      h('h3', { text: 'Your devices' }),
      h('p', { class: 'muted small', text: net.ownDevicesOnline()
        ? `${net.ownDevicesOnline()} other device${net.ownDevicesOnline() === 1 ? '' : 's'} of yours connected now. Your devices keep each other's history and contacts in sync.`
        : 'Use the same identity on your phone and computer. Each device keeps the full history and they sync with each other.' }),
      h('button', { text: 'Link a new device…', onclick: showLinkHost })),

    h('div', { class: 'section' },
      h('h3', { text: 'Connect without relays' }),
      h('button', { text: 'Direct connection codes…', onclick: showManual })),

    h('div', { class: 'section' },
      h('h3', { text: 'Backup' }),
      h('p', { class: 'muted small', text: 'Your identity and messages exist only on this device. Export an encrypted backup to move or restore them. Do not run the same identity on two devices at once.' }),
      pass,
      h('div', { class: 'row end', style: 'margin-top:.5em' },
        h('button', { text: 'Export backup', onclick: async () => {
          if (pass.value.length < 8) return toast('Use a passphrase of at least 8 characters');
          const file = await engine.exportBackup(pass.value);
          const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
          const a = h('a', { href: URL.createObjectURL(blob), download: `walkie-talkie-backup-${new Date().toISOString().slice(0, 10)}.json` });
          document.body.append(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        } }))),

    h('div', { class: 'section' },
      h('h3', { text: 'Danger zone' }),
      h('button', { class: 'danger', text: 'Delete everything on this device', onclick: async () => {
        if (!confirm('This permanently deletes your identity, contacts and messages from this device. Continue?')) return;
        net.stop();
        await engine.wipe();
        location.reload();
      } })),
    h('p', { class: 'muted small', style: 'margin-top:1.5em' }, h('span', { id: 'appVersion' })),
  );
  navigator.serviceWorker?.controller && caches.keys().then((k) => { const el = $('appVersion'); if (el) el.textContent = 'Cache: ' + k.join(', '); });
}

// ------------------------------------------------------------------ device linking

async function showLinkHost() {
  let host;
  try { host = await LinkHost.start(engine); } catch (e) { return toast(e.message); }
  const url = location.origin + location.pathname + '#link=' + host.code;
  const status = h('p', { class: 'strong', text: 'Waiting for your new device…' });
  const bar = h('div');
  const left = h('span', { class: 'muted small' });
  const started = Date.now();
  const tick = setInterval(() => {
    const s = Math.max(0, Math.round((LINK_TTL_MS - (Date.now() - started)) / 1000));
    left.textContent = `Code expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
  onDialogClose(() => { clearInterval(tick); if (host.state !== 'done') host.close(); });
  host.addEventListener('status', (e) => {
    const d = e.detail;
    if (d.state === 'connecting') status.textContent = 'New device found, connecting…';
    if (d.state === 'sending') { status.textContent = `Copying your identity and history… ${Math.round((d.progress || 0) * 100)}%`; bar.style.width = (d.progress || 0) * 100 + '%'; }
    if (d.state === 'done') { status.textContent = '✓ Linked. Your new device is ready.'; bar.style.width = '100%'; clearInterval(tick); left.textContent = ''; toast('New device linked'); }
    if (d.state === 'failed') { status.textContent = d.message; clearInterval(tick); }
  });
  openDialog('Link a new device',
    h('ol', { class: 'steps' },
      h('li', { text: 'On your new device, scan this code with the camera (or open the link).' }),
      h('li', { text: 'Or open Walkie-Talkie there and choose "Link to my other device", then paste the link.' })),
    qrCanvas(url),
    h('div', { class: 'row' },
      h('input', { readonly: true, value: url, class: 'grow mono', onfocus: (e) => e.target.select(), 'aria-label': 'Device link' }),
      h('button', { text: 'Copy', onclick: () => copy(url, 'Link copied') })),
    status, h('div', { class: 'progress' }, bar), left,
    h('p', { class: 'small warn', text: '⚠ This code gives full access to your identity and messages. Only open it on a device you own, and don\'t share it. It works once and expires in 5 minutes.' }),
  );
}

function showLinkJoin(prefill = '') {
  const input = h('textarea', { class: 'codebox', placeholder: 'Paste the link shown on your other device', 'aria-label': 'Device link code' });
  input.value = prefill;
  const status = h('p', { class: 'muted' });
  const bar = h('div');
  let join = null;
  onDialogClose(() => { if (join && join.state !== 'done') join.close(); });
  const go = async () => {
    try {
      join = await LinkJoin.start(input.value);
    } catch (e) { status.textContent = e.message; return; }
    btn.disabled = true;
    status.textContent = 'Looking for your other device…';
    join.addEventListener('status', (e) => {
      const d = e.detail;
      if (d.state === 'receiving') { status.textContent = `Receiving your identity and history… ${Math.round((d.progress || 0) * 100)}%`; bar.style.width = (d.progress || 0) * 100 + '%'; }
      if (d.state === 'failed') { status.textContent = d.message; btn.disabled = false; }
    });
    try {
      const state = await join.result;
      status.textContent = 'Saving…';
      await engine.importState(state);
      status.textContent = '✓ Linked. Starting…';
      setTimeout(() => location.replace(location.pathname), 300);
    } catch (e) { status.textContent = e.message; btn.disabled = false; }
  };
  const btn = h('button', { class: 'primary', text: 'Link this device', onclick: go });
  openDialog('Link to my other device',
    h('ol', { class: 'steps' },
      h('li', { text: 'On the device you already use: Settings → Link a new device.' }),
      h('li', { text: 'Scan the code shown there, or paste its link below.' })),
    input,
    h('div', { class: 'row end', style: 'margin-top:.5em' }, scanButton((t) => { input.value = t; go(); }), btn),
    status, h('div', { class: 'progress' }, bar),
  );
  if (prefill) go();
}

function showRestore() {
  const file = h('input', { type: 'file', accept: '.json,application/json' });
  const pass = h('input', { type: 'password', placeholder: 'Passphrase' });
  openDialog('Restore backup',
    h('label', {}, 'Backup file', file),
    h('label', {}, 'Passphrase', pass),
    h('div', { class: 'row end' }, h('button', { class: 'primary', text: 'Restore', onclick: async (e) => {
      const f = file.files[0];
      if (!f) return toast('Choose a file');
      e.target.disabled = true;
      try {
        await engine.importBackup(JSON.parse(await f.text()), pass.value);
        location.reload();
      } catch (err) { toast(err.message); e.target.disabled = false; }
    } })),
  );
}

// ------------------------------------------------------------------ rendering

function renderStatus() {
  const r = net.pool.status();
  const online = navigator.onLine;
  const peers = net.onlineCount();
  const pill = $('statusPill');
  const cls = !online ? 'bad' : r.connected ? 'ok' : 'warn';
  const text = !online ? 'Offline' : r.connected ? `${r.connected}/${r.total} relays · ${peers} peer${peers === 1 ? '' : 's'} online` : (r.total ? 'Connecting to relays…' : `No relays · ${peers} peer${peers === 1 ? '' : 's'}`);
  const mail = r.mailbox ? ` · mailbox ${r.mailboxOpen ? '✓' : '…'}` : '';
  pill.replaceChildren(h('span', { class: 'dot ' + cls }), text + mail);
  $('offlineNote').hidden = online;
}

function renderLists() {
  $('myName').textContent = engine.identity.name;
  // Conversations
  const convs = engine.conversations();
  const list = $('convList');
  list.replaceChildren(...(convs.length ? convs.map(({ conv, title, last, unread }) => {
    const other = conv.kind === 'direct' ? conv.members.find((m) => m !== engine.identity.fp) : null;
    const online = other ? net.isOnline(other) : conv.members.some((m) => m !== engine.identity.fp && net.isOnline(m));
    const preview = last ? (conv.kind === 'group' && last.author !== engine.identity.fp ? engine.displayName(last.author) + ': ' : (last.author === engine.identity.fp ? 'You: ' : '')) + last.text : (conv.kind === 'group' ? 'Group created' : 'No messages yet');
    return h('li', { class: conv.id === currentConv ? 'active' : '', onclick: () => openConv(conv.id), dataset: { conv: conv.id } },
      avatar(other || conv.id.slice(2), title, online),
      h('div', { class: 'info' },
        h('div', { class: 'title' }, h('span', { text: title }), last ? h('span', { class: 'muted small', text: fmtTime(last.ts) }) : null),
        h('div', { class: 'row' }, h('div', { class: 'preview grow', text: preview }), unread ? h('span', { class: 'badge', text: String(unread) }) : null)));
  }) : [h('li', { class: 'empty' }, h('p', { text: 'No conversations yet.' }), h('button', { class: 'primary', text: 'Add a contact', onclick: () => showAddContact() }))]));

  // Contacts + requests
  const reqs = [...engine.requests.values()];
  const badge = $('reqBadge');
  badge.hidden = !reqs.length;
  badge.textContent = String(reqs.length);
  const contacts = [...engine.contacts.values()].sort((a, b) => engine.displayName(a.fp).localeCompare(engine.displayName(b.fp)));
  $('contactList').replaceChildren(
    ...reqs.map((r) => h('li', { class: 'request static' }, avatar(r.fp, r.card.n),
      h('div', { class: 'info' },
        h('div', { class: 'title' }, h('span', { text: r.card.n || r.fp.slice(0, 8) })),
        h('div', { class: 'preview', text: 'Wants to connect · ' + r.fp.slice(0, 12) + '…' })),
      h('button', { class: 'primary', text: 'Accept', onclick: async () => { await engine.addContact(r.card); render(); } }),
      h('button', { text: 'Ignore', onclick: async () => { await engine.dismissRequest(r.fp); render(); } }))),
    ...(contacts.length ? contacts.map((c) => h('li', { onclick: () => showContact(c.fp) },
      avatar(c.fp, engine.displayName(c.fp), net.isOnline(c.fp)),
      h('div', { class: 'info' },
        h('div', { class: 'title' }, h('span', { text: engine.displayName(c.fp) })),
        h('div', { class: 'preview', text: net.isOnline(c.fp) ? 'Online' : 'Offline' })))) : (reqs.length ? [] : [h('li', { class: 'empty' }, h('p', { text: 'No contacts yet.' }), h('button', { class: 'primary', text: 'Add a contact', onclick: () => showAddContact() }))])),
  );

  const totalUnread = convs.reduce((n, c) => n + c.unread, 0);
  document.title = (totalUnread ? `(${totalUnread}) ` : '') + 'Walkie-Talkie';
  navigator.setAppBadge?.(totalUnread).catch?.(() => {});
}

function renderChat() {
  const has = !!currentConv && engine.convs.has(currentConv);
  $('chatEmpty').hidden = has;
  $('chatHeader').hidden = $('messages').hidden = $('composer').hidden = !has;
  $('main').classList.toggle('in-chat', has);
  if (!has) return;
  const conv = engine.convs.get(currentConv);
  const view = engine.views.get(currentConv);
  const me = engine.identity.fp;
  $('chatTitle').textContent = engine.convTitle(conv);
  if (conv.kind === 'direct') {
    const other = conv.members.find((m) => m !== me);
    $('chatSub').textContent = net.isOnline(other) ? '● Connected directly' : 'Offline · messages sync when you are both online';
  } else {
    const on = conv.members.filter((m) => m !== me && net.isOnline(m)).length;
    $('chatSub').textContent = `${conv.members.length} members · ${on} online`;
  }

  const box = $('messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const items = [];
  items.push(h('div', { class: 'sysmsg', text: `🔒 End-to-end encrypted, stored only on members' devices. Messages disappear after ${fmtRetention(engine.retentionDays(conv))}.` }));
  let lastDay = '', lastAuthor = null;
  for (const m of view.list()) {
    const day = fmtDay(m.ts);
    if (day !== lastDay) { items.push(h('div', { class: 'day', text: day })); lastDay = day; lastAuthor = null; }
    const mine = m.author === me;
    const first = m.author !== lastAuthor;
    lastAuthor = m.author;
    const cls = 'msg' + (mine ? ' mine' : '') + (first ? ' first' : '') + (m.deleted ? ' deleted' : '');
    items.push(h('div', { class: cls, dataset: { id: m.id } },
      first && !mine && conv.kind === 'group' ? h('div', { class: 'who', text: engine.displayName(m.author) }) : null,
      m.deleted ? 'Message deleted' : m.text,
      h('span', { class: 'meta', text: fmtTime(m.ts) }),
      mine && !m.deleted ? h('button', { class: 'del', title: 'Delete for everyone', 'aria-label': 'Delete', text: '✕', onclick: async () => {
        if (confirm('Delete this message for everyone?')) await engine.deleteMessage(currentConv, m.id);
      } }) : null));
  }
  box.replaceChildren(...items);
  if (atBottom || renderChat.forceScroll) box.scrollTop = box.scrollHeight;
  renderChat.forceScroll = false;
  if (document.visibilityState === 'visible') engine.markRead(currentConv);
}

function render() {
  renderStatus();
  renderLists();
  renderChat();
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function openConv(id) {
  currentConv = id;
  renderChat.forceScroll = true;
  render();
  if (matchMedia('(min-width: 761px)').matches) $('composerInput').focus();
}

// ------------------------------------------------------------------ notifications

async function notify(conv, env, body) {
  if (!engine.settings.notifications || body.type !== 'msg') return;
  if (document.visibilityState === 'visible' && currentConv === conv) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const c = engine.convs.get(conv);
  const title = c.kind === 'group' ? `${engine.convTitle(c)} · ${engine.displayName(env.author)}` : engine.displayName(env.author);
  const reg = await navigator.serviceWorker?.getRegistration();
  const opts = { body: body.text.slice(0, 140), tag: conv, data: { conv }, icon: 'icons/icon-192.png' };
  if (reg) reg.showNotification(title, opts); else new Notification(title, opts);
}

// ------------------------------------------------------------------ boot

function show(id) {
  for (const s of ['loading', 'locked', 'onboard', 'main']) $(s).hidden = s !== id;
}

function wireMain() {
  $('btnAdd').onclick = () => showAddContact();
  $('btnGroup').onclick = showNewGroup;
  $('btnSettings').onclick = showSettings;
  $('statusPill').onclick = () => toast(net.pool.status().connected
    ? 'Relays only help peers find each other. Messages travel directly, encrypted, between devices.'
    : 'Not connected to any relay. You can still connect with direct connection codes in Settings.', null, 6000);
  $('btnBack').onclick = () => { currentConv = null; render(); };
  $('chatTitleBtn').onclick = () => {
    const conv = engine.convs.get(currentConv);
    if (!conv) return;
    if (conv.kind === 'group') showGroup(conv.id);
    else showContact(conv.members.find((m) => m !== engine.identity.fp));
  };
  for (const b of document.querySelectorAll('.tabs button')) {
    b.onclick = () => {
      currentTab = b.dataset.tab;
      for (const x of document.querySelectorAll('.tabs button')) x.classList.toggle('active', x === b);
      $('convList').hidden = currentTab !== 'chats';
      $('contactList').hidden = currentTab !== 'contacts';
    };
  }
  const input = $('composerInput');
  const resize = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, innerHeight * 0.3) + 'px'; };
  input.addEventListener('input', resize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); }
  });
  $('composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value;
    if (!text.trim() || !currentConv) return;
    input.value = ''; resize();
    renderChat.forceScroll = true;
    await engine.sendText(currentConv, text);
  });
  $('dialog').addEventListener('click', (e) => { if (e.target === $('dialog')) closeDialog(); });
  addEventListener('online', scheduleRender);
  addEventListener('offline', scheduleRender);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && currentConv) engine.markRead(currentConv); });
}

function handleHash() {
  if (/^#link=/.test(location.hash)) {
    history.replaceState(null, '', location.pathname + location.search);
    return toast('This device already has an identity. To link it to another one, first use Settings → Delete everything on this device.', null, 8000);
  }
  const m = /^#add=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  const code = m[1];
  (async () => {
    try {
      const card = JSON.parse(fromUtf8(fromB64u(code)));
      const k = await importCard(card);
      if (k.fp === engine.identity.fp) return toast('That is your own link');
      if (engine.isContact(k.fp)) {
        const conv = await engine.directConv(k.fp);
        return openConv(conv.id);
      }
      openDialog('Add contact?',
        h('div', { class: 'row' }, avatar(k.fp, k.name), h('div', {}, h('div', { class: 'strong', text: k.name || '(no name)' }), h('div', { class: 'mono small', text: k.fp }))),
        h('p', { class: 'muted small', text: 'Once added, you will connect automatically whenever you are both online.' }),
        h('div', { class: 'row end' },
          h('button', { text: 'Cancel', onclick: closeDialog }),
          h('button', { class: 'primary', text: 'Add contact', onclick: () => addContactFromText(code).catch((e) => toast(e.message)) })));
    } catch { toast('Invalid contact link'); }
  })();
}

async function startApp() {
  show('main');
  wireMain();
  net = new Network(engine);
  engine.addEventListener('op', (e) => {
    scheduleRender();
    if (!e.detail.local) notify(e.detail.conv, e.detail.env, e.detail.body);
  });
  engine.addEventListener('change', (e) => {
    scheduleRender();
    if (e.detail.what === 'requests' && e.detail.fp) toast(`${engine.displayName(e.detail.fp)} wants to connect`, { label: 'View', run: () => document.querySelector('[data-tab=contacts]').click() });
  });
  engine.addEventListener('settings', scheduleRender);
  net.addEventListener('peers', scheduleRender);
  net.addEventListener('relays', scheduleRender);
  net.start();
  setupBackgroundSync();
  net.addEventListener('synced', (e) => {
    if (e.detail.via === 'mailbox') toast(`${e.detail.added} message${e.detail.added === 1 ? '' : 's'} picked up from your mailbox`);
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') net.processInbox(); });
  render();
  handleHash();
  addEventListener('hashchange', handleHash);
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type === 'open-conv' && engine.convs.has(e.data.conv)) openConv(e.data.conv);
  });
  setInterval(scheduleRender, 60000); // refresh relative day labels
  setInterval(() => engine.prune(), 3600000); // delete messages past their retention
  window.__iwt = { engine, net }; // debugging handle (also used by the e2e test)
}

// ------------------------------------------------------------------ background mailbox checks

const BG_TEXT = {
  on: 'on. Your browser decides how often (usually a few times a day).',
  off: 'off. Add a mailbox relay to enable them.',
  'needs-install': 'available after you install the app (browser menu → Install).',
  unsupported: 'not supported in this browser (Chromium-based installed apps only). Messages are fetched when you open the app.',
};

async function backgroundSyncState() {
  const reg = await navigator.serviceWorker?.getRegistration();
  if (!reg || !('periodicSync' in reg)) return 'unsupported';
  if (!(engine.settings.mailboxRelays || []).length) return 'off';
  const perm = await navigator.permissions?.query({ name: 'periodic-background-sync' }).catch(() => null);
  if (perm?.state !== 'granted') return 'needs-install';
  return (await reg.periodicSync.getTags()).includes('iwt-mailbox') ? 'on' : 'off';
}

async function setupBackgroundSync() {
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (!reg || !('periodicSync' in reg)) return;
    if (!(engine.settings.mailboxRelays || []).length) return await reg.periodicSync.unregister('iwt-mailbox');
    const perm = await navigator.permissions.query({ name: 'periodic-background-sync' });
    if (perm.state === 'granted') await reg.periodicSync.register('iwt-mailbox', { minInterval: 60 * 60 * 1000 });
  } catch (e) { console.warn('periodic sync unavailable', e); }
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const prompt = (worker) => toast('A new version is available.', { label: 'Update', run: () => worker.postMessage({ type: 'skip-waiting' }) });
    if (reg.waiting && navigator.serviceWorker.controller) prompt(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) prompt(w);
      });
    });
    setInterval(() => reg.update().catch(() => {}), 3600000);
  }).catch((e) => console.warn('SW registration failed', e));
  // Reload only when an *update* takes over, not when the first install claims this page.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !hadController) return;
    reloading = true;
    location.reload();
  });
}

async function boot() {
  registerSW();
  navigator.storage?.persist?.().catch(() => {});
  const store = await new IDBStore().open();
  engine = new Engine(store);
  const hasIdentity = await engine.load();
  if (hasIdentity) return startApp();
  show('onboard');
  $('onboardName').focus();
  $('onboardForm').onsubmit = async (e) => {
    e.preventDefault();
    e.submitter && (e.submitter.disabled = true);
    await engine.createIdentity($('onboardName').value);
    startApp();
  };
  $('onboardRestore').onclick = showRestore;
  $('onboardLink').onclick = () => showLinkJoin();
  // Opened by scanning the link QR code with this device's camera.
  const m = /^#link=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (m) { history.replaceState(null, '', location.pathname + location.search); showLinkJoin(m[1]); }
}

// Only one tab may run the engine (two writers would reuse sequence numbers).
function acquireLock() {
  if (!navigator.locks) return boot();
  navigator.locks.request('iwt-engine', { ifAvailable: true }, (lock) => {
    if (!lock) {
      show('locked');
      $('lockedRetry').onclick = () => {
        const bc = new BroadcastChannel('iwt');
        bc.postMessage({ type: 'yield' });
        bc.close();
        $('lockedRetry').disabled = true;
        navigator.locks.request('iwt-engine', () => { boot().catch(fatal); return new Promise(() => {}); });
      };
      return;
    }
    const bc = new BroadcastChannel('iwt');
    bc.onmessage = (e) => {
      if (e.data?.type === 'yield') {
        net?.stop();
        document.body.replaceChildren(h('div', { class: 'center-screen muted', text: 'Walkie-Talkie moved to another tab. You can close this one.' }));
        resolveLock();
      }
    };
    let resolveLock;
    const held = new Promise((r) => { resolveLock = r; });
    boot().catch(fatal);
    return held;
  });
}

function fatal(e) {
  console.error(e);
  document.body.replaceChildren(h('div', { class: 'center-screen' }, h('div', { class: 'card narrow' },
    h('h1', { text: 'Something went wrong' }), h('p', { class: 'mono', text: String(e?.message || e) }))));
}

acquireLock();
