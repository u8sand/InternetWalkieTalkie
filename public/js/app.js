// UI. All user-controlled strings are rendered with textContent — never innerHTML.

import { Engine, RETENTION_CHOICES, DEFAULT_RETENTION_DAYS, directConvId } from './core/engine.js';
import { IDBStore } from './core/store.js';
import { Network } from './core/net.js';
import { LinkHost, LinkJoin, LINK_TTL_MS } from './core/link.js';
import { importCard, safetyNumber } from './core/crypto.js';
import { b64u, fromB64u, utf8, fromUtf8 } from './core/encoding.js';
import qrcode from './vendor/qrcode.js';
import { MAX_FILE_BYTES, inlineKind } from './core/files.js';

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
let selectedMsg = null;       // message whose actions are showing (tap to select on touch screens)
let searchQuery = '';
const typing = new Map();     // conv -> Map<fp, expiry ms>: who is typing there right now

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

function fmtAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  const day = fmtDay(ts);
  return day === 'Today' ? 'today at ' + fmtTime(ts) : day === 'Yesterday' ? 'yesterday at ' + fmtTime(ts) : 'on ' + day;
}

function typingIn(convId) {
  const m = typing.get(convId);
  if (!m) return [];
  const now = Date.now();
  for (const [fp, until] of m) if (until < now) m.delete(fp);
  return [...m.keys()];
}

function typingText(convId, group) {
  const who = typingIn(convId);
  if (!who.length) return '';
  if (!group) return 'typing…';
  const names = who.map((fp) => engine.displayName(fp));
  return (names.length > 2 ? `${names.length} people are` : names.join(' and ') + (names.length === 1 ? ' is' : ' are')) + ' typing…';
}

const TICKS = {
  read: { text: '✓✓', cls: 'tick read', label: 'Read' },
  got: { text: '✓', cls: 'tick', label: 'Delivered to their device' },
  relay: { text: '✓', cls: 'tick', label: 'Delivered to their mailbox' },
  null: { text: '◷', cls: 'tick', label: 'Waiting: will be delivered when they open the app' },
};

function tickFor(convId, m) {
  const conv = engine.convs.get(convId);
  const r = engine.receiptState(convId, m);
  const t = TICKS[r.state];
  let title = t.label;
  if (conv.kind === 'group') {
    const by = (s) => Object.entries(r.members).filter(([, v]) => v === s).map(([fp]) => engine.displayName(fp));
    title = [['Read by', by('read')], ['Delivered to', [...by('got'), ...by('relay')]], ['Waiting for', by(null)]]
      .filter(([, l]) => l.length).map(([k, l]) => `${k} ${l.join(', ')}`).join('\n');
  }
  return h('span', { class: t.cls, title, 'aria-label': title, text: t.text });
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

// ------------------------------------------------------------------ attachments

const THUMB_PX = 48;

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return Math.round(n / 1024) + ' KB';
  return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
}

/**
 * Files are sent exactly as they are. For photos we only read the size and make a tiny
 * blurred preview to show while the original downloads.
 */
async function prepareFile(file) {
  const out = { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name || 'file', mime: file.type || 'application/octet-stream' };
  if (inlineKind(out.mime) !== 'image') return out;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const s = Math.min(1, THUMB_PX / Math.max(bmp.width, bmp.height));
    const c = h('canvas', { width: Math.max(1, Math.round(bmp.width * s)), height: Math.max(1, Math.round(bmp.height * s)) });
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#888'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    let thumb = c.toDataURL('image/webp', 0.5);
    if (!thumb.startsWith('data:image/webp')) thumb = c.toDataURL('image/jpeg', 0.5);
    return { ...out, thumb, w: bmp.width, h: bmp.height };
  } catch { return out; } // can't decode it here: still sent, just without a preview
}

async function sendFiles(files) {
  if (!currentConv || !files.length) return;
  const convId = currentConv;
  const input = $('composerInput');
  let caption = input.value.trim() ? input.value : '';
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) { toast(`${f.name} is too large (max ${fmtSize(MAX_FILE_BYTES)})`); continue; }
    try {
      const p = await prepareFile(f);
      renderChat.forceScroll = true;
      await engine.sendFile(convId, { ...p, caption });
      if (caption) { caption = ''; input.value = ''; input.dispatchEvent(new Event('input')); }
    } catch (e) {
      toast(e.name === 'QuotaExceededError' ? 'This device is out of storage space' : 'Could not send ' + f.name + ': ' + e.message);
    }
  }
}

// One element per file, reused across renders so playing media and loaded images survive.
const fileNodes = new Map(); // file id -> {el, done, url}

async function fileBlobUrl(file) {
  const bytes = await engine.readFile(file.id);
  if (!bytes) return null;
  // Never hand the browser an active type (HTML, SVG…) for a blob URL from our origin.
  const type = inlineKind(file.mime) ? file.mime : 'application/octet-stream';
  return URL.createObjectURL(new Blob([bytes], { type }));
}

async function saveFile(file) {
  const url = fileNodes.get(file.id)?.url || await fileBlobUrl(file);
  if (!url) return toast('Not downloaded yet');
  const a = h('a', { href: url, download: file.name });
  document.body.append(a); a.click(); a.remove();
}

function showImage(file, url) {
  openDialog(file.name,
    h('img', { class: 'viewer', src: url, alt: file.name }),
    h('div', { class: 'row end', style: 'margin-top:.6em' },
      h('span', { class: 'muted small grow', text: fmtSize(file.size) }),
      h('button', { class: 'primary', text: 'Save', onclick: () => saveFile(file) })));
}

/** On-screen size for a photo: fits 320×320 (narrower on small screens), keeping its shape. */
function photoStyle(file) {
  if (!file.w || !file.h) return undefined;
  const box = Math.min(320, Math.round(innerWidth * 0.62));
  const s = Math.min(1, box / file.w, box / file.h);
  return `width:${Math.max(48, Math.round(file.w * s))}px;height:${Math.max(48, Math.round(file.h * s))}px`;
}

function attachmentNode(m) {
  const file = m.file;
  let n = fileNodes.get(file.id);
  if (!n) { n = { el: h('div', { class: 'att' }), done: false, building: false }; fileNodes.set(file.id, n); }
  if (n.done || n.building) return n.el;
  const kind = inlineKind(file.mime);
  if (engine.hasFile(file.id)) {
    n.building = true;
    fileBlobUrl(file).then((url) => {
      n.building = false;
      if (!url) return;
      n.url = url; n.done = true;
      const media = kind === 'image'
        ? h('img', { class: 'att-img', src: url, alt: file.name, onclick: () => showImage(file, url), style: photoStyle(file) })
        : kind === 'video' ? h('video', { class: 'att-img', src: url, controls: true, preload: 'metadata', playsinline: true })
        : kind === 'audio' ? h('audio', { src: url, controls: true, preload: 'metadata' })
        : null;
      n.el.replaceChildren(media || fileChip(file, null));
      if (media && kind !== 'image') n.el.append(fileChip(file, null, true));
    }).catch(() => { n.building = false; });
    return n.el;
  }
  // Large files from other people are fetched only when asked for.
  if (engine.fileNeedsConsent(m)) {
    n.el.replaceChildren(
      kind === 'image' && file.thumb ? h('img', { class: 'att-img blur', src: file.thumb, alt: '', style: photoStyle(file) }) : null,
      h('div', { class: 'att-file' },
        h('span', { class: 'att-icon', text: '📄' }),
        h('div', { class: 'grow' }, h('div', { class: 'att-name', text: file.name }), h('div', { class: 'att-meta', text: fmtSize(file.size) })),
        h('button', { class: 'att-save', text: 'Download', onclick: () => { engine.wantFile(file.id); net.files.kick(); attachmentNode(m); } })));
    return n.el;
  }
  // Still fetching (or waiting for someone who has it to come online).
  const st = net.files.status(file.id);
  const pct = st ? Math.floor((st.have / st.total) * 100) : 0;
  const label = st?.waiting ? (m.author === engine.identity.fp ? 'Waiting for one of your devices…' : `Waiting for ${engine.displayName(m.author)} or another member to come online`) : `Downloading… ${pct}%`;
  n.el.replaceChildren(
    kind === 'image' && file.thumb ? h('img', { class: 'att-img blur', src: file.thumb, alt: '', style: photoStyle(file) }) : null,
    fileChip(file, label));
  return n.el;
}

function fileChip(file, status, small) {
  return h('div', { class: 'att-file' + (small ? ' small' : '') },
    h('span', { class: 'att-icon', text: '📄' }),
    h('div', { class: 'grow' }, h('div', { class: 'att-name', text: file.name }), h('div', { class: 'att-meta', text: status || fmtSize(file.size) })),
    status ? null : h('button', { class: 'att-save', text: 'Save', onclick: () => saveFile(file) }));
}

function filePreview(m) {
  if (!m.file) return m.text;
  const icon = inlineKind(m.file.mime) === 'image' ? '📷 ' + (m.text || 'Photo') : inlineKind(m.file.mime) === 'video' ? '🎬 ' + (m.text || 'Video') : '📎 ' + (m.text || m.file.name);
  return icon;
}

// ------------------------------------------------------------------ how it works

function showHowItWorks() {
  const sec = (icon, title, ...body) => h('div', { class: 'how' }, h('div', { class: 'how-icon', 'aria-hidden': 'true', text: icon }),
    h('div', {}, h('h3', { text: title }), ...body.map((t) => h('p', { text: t }))));
  openDialog('How Walkie-Talkie works',
    sec('📻', 'Like a walkie-talkie',
      'When you send a message, it goes straight from your device to the other person\'s, in real time, as long as they have the app open. There\'s no company server in the middle storing or passing on your conversations.'),
    sec('⏳', 'When they\'re not listening',
      'Unlike a walkie-talkie, nothing is lost. If they don\'t have the app open, your message waits safely on your device and is sent the moment you\'re both online. Under each message: ◷ waiting, ✓ delivered, ✓✓ read.',
      'In a group, anyone in it who is online passes messages along, so the chat keeps flowing even if not everyone is around at once.'),
    sec('🔒', 'Unlike a walkie-talkie, it\'s private',
      'Everything is end-to-end encrypted: scrambled on your device and only unscrambled on the devices of the people in the chat. Nobody else can read it, not even the services that help your devices find each other.'),
    sec('📱', 'Your messages stay with you',
      'Your messages, photos and contacts are stored on your device, and on the devices of the people you talk with. Nowhere else. There\'s no account, phone number or password to steal.',
      'That also means there\'s no cloud copy. If you lose this device, your messages go with it. To be safe, link your other devices or save a backup (Settings).'),
    sec('🔎', 'Who can see what',
      'To find each other over the internet, devices use public "meeting points" (relays). They only ever see scrambled data. They can\'t see who you are, who you talk to or what you say. Messages disappear automatically after a year (or sooner, if a group chooses).'),
    h('div', { class: 'row end', style: 'margin-top:1em' }, h('button', { class: 'primary', text: 'Got it', onclick: closeDialog })),
  );
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

function shareText(link) {
  return `Let's chat privately on Walkie-Talkie (end-to-end encrypted, no accounts). Open this link to add me as ${engine.identity.name}: ${link}`;
}

async function shareMyLink() {
  const link = myLink();
  if (navigator.share) {
    try { await navigator.share({ title: 'Chat with me on Walkie-Talkie', text: shareText(link).replace(link, '').trim(), url: link }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  copy(shareText(link), 'Invite message copied: paste it anywhere');
}

function showAddContact(prefill = '') {
  const link = myLink();
  const input = h('textarea', { class: 'codebox', placeholder: 'Paste their link here', 'aria-label': 'Contact link' });
  input.value = prefill;
  const err = h('div', { class: 'small', style: 'color:var(--bad)' });
  const add = async () => {
    try { await addContactFromText(input.value); } catch (e) { err.textContent = e.message; }
  };
  openDialog('Connect with someone',
    h('h3', { text: 'Invite someone' }),
    h('p', { class: 'muted small', text: 'Send them your link, or let them scan this code with their phone camera. Whoever opens it is added as your contact automatically, with nothing to approve.' }),
    h('button', { class: 'qr-btn', title: 'Show larger', 'aria-label': 'Show QR code larger', onclick: () => showBigQR(link) }, qrCanvas(link)),
    h('div', { class: 'row share-row' },
      h('button', { class: 'primary grow', text: navigator.share ? 'Share link…' : 'Copy invite message', onclick: shareMyLink }),
      h('button', { class: 'grow', text: 'Copy link', onclick: () => copy(link, 'Link copied') })),
    h('details', { class: 'small muted' }, h('summary', { text: 'Show link' }),
      h('input', { readonly: true, value: link, class: 'mono', onfocus: (e) => e.target.select(), 'aria-label': 'Your link' })),
    h('div', { class: 'section' },
      h('h3', { text: 'Got someone\'s link or QR code?' }),
      h('p', { class: 'muted small', text: 'Just open their link, or scan their code with your camera app. Or paste it here:' }),
      input, err,
      h('div', { class: 'row end', style: 'margin-top:.5em' },
        scanButton((t) => { input.value = t; add(); }),
        h('button', { class: 'primary', text: 'Add contact', onclick: add }))),
    h('p', { class: 'muted small' }, 'Together without internet? Use ', h('button', { class: 'link', text: 'direct connection codes', onclick: showManual }), '.'),
  );
}

/** Full-screen QR for someone else to scan off your screen. */
function showBigQR(link) {
  openDialog('Scan to add ' + engine.identity.name,
    h('div', { class: 'big-qr' }, qrCanvas(link)),
    h('p', { class: 'muted small center', text: 'Point a phone camera at this code. It opens Walkie-Talkie and adds you.' }),
    h('div', { class: 'row end' }, h('button', { text: 'Back', onclick: () => showAddContact() })),
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
  const dc = engine.convs.get(await directConvId(engine.identity.fp, fp));
  const hasHistory = dc && engine.views.get(dc.id).list().length > 0;
  openDialog(engine.displayName(fp),
    h('div', { class: 'row' }, avatar(fp, engine.displayName(fp), net.isOnline(fp)),
      h('div', {}, h('div', { class: 'strong', text: k?.name || '(no name)' }),
        h('div', { class: 'muted small', text: net.isOnline(fp) ? 'Online now, ' + ROUTE_TEXT[net.route(fp)] : engine.seen[fp] ? 'Last seen ' + fmtAgo(engine.seen[fp]) : 'Not connected' }))),
    c ? h('label', {}, 'Nickname (only you see this)', nick) : h('p', { class: 'muted small', text: 'Not in your contacts — known because you share a group.' }),
    h('h3', { text: 'Safety number' }),
    h('div', { class: 'safety', text: safety }),
    h('p', { class: 'muted small', text: 'Compare this with what they see (in person or by phone). If it matches, nobody swapped keys when you exchanged links.' }),
    h('h3', { text: 'Their fingerprint' }),
    h('div', { class: 'mono', text: fp }),
    h('div', { class: 'row end', style: 'margin-top:1em' },
      hasHistory ? h('button', { class: 'danger', text: 'Delete chat', onclick: () => deleteChat(dc.id) }) : null,
      c ? h('button', { class: 'danger', text: 'Remove contact', onclick: async () => {
        if (!confirm('Remove this contact? They will no longer be able to connect to you, message you or send you requests unless you add them again. Your message history with them is kept (use Delete chat to remove it).')) return;
        await engine.removeContact(fp); closeDialog(); render();
      } }) : h('button', { text: 'Add to contacts', onclick: async () => { await engine.addContact(k.card); closeDialog(); render(); } }),
      c ? h('button', { text: 'Save', onclick: async () => { await engine.setNick(fp, nick.value); closeDialog(); render(); } }) : null,
      h('button', { class: 'primary', text: 'Message', onclick: async () => { const conv = await engine.directConv(fp); closeDialog(); render(); openConv(conv.id); } })),
  );
}

function showMessage(convId, m) {
  const conv = engine.convs.get(convId);
  const mine = m.author === engine.identity.fp;
  const r = mine && !m.deleted ? engine.receiptState(convId, m) : null;
  const label = { read: 'Read', got: 'Delivered', relay: 'In their mailbox', null: 'Not delivered yet' };
  openDialog('Message',
    m.deleted ? h('p', { class: 'muted', text: 'Message deleted' }) : h('div', { class: 'quote', text: m.file ? `${m.file.name} (${fmtSize(m.file.size)})${m.text ? '\n' + m.text : ''}` : m.text.length > 400 ? m.text.slice(0, 400) + '…' : m.text }),
    h('p', { class: 'muted small', text: `${mine ? 'You' : engine.displayName(m.author)} · ${fmtDay(m.ts)} ${fmtTime(m.ts)}` }),
    r ? h('ul', { class: 'list receipts' }, Object.entries(r.members).map(([fp, st]) => h('li', { class: 'static' },
      avatar(fp, engine.displayName(fp)),
      h('div', { class: 'info' }, h('div', { class: 'title' }, h('span', { text: engine.displayName(fp) })),
        h('div', { class: 'preview', text: label[st] }))))) : null,
    h('div', { class: 'row end', style: 'margin-top:1em' },
      m.file && engine.hasFile(m.file.id) ? h('button', { text: 'Save file', onclick: () => saveFile(m.file) }) : null,
      m.deleted || !m.text ? null : h('button', { text: 'Copy text', onclick: () => { copy(m.text); closeDialog(); } }),
      h('button', { text: 'Delete for me', title: 'Removes it from your devices only', onclick: async () => {
        await engine.forgetMessages(convId, [m.id]); selectedMsg = null; closeDialog();
      } }),
      mine && !m.deleted ? h('button', { class: 'danger', text: 'Delete for everyone', onclick: async () => {
        if (!confirm(conv.kind === 'group' ? 'Delete this message for everyone in the group?' : 'Delete this message for everyone?')) return;
        await engine.deleteMessage(convId, m.id); selectedMsg = null; closeDialog();
      } }) : null),
  );
}

/** Clear a chat's history from this device and our other devices, and drop it from the list. */
async function deleteChat(convId) {
  const conv = engine.convs.get(convId);
  const others = conv.kind === 'group' ? 'Other members keep their copies.' : `${engine.convTitle(conv)} keeps their copy.`;
  if (!confirm(`Delete this chat? Its messages are removed from this device and your other devices. ${others}`)) return false;
  await engine.clearConv(convId, { hide: true });
  if (currentConv === convId) currentConv = null;
  closeDialog();
  render();
  toast('Chat deleted');
  return true;
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
    h('div', { class: 'row end', style: 'margin-top:1em' },
      h('button', { class: 'danger', text: 'Delete chat history', onclick: () => deleteChat(convId) })),
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
  const direct = h('input', { type: 'checkbox', checked: s.directConnections !== false, 'aria-label': 'Connect directly' });
  const receipts = h('input', { type: 'checkbox', checked: s.receipts !== false, 'aria-label': 'Send read receipts and typing indicators' });
  const pass = h('input', { type: 'password', placeholder: 'Backup passphrase', autocomplete: 'new-password' });

  openDialog('Settings',
    h('label', {}, 'Your name', name),
    h('label', { class: 'row' }, notif, h('span', { text: 'Show notifications for new messages' })),
    h('label', { class: 'row' }, receipts, h('span', { text: 'Let people see when I\'ve read their messages and when I\'m typing' })),
    h('details', { class: 'advanced' }, h('summary', { text: 'Advanced: network settings' }),
      h('p', { class: 'muted small', text: 'You don\'t need to change these. They control how your device finds the people you talk to.' }),
      h('label', {}, 'Meeting points (Nostr relays, one per line). Used only to help devices find each other; they never see anything readable.', relays),
      h('label', {}, 'STUN/TURN servers (one per line). Help devices connect through home routers. A TURN server carries the connection when devices can\'t reach each other directly; put its username and password after the address, e.g. turn:turn.example.org:3478 name password', ice),
      h('label', { class: 'row' }, direct, h('span', { text: 'Connect directly to the people I talk to (faster, and needed for photos and files; they can see my network address). When this is off, or devices can\'t reach each other, messages travel through the meeting points instead.' })),
      h('label', {}, 'Your mailbox (optional, up to 4 Nostr relays you run or trust). People can leave encrypted messages there while your app is closed; they\'re kept for at most 7 days. Without one, messages wait until you\'re both online.', mailbox),
      bgStatus,
      h('h3', { text: 'Your fingerprint' }),
      h('div', { class: 'mono', text: engine.identity.fp })),
    h('div', { class: 'row end' }, h('button', { class: 'primary', text: 'Save settings', onclick: async () => {
      if (name.value.trim() && name.value !== engine.identity.name) await engine.setName(name.value);
      const lines = (t) => t.value.split(/\s+/).map((x) => x.trim()).filter(Boolean);
      const rows = (t) => t.value.split(/\n+/).map((x) => x.trim()).filter(Boolean); // a TURN line has spaces
      if (notif.checked && 'Notification' in window && Notification.permission !== 'granted') {
        const p = await Notification.requestPermission();
        if (p !== 'granted') notif.checked = false;
      }
      const mb = lines(mailbox);
      if (mb.some((u) => !/^wss?:\/\//.test(u))) return toast('Mailbox relays must start with wss://');
      await engine.saveSettings({ relays: lines(relays), iceServers: rows(ice), mailboxRelays: mb, notifications: notif.checked, receipts: receipts.checked, directConnections: direct.checked });
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
      h('h3', { text: 'Your contact link' }),
      h('p', { class: 'muted small', text: 'Anyone who opens your link is added automatically. If it ended up somewhere it shouldn\'t, reset it: old links will only send you contact requests.' }),
      h('button', { text: 'Reset my contact link', onclick: async () => {
        if (!confirm('Make a new contact link? People using your old link will need you to accept their request.')) return;
        await engine.resetInvite();
        toast('Your contact link was reset');
      } })),

    h('div', { class: 'section' },
      h('h3', { text: 'Connect without relays' }),
      h('button', { text: 'Direct connection codes…', onclick: showManual })),

    h('div', { class: 'section' },
      h('h3', { text: 'Backup' }),
      h('p', { class: 'muted small', text: 'Your messages are only on your devices: there\'s no cloud copy. If you lose this device, they\'re gone unless you linked another device or saved a backup. A backup is a file locked with a passphrase you choose. Photos and files aren\'t included (a restored device fetches them from the people you talk to).' }),
      pass,
      h('div', { class: 'row end', style: 'margin-top:.5em' },
        h('button', { text: 'Export backup', onclick: async () => {
          if (pass.value.length < 12) return toast('Use a passphrase of at least 12 characters (several random words work well)');
          const file = await engine.exportBackup(pass.value);
          const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
          const a = h('a', { href: URL.createObjectURL(blob), download: `walkie-talkie-backup-${new Date().toISOString().slice(0, 10)}.json` });
          document.body.append(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        } }))),

    h('div', { class: 'section' },
      h('h3', { text: 'Danger zone' }),
      h('p', { class: 'muted small', text: 'There\'s no copy anywhere else, so this can\'t be undone.' }),
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
    status.className = 'muted';
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
  // Never start by itself: a link someone else sent would make this device a copy of THEIR
  // identity, which they could then read along with.
  if (prefill) {
    status.className = 'small warn';
    status.textContent = '⚠ This link makes this device a copy of another device\'s identity. Continue only if you just created it yourself on your own device (Settings → Link a new device). If someone sent it to you, close this: to chat with them you need their contact link instead.';
  }
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
  const who = peers ? ` · ${peers} ${peers === 1 ? 'person' : 'people'} online` : '';
  const text = !online ? 'No internet' : r.connected ? 'Ready' + who : (r.total ? 'Connecting…' : 'Direct codes only' + who);
  const mail = r.mailbox && r.mailboxOpen ? ' · mailbox ✓' : '';
  pill.title = `${r.connected}/${r.total} relays connected`;
  pill.replaceChildren(h('span', { class: 'dot ' + cls }), text + mail);
  $('offlineNote').hidden = online;
}

function highlighted(text, words) {
  // Show the text around the first match, with matches marked (folding keeps lengths for most scripts).
  const fold = (t) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const f = fold(text);
  const at = words.length ? f.indexOf(words[0]) : -1;
  const start = at > 40 ? at - 30 : 0;
  const part = text.slice(start, start + 160);
  const prefix = start ? '…' : '';
  if (f.length !== text.length) return [prefix + part];
  const fp = f.slice(start, start + 160);
  const marks = [];
  for (const w of words) for (let i = fp.indexOf(w); i >= 0 && w; i = fp.indexOf(w, i + w.length)) marks.push([i, i + w.length]);
  marks.sort((a, b) => a[0] - b[0]);
  const out = [prefix];
  let pos = 0;
  for (const [a, b] of marks) {
    if (a < pos) continue;
    out.push(part.slice(pos, a), h('mark', { text: part.slice(a, b) }));
    pos = b;
  }
  out.push(part.slice(pos));
  return out;
}

function renderSearch() {
  const box = $('searchResults');
  const q = searchQuery.trim();
  $('convList').hidden = currentTab !== 'chats' || !!q;
  box.hidden = currentTab !== 'chats' || !q;
  if (!q) return;
  const words = q.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/\s+/).filter(Boolean);
  const results = engine.search(q);
  box.replaceChildren(...(results.length ? results.map(({ conv: id, msg }) => {
    const conv = engine.convs.get(id);
    const who = msg.author === engine.identity.fp ? 'You: ' : conv.kind === 'group' ? engine.displayName(msg.author) + ': ' : '';
    return h('li', { onclick: () => openConv(id, msg.id) },
      avatar(conv.kind === 'direct' ? conv.members.find((m) => m !== engine.identity.fp) : id.slice(2), engine.convTitle(conv)),
      h('div', { class: 'info' },
        h('div', { class: 'title' }, h('span', { text: engine.convTitle(conv) }), h('span', { class: 'muted small', text: fmtDay(msg.ts) })),
        h('div', { class: 'preview' }, who, ...highlighted(msg.text, words))));
  }) : [h('li', { class: 'empty' }, h('p', { text: 'No messages match.' }))]));
}

function renderLists() {
  $('myName').textContent = engine.identity.name;
  // Conversations
  const convs = engine.conversations();
  const list = $('convList');
  list.replaceChildren(...(convs.length ? convs.map(({ conv, title, last, unread }) => {
    const other = conv.kind === 'direct' ? conv.members.find((m) => m !== engine.identity.fp) : null;
    const online = other ? net.isOnline(other) : conv.members.some((m) => m !== engine.identity.fp && net.isOnline(m));
    const typingNow = typingText(conv.id, conv.kind === 'group');
    const preview = typingNow || (last ? (conv.kind === 'group' && last.author !== engine.identity.fp ? engine.displayName(last.author) + ': ' : (last.author === engine.identity.fp ? 'You: ' : '')) + filePreview(last) : (conv.kind === 'group' ? 'Group created' : 'No messages yet'));
    return h('li', { class: conv.id === currentConv ? 'active' : '', onclick: () => openConv(conv.id), dataset: { conv: conv.id } },
      avatar(other || conv.id.slice(2), title, online),
      h('div', { class: 'info' },
        h('div', { class: 'title' }, h('span', { text: title }), last ? h('span', { class: 'muted small', text: fmtTime(last.ts) }) : null),
        h('div', { class: 'row' }, h('div', { class: 'preview grow' + (typingNow ? ' typing' : ''), text: preview }), unread ? h('span', { class: 'badge', text: String(unread) }) : null)));
  }) : [h('li', { class: 'empty' }, h('p', { text: 'No chats yet. Like a walkie-talkie, you need someone on the other end: send them your link and you\'re connected as soon as they open it.' }), h('button', { class: 'primary', text: 'Invite someone', onclick: () => showAddContact() }), h('button', { class: 'link', text: 'Share my link', onclick: shareMyLink }))]));

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
        h('div', { class: 'preview', text: net.isOnline(c.fp) ? 'Online · ' + ROUTE_SHORT[net.route(c.fp)] : engine.seen[c.fp] ? 'Last seen ' + fmtAgo(engine.seen[c.fp]) : 'Offline' })))) : (reqs.length ? [] : [h('li', { class: 'empty' }, h('p', { text: 'No contacts yet.' }), h('button', { class: 'primary', text: 'Invite someone', onclick: () => showAddContact() }))])),
  );

  renderSearch();
  const totalUnread = convs.reduce((n, c) => n + c.unread, 0);
  document.title = (totalUnread ? `(${totalUnread}) ` : '') + 'Walkie-Talkie';
  navigator.setAppBadge?.(totalUnread).catch?.(() => {});
}

// How traffic reaches someone who is online: straight between the two devices, through a
// TURN server, or through the meeting-point relays (when no direct connection can form).
const ROUTE_TEXT = {
  direct: 'direct connection',
  turn: 'through a TURN server',
  relay: 'through a relay (photos and files wait for a direct connection)',
};
const ROUTE_SHORT = { direct: 'direct', turn: 'via TURN server', relay: 'via relay' };

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
  const typingNow = typingText(conv.id, conv.kind === 'group');
  $('chatSub').classList.toggle('typing', !!typingNow);
  if (typingNow) {
    $('chatSub').textContent = typingNow;
  } else if (conv.kind === 'direct') {
    const other = conv.members.find((m) => m !== me);
    $('chatSub').textContent = net.isOnline(other) ? '● Online now · ' + ROUTE_TEXT[net.route(other)] : (engine.seen[other]
      ? `Last seen ${fmtAgo(engine.seen[other])}` : 'Not online') + ' · messages are delivered when they open the app';
  } else {
    const on = conv.members.filter((m) => m !== me && net.isOnline(m)).length;
    $('chatSub').textContent = `${conv.members.length} people · ${on} online now`;
  }

  const box = $('messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const items = [];
  const between = conv.kind === 'group' ? 'the people in this group' : `you and ${engine.convTitle(conv)}`;
  items.push(h('div', { class: 'sysmsg' }, `🔒 Only ${between} can read these messages. They're kept on your devices, not on a server, and disappear after ${fmtRetention(engine.retentionDays(conv))}. `,
    h('button', { class: 'link small', text: 'How it works', onclick: showHowItWorks })));
  const strangers = conv.kind === 'group' && conv.trusted === false ? engine.groupStrangers(conv) : [];
  if (strangers.length) {
    const names = strangers.slice(0, 5).map((fp) => engine.displayName(fp)).join(', ') + (strangers.length > 5 ? ` and ${strangers.length - 5} more` : '');
    const convId = currentConv;
    items.push(h('div', { class: 'notice' },
      h('p', { text: `${engine.displayName(conv.createdBy)} added you to this group. ${strangers.length === 1 ? 'One member isn\'t' : strangers.length + ' members aren\'t'} in your contacts: ${names}. Messages reach you through the members you know. Connecting directly makes the group faster, and lets those members see when you're online and your network address.` }),
      h('div', { class: 'row end' },
        h('button', { class: 'danger', text: 'Leave group', onclick: async () => {
          if (!confirm('Leave this group? Its messages are deleted from your devices and you will receive no more of them.')) return;
          await engine.declineGroup(convId);
          if (currentConv === convId) currentConv = null;
          render();
        } }),
        h('button', { class: 'primary', text: 'Connect to all members', onclick: async () => { await engine.trustGroup(convId); render(); } }))));
  }
  for (const fp of engine.heldBack(currentConv)) {
    const convId = currentConv;
    const who = engine.displayName(fp);
    items.push(h('div', { class: 'notice' },
      h('p', { text: `${who} has sent an unusually large amount in this chat, so their newer messages are being held back to protect this device's storage. Other members may see messages you don't until you choose.` }),
      h('div', { class: 'row end' },
        conv.kind === 'group'
          ? h('button', { class: 'danger', text: 'Leave group', onclick: async () => {
            if (!confirm('Leave this group? Its messages are deleted from your devices and you will receive no more of them.')) return;
            await engine.declineGroup(convId);
            if (currentConv === convId) currentConv = null;
            render();
          } })
          : h('button', { class: 'danger', text: 'Remove contact', onclick: async () => {
            if (!confirm(`Remove ${who}? They will no longer be able to connect to you or message you unless you add them again.`)) return;
            await engine.removeContact(fp); engine.held.get(convId)?.delete(fp); render();
          } }),
        h('button', { text: 'Keep receiving', onclick: async () => { await engine.allowMore(convId, fp); net.resync(); render(); } }))));
  }
  let lastDay = '', lastAuthor = null;
  for (const m of view.list()) {
    const day = fmtDay(m.ts);
    if (day !== lastDay) { items.push(h('div', { class: 'day', text: day })); lastDay = day; lastAuthor = null; }
    const mine = m.author === me;
    const first = m.author !== lastAuthor;
    lastAuthor = m.author;
    const cls = 'msg' + (mine ? ' mine' : '') + (first ? ' first' : '') + (m.deleted ? ' deleted' : '') + (m.id === selectedMsg ? ' sel' : '');
    const convId = currentConv;
    items.push(h('div', { class: cls, dataset: { id: m.id }, onclick: (e) => {
      if (e.target.closest('button') || getSelection().toString()) return;
      selectedMsg = selectedMsg === m.id ? null : m.id;
      for (const el of box.querySelectorAll('.msg.sel')) el.classList.remove('sel');
      if (selectedMsg) e.currentTarget.classList.add('sel');
    } },
      first && !mine && conv.kind === 'group' ? h('div', { class: 'who', text: engine.displayName(m.author) }) : null,
      m.file ? attachmentNode(m) : null,
      m.deleted ? 'Message deleted' : m.text,
      h('span', { class: 'meta' }, fmtTime(m.ts), mine && !m.deleted ? tickFor(convId, m) : null),
      h('button', { class: 'more', title: 'Message options', 'aria-label': 'Message options', text: '⋯', onclick: () => showMessage(convId, m) })));
  }
  const tn = typingText(conv.id, conv.kind === 'group');
  if (tn) items.push(h('div', { class: 'typing-row', text: tn }));
  box.replaceChildren(...items);
  const target = renderChat.scrollTo && box.querySelector(`[data-id="${CSS.escape(renderChat.scrollTo)}"]`);
  if (target) {
    target.scrollIntoView({ block: 'center' });
    target.classList.add('flash');
    setTimeout(() => target.classList.remove('flash'), 2000);
  } else if (atBottom || renderChat.forceScroll) box.scrollTop = box.scrollHeight;
  renderChat.forceScroll = false;
  renderChat.scrollTo = null;
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

function openConv(id, scrollTo = null) {
  if (currentConv !== id) { stopTyping(); selectedMsg = null; }
  currentConv = id;
  renderChat.forceScroll = !scrollTo;
  renderChat.scrollTo = scrollTo;
  render();
  if (!scrollTo && matchMedia('(min-width: 761px)').matches) $('composerInput').focus();
}

// ------------------------------------------------------------------ typing

const TYPING_RESEND_MS = 3000;  // while typing, say so again this often…
const TYPING_SHOW_MS = 6000;    // …and the other side shows it for this long after the last one
let typingSent = null;          // {conv, at}

function onComposerInput() {
  if (!currentConv) return;
  if (!$('composerInput').value.trim()) return stopTyping();
  const now = Date.now();
  if (typingSent?.conv === currentConv && now - typingSent.at < TYPING_RESEND_MS) return;
  typingSent = { conv: currentConv, at: now };
  net.sendTyping(currentConv, true);
}

function stopTyping() {
  if (!typingSent) return;
  net.sendTyping(typingSent.conv, false);
  typingSent = null;
}

function onTyping({ fp, conv, on }) {
  let m = typing.get(conv);
  if (!m) { m = new Map(); typing.set(conv, m); }
  if (on) m.set(fp, Date.now() + TYPING_SHOW_MS); else m.delete(fp);
  scheduleRender();
  if (on) setTimeout(scheduleRender, TYPING_SHOW_MS + 100);
}

// ------------------------------------------------------------------ notifications

async function notify(conv, env, body) {
  if (!engine.settings.notifications || body.type !== 'msg') return;
  if (document.visibilityState === 'visible' && currentConv === conv) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const c = engine.convs.get(conv);
  const title = c.kind === 'group' ? `${engine.convTitle(c)} · ${engine.displayName(env.author)}` : engine.displayName(env.author);
  const reg = await navigator.serviceWorker?.getRegistration();
  const text = body.file ? (inlineKind(String(body.file.mime)) === 'image' ? '📷 Photo' : '📎 File') + (body.text ? ': ' + body.text : '') : body.text;
  const opts = { body: text.slice(0, 140), tag: conv, data: { conv }, icon: 'icons/icon-192.png' };
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
    ? 'Ready. Messages go straight to people who have the app open, encrypted. Public meeting points (relays) only help devices find each other.'
    : 'Can\'t reach the meeting points that help devices find each other. Check your connection, or use direct connection codes in Settings.', null, 7000);
  $('btnHow').onclick = showHowItWorks;
  $('btnBack').onclick = () => { stopTyping(); currentConv = null; render(); };
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
      $('contactList').hidden = currentTab !== 'contacts';
      $('searchBar').hidden = currentTab !== 'chats';
      renderSearch();
    };
  }
  $('search').addEventListener('input', (e) => { searchQuery = e.target.value; renderSearch(); });
  $('search').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.target.value = searchQuery = ''; renderSearch(); } });
  const input = $('composerInput');
  const resize = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, innerHeight * 0.3) + 'px'; };
  input.addEventListener('input', resize);
  input.addEventListener('input', onComposerInput);
  input.addEventListener('blur', stopTyping);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); }
  });
  $('composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value;
    if (!text.trim() || !currentConv) return;
    input.value = ''; resize();
    stopTyping();
    renderChat.forceScroll = true;
    await engine.sendText(currentConv, text);
  });
  $('btnAttach').onclick = () => $('fileInput').click();
  $('fileInput').addEventListener('change', (e) => { sendFiles([...e.target.files]); e.target.value = ''; });
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); sendFiles(files); }
  });
  const chat = $('chat');
  chat.addEventListener('dragover', (e) => { if (currentConv && e.dataTransfer?.types.includes('Files')) { e.preventDefault(); chat.classList.add('drop'); } });
  chat.addEventListener('dragleave', (e) => { if (!chat.contains(e.relatedTarget)) chat.classList.remove('drop'); });
  chat.addEventListener('drop', (e) => {
    chat.classList.remove('drop');
    if (!currentConv || !e.dataTransfer?.files.length) return;
    e.preventDefault();
    sendFiles([...e.dataTransfer.files]);
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
      const name = k.name || 'Someone';
      openDialog(`${name} invited you to chat`,
        h('div', { class: 'row' }, avatar(k.fp, k.name), h('div', {}, h('div', { class: 'strong', text: name }), h('div', { class: 'mono small', text: k.fp }))),
        h('p', { class: 'muted small', text: card.i
          ? `You'll be connected to ${name} straight away. You can chat whenever you're both online${card.m ? ', or leave messages in their mailbox' : ''}.`
          : `This is a bare contact card with no invite code, so ${name} won't hear from you until they add you too (or you share a group). Ask them for their contact link to connect straight away.` }),
        h('div', { class: 'row end' },
          h('button', { text: 'Not now', onclick: closeDialog }),
          h('button', { class: 'primary', text: `Add ${name}`, onclick: () => addContactFromText(code).catch((e) => toast(e.message)) })));
    } catch { toast('Invalid contact link'); }
  })();
}

async function startApp() {
  show('main');
  wireMain();
  net = new Network(engine);
  engine.addEventListener('op', (e) => {
    // A message arriving means they've stopped typing it.
    if (!e.detail.local && e.detail.body.type === 'msg') typing.get(e.detail.conv)?.delete(e.detail.env.author);
    scheduleRender();
    if (!e.detail.local) notify(e.detail.conv, e.detail.env, e.detail.body);
  });
  net.addEventListener('typing', (e) => onTyping(e.detail));
  // Download progress: refresh just that attachment (a full render on every chunk would be wasteful).
  net.files.addEventListener('progress', (e) => {
    const n = fileNodes.get(e.detail.id);
    const ref = engine.fileRef(e.detail.id);
    if (n && ref && n.el.isConnected) attachmentNode(ref.msg);
  });
  engine.addEventListener('file', scheduleRender);
  engine.addEventListener('change', (e) => {
    scheduleRender();
    if (e.detail.what === 'requests' && e.detail.fp) toast(`${engine.displayName(e.detail.fp)} wants to connect`, { label: 'View', run: () => document.querySelector('[data-tab=contacts]').click() });
  });
  engine.addEventListener('settings', scheduleRender);
  net.addEventListener('peers', (e) => {
    if (!e.detail.online) for (const m of typing.values()) m.delete(e.detail.fp);
    scheduleRender();
  });
  net.addEventListener('invited', async (e) => {
    const conv = await engine.directConv(e.detail.fp);
    toast(`${engine.displayName(e.detail.fp)} added you from your link`, { label: 'Say hi', run: () => openConv(conv.id) });
    notify(conv.id, { author: e.detail.fp }, { type: 'msg', text: 'Added you as a contact' });
  });
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
  // Debugging handle (also used by the e2e test): local development only.
  if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) window.__iwt = { engine, net };
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
    // Came here through someone's invite link: connect to them right away.
    const invite = /^#add=([A-Za-z0-9_-]+)/.exec(location.hash)?.[1];
    if (invite) history.replaceState(null, '', location.pathname + location.search);
    await startApp();
    if (invite) addContactFromText(invite).catch((err) => toast(err.message));
  };
  $('onboardRestore').onclick = showRestore;
  $('onboardHow').onclick = showHowItWorks;
  $('onboardLink').onclick = () => showLinkJoin();
  // Opened someone's contact link without an identity yet: say who invited them. The hash
  // stays in place and is handled once the identity exists.
  const inv = /^#add=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (inv) {
    try {
      const card = JSON.parse(fromUtf8(fromB64u(inv[1])));
      const name = (typeof card.n === 'string' && card.n.slice(0, 64)) || 'Someone';
      $('onboardInvite').textContent = `${name} invited you to chat. Choose a display name to get started. You'll be connected right after.`;
      $('onboardInvite').hidden = false;
    } catch {}
  }
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

// The page can't forbid framing through a meta CSP, so refuse to run inside someone else's frame.
if (window.top !== window.self) {
  document.body.replaceChildren(h('div', { class: 'center-screen muted', text: 'Walkie-Talkie does not run inside another page. Open it in its own tab.' }));
} else {
  acquireLock();
}
