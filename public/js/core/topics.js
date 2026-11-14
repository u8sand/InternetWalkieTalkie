// Relay rendezvous topics.
//
// A topic is only a routing label: which relay subscription an (encrypted) event reaches.
// It must not identify anyone, so none is derived from a fingerprint alone.
//
//  * Pair topics come from the static ECDH secret two identities share. Only those two can
//    compute them, so holding someone's contact card doesn't let you find, watch or post to
//    the topics they use with other people. Our own devices use the pair "me with me".
//  * Intro topics come from the invite token in a contact link. They are how someone who has
//    our link, but whom we don't know yet, reaches us; resetting the link retires them.
//
// Live (signalling) topics change every UTC day, so a relay can't follow a pair for long.
// Mail topics are fixed: they only ever go to the recipient's own mailbox relays.

import { hex, sha256, utf8, concat } from './encoding.js';

export const utcDay = (t = Date.now()) => Math.floor(t / 86400000);

const topic = async (...parts) => hex(await sha256(concat(...parts.map((p) => (typeof p === 'string' ? utf8(p) : p))))).slice(0, 32);

/** @param key 32-byte pair key (crypto.pairKey) */
export const liveTopic = (key, day = utcDay()) => topic('iwt-topic-v2|live|', key, '|' + day);
export const mailTopic = (key) => topic('iwt-topic-v2|mail|', key);

/** @param owner fingerprint of the person whose link carries `token` */
export const introTopic = (owner, token, day = utcDay()) => topic('iwt-topic-v2|intro|' + owner + '|' + token + '|' + day);
export const introMailTopic = (owner, token) => topic('iwt-topic-v2|intro-mail|' + owner + '|' + token);
