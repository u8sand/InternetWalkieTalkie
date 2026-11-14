// Attachments.
//
// A file is sent as an ordinary 'msg' op whose body carries metadata:
//   file: {id, name, mime, size, key, thumb?, w?, h?}
// `key` is a random AES-256-GCM key for this file alone; it travels inside the op, so only
// conversation members ever get it. The file itself is split into CHUNK-byte pieces, each
// encrypted with that key under a nonce derived from its index and bound (as associated data)
// to the file id, index and chunk count, so pieces can't be swapped, reordered or truncated.
//
// Chunks are stored encrypted and fetched on demand over the peer DataChannel from any
// connected member (or own device) that has them, so files spread through a group the way
// ops do. A member serving garbage is caught by the GCM tag and simply asked no more.

import { b64u, fromB64u, utf8, randomBytes } from './encoding.js';

export const CHUNK = 64 * 1024;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_THUMB_CHARS = 16000;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const MIME_RE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i;
const THUMB_RE = /^data:image\/(jpeg|webp|png);base64,[A-Za-z0-9+/=]+$/;

export const chunkCount = (size) => Math.max(1, Math.ceil(size / CHUNK));

/** Inline-safe media types; everything else is only ever offered as a download. */
export function inlineKind(mime) {
  if (/^image\/(jpeg|png|webp|gif|avif)$/.test(mime)) return 'image';
  if (/^video\/(mp4|webm|ogg)$/.test(mime)) return 'video';
  if (/^audio\/(mpeg|mp4|ogg|webm|wav|aac|x-m4a|flac)$/.test(mime)) return 'audio';
  return null;
}

/** Validated copy of file metadata from a (decrypted, signed) op body, or null. */
export function cleanFileMeta(f) {
  if (!f || typeof f !== 'object') return null;
  if (!ID_RE.test(f.id) || !KEY_RE.test(f.key)) return null;
  if (!Number.isSafeInteger(f.size) || f.size < 1 || f.size > MAX_FILE_BYTES) return null;
  if (typeof f.mime !== 'string' || f.mime.length > 100 || !MIME_RE.test(f.mime)) return null;
  const name = typeof f.name === 'string' ? f.name.replace(/[\u0000-\u001f\u007f/\\]/g, '').slice(0, 200) : '';
  const out = { id: f.id, name: name || 'file', mime: f.mime.toLowerCase(), size: f.size, key: f.key };
  if (typeof f.thumb === 'string' && f.thumb.length <= MAX_THUMB_CHARS && THUMB_RE.test(f.thumb)) out.thumb = f.thumb;
  if (Number.isSafeInteger(f.w) && f.w > 0 && f.w < 100000) out.w = f.w;
  if (Number.isSafeInteger(f.h) && f.h > 0 && f.h < 100000) out.h = f.h;
  return out;
}

export const newFileId = () => b64u(randomBytes(16));
export const newFileKey = () => b64u(randomBytes(32));

export function importFileKey(key) {
  return crypto.subtle.importKey('raw', fromB64u(key), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function chunkParams(id, i, n) {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setUint32(8, i);
  return { name: 'AES-GCM', iv, additionalData: utf8(`iwt-file-v1|${id}|${i}|${n}`) };
}

export async function encryptChunk(key, id, i, n, bytes) {
  return new Uint8Array(await crypto.subtle.encrypt(chunkParams(id, i, n), key, bytes));
}

/** Throws if the chunk was tampered with or belongs elsewhere. */
export async function decryptChunk(key, id, i, n, ct) {
  return new Uint8Array(await crypto.subtle.decrypt(chunkParams(id, i, n), key, ct));
}
