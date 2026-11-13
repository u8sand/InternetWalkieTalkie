# Internet Walkie-Talkie

A fully decentralized, end-to-end encrypted messenger that runs as a static
Progressive Web App on GitHub Pages.

- **No servers, no accounts.** Your identity is a key pair generated on your device.
- **Works from cache.** After the first visit, the service worker serves the whole app, so it
  still runs when GitHub Pages is unreachable.
- **CRDT sync.** Conversations are conflict-free replicated data types. Two devices merge their
  histories directly over WebRTC whenever both are online. Concurrent and offline edits
  always converge to the same history.
- **Bounded storage.** Messages expire after an agreed retention period (1 year for direct chats;
  chosen per group at creation). Every device deletes them, and history never grows without limit.
- **Optional mailbox on a relay you run.** Contacts can leave encrypted messages there while
  you're offline, and an installed app can collect them in the background.
- **End-to-end encrypted.** Every update is encrypted to each recipient's public key and signed
  by its author. Relays, networks and even group members passing updates along can't read or
  forge anything.
- **Zero dependencies at runtime.** Plain ES modules and WebCrypto, with no build step and no
  CDN. The only vendored file is a small MIT QR-code encoder.

## Using it

1. Open the site and pick a display name.
2. **Invite someone** (＋): share your link (Share / Copy invite message), or let them scan your QR
   code with their phone camera. Whoever opens it is connected to you straight away, with nothing
   to approve, even if they've never used the app (setup tells them who invited them). If you
   have a mailbox relay, this works even while you're offline. To add someone else, open their
   link or scan their code. Settings → **Reset my contact link** invalidates links you've shared;
   anyone using an old one only sends a contact request.
3. Chat. The status pill shows how many relays you're connected to and how many peers are online.
   Messages you write while a contact is offline are stored locally and sync the next time you're
   both online.
4. **Groups**: any member who is online passes updates along to the others. So Bob and Carol can
   sync through Alice even if they never connect directly.
5. **Direct connection codes** (Settings): connect with no relay at all by swapping two codes
   (copy/paste or QR). This works on a local network with no internet.
6. **Safety number** (tap a contact): compare it with your contact in person to rule out a
   swapped link.
7. **Your other devices** (Settings → Link a new device): scan the QR code with your phone's camera
   and it opens the app with your identity and full history. After that, your devices sync with
   each other (messages, contacts, nicknames, display name), and contacts reach whichever devices
   are online. You can also start on the new device from the welcome screen ("Link to my other
   device").
8. **Backup** (Settings): export an encrypted file (PBKDF2 + AES-GCM) to restore on another device.
9. **Mailbox relays** (Settings, optional): list up to four Nostr relays that *you* run or trust.
   Your contacts learn them over the encrypted channel or from your contact link. They post
   encrypted messages there for you when you're offline (kept at most 7 days). Your app collects
   them when it opens. As an installed Chromium app it also checks in the background and shows a
   notification with no message content.

## Architecture

```
public/
  index.html, css/, icons/, manifest.webmanifest
  sw.js                 precache + cache-first; stamped with the commit SHA on deploy
  js/app.js             UI (DOM built with textContent only; strict CSP, no inline code)
  js/core/
    encoding.js         base64url, canonical JSON, deflate packing
    crypto.js           identities, op sealing, signal sealing, channel auth, backups
    crdt.js             OpLog (version vectors) + ConversationView (materialised state)
    engine.js           contacts, conversations, validation/ingest, persistence
    store.js            IndexedDB (and in-memory store for tests)
    peer.js             WebRTC DataChannel, mutual authentication, sync protocol
    net.js              presence, connection setup, manual codes, gossip fan-out
    signaling.js        Nostr relay pool used only as a rendezvous
    schnorr.js          BIP-340 signatures so public relays accept our events
```

### CRDT

Each conversation is a **grow-only set of signed ops**. Merging two replicas is set union, which
is commutative, associative and idempotent. Each author numbers their ops 1, 2, 3, … per
conversation, so a replica's whole state fits in a version vector `{author: highest contiguous
seq}`.

The visible state is a pure function of the op set:

| Op       | Semantics |
|----------|-----------|
| `msg`    | Message; total order by `(lamport, author, seq)` |
| `del`    | Tombstone; only the author can delete their own message, and it applies in any arrival order |
| `group`  | Signed creation op (seq 1) fixing the member list; the ID commits to creator and nonce |
| `rename` | Last-writer-wins register on `(lamport, author)` |

#### Expiry (retention)

Every op's *signed header* carries its author's timestamp, which never decreases for a given
author. Each conversation has one agreed retention period:

- **Direct chats:** a protocol default of 365 days.
- **Groups:** `retentionDays` inside the signed, pinned group-creation op, so every member applies
  the same rule.

Pruning works like this:

- Each replica deletes ops older than the cutoff. For each author it keeps the newest expired op
  as a signed **watermark** and raises that author's *floor* to its seq. Because timestamps are
  monotonic, the watermark proves every earlier op from that author has expired.
- Version vectors count from the floor. Peers don't re-request or resend expired history, and the
  CRDT stays a correct set union (minus expired elements).
- A peer that was away longer than the retention period receives just the watermark and the live
  ops. It never gets the expired messages.
- `group` and `rename` ops are pinned and never expire, so membership and names survive.
- Ops stamped more than 24 hours in the future are rejected, so a skewed clock can't keep messages
  alive longer.

Per-user retention settings could be added later on top of this, e.g. a replica that keeps less
than the agreed period locally.

Sync over a DataChannel works like this:
1. Each side sends `{t:'sync', convs:{id: vv}}` for the conversations the other peer belongs to.
2. Each side replies with the ops the other is missing.
3. New ops go out live to every connected member, which gives store-and-forward gossip within a
   conversation.
4. A periodic re-sync covers anything missed.

### Cryptography (WebCrypto only)

- **Identity**: an ECDSA P-256 signing key plus an ECDH P-256 key-agreement key. The
  *fingerprint* is SHA-256 over both public keys and serves as the permanent user ID.
- **Ops**:
  - The body is encrypted with a random AES-256-GCM content key, with the op header bound as
    associated data.
  - Each op gets one ephemeral ECDH key. For each recipient, HKDF-SHA256 derives a key that wraps
    the content key.
  - The author signs the whole envelope with ECDSA.
  - Ops are stored encrypted, so plaintext lives only in memory.
- **Signals** (WebRTC offer/answer sent through relays): ECIES to the recipient. The sender's card,
  a timestamp and a nonce go *inside* the ciphertext and are signed. Stale signals and replays are
  dropped.
- **Channel authentication**: after the DataChannel opens, each side signs
  `nonce | own DTLS fingerprint | peer DTLS fingerprint`. This binds the WebRTC transport to the
  identity keys, so a man-in-the-middle on signalling can't relay the channel, whatever path the
  SDP took.

### Contact links and invites

A contact link (`#add=…`) carries your public card, your mailbox relays (if any), and a random
128-bit **invite token**. When someone adds you from it, their device presents the token in
its hellos, and in a mailed introduction if you have a mailbox. Your device then accepts them
without a request. The token travels inside the end-to-end-encrypted signal, so relays never
see it. Once you've connected, they stop presenting it. Resetting the link makes a new token,
shared across your own devices; old tokens fall back to an ordinary contact request.

### Multiple devices per identity

Every installation has a random **device id**, which is never copied. Ops are numbered per
*stream* = identity + device, and the signed header carries `dev`. A phone and a laptop
sharing one identity are therefore separate CRDT writers and never reuse a sequence number.
Contacts still see one person: same fingerprint, same signing key.

- **Connections are per device.** Relay signals carry the sender's device id and may target
  one (`toDev`). Each of your online devices connects to each of your contacts' online
  devices, and your own devices find each other through your own inbox topic.
- **Your own devices sync everything.** Between them, sync covers every conversation. They
  also exchange an address-book summary on each sync:
  - contacts are add-wins against removal timestamps;
  - nicknames and your display name are last-writer-wins.
- **Fan-out.** New ops go to every connected device of every member, including your own.

**Linking** (`js/core/link.js`):

1. The existing device makes a one-time 128-bit secret *S*. It shows `…#link=<code>` as a QR
   code; the code also carries the relay and STUN lists.
2. Both devices derive four things from *S*:
   - a relay topic;
   - a key encrypting the WebRTC offer/answer;
   - an HMAC key, used to prove knowledge of *S*, bound to both DTLS fingerprints;
   - a key encrypting the transferred state.
3. A man in the middle can neither find the rendezvous nor complete the proof.
4. The state goes over the DataChannel in encrypted 32 KB chunks. The new device imports it
   under its own device id.
5. The code works once and expires after 5 minutes.

Restoring a backup also creates a new device id, so a restored copy can run alongside the
original.

### Offline mail and background checks

Public relays only ever receive *ephemeral* events (kind 25050), which they forward but don't
store. Stored events (kind 4050, with a NIP-40 `expiration` 7 days out) go **only** to the
recipient's own mailbox relays. The recipient picks those relays and announces them over an
authenticated channel. They're never sent to the public relay list, and the e2e test asserts the
public relay saw nothing storable.

When you write to someone who isn't connected:

1. The op goes into a persistent outbox.
2. It's sealed to the recipient with the same ECIES-plus-signature scheme as signals.
3. It's posted to their mailbox relays and retried until a relay acknowledges it.
4. Direct sync clears the outbox entry if you connect first.

Only the author mails their own ops, and the recipient accepts mail only from known peers.

Background checks use **Periodic Background Sync** (installed Chromium PWAs only):

- The browser decides when, typically at most a few times a day depending on engagement. Apps
  can't agree on exact wake-up times.
- The service worker decrypts nothing. It copies still-encrypted events from your mailbox relays
  into IndexedDB and shows "You have new encrypted messages".
- The app verifies and merges them on next open.
- There's no Web Push: Google's and Apple's push services reject requests sent from a browser, so
  push would need a server.

### Signalling

WebRTC needs a way for peers to swap connection offers. By default the app uses public
**Nostr relays** as a dumb rendezvous:

- Events use an *ephemeral* kind, which relays forward but don't store.
- Each session signs with a throwaway Schnorr key.
- Each user listens on a daily inbox topic derived from their fingerprint.
- Event content is opaque ciphertext.

The end-to-end test checks that the relay never sees names, fingerprints, SDP or ICE data.

You can change the relays in Settings or remove them all. **Direct connection codes** need no
infrastructure at all. STUN servers are configurable too; add a TURN server for peers behind
symmetric NATs.

## Threat model and limitations

- **Relays and networks** see that *someone* posted an encrypted blob to an inbox topic, plus the
  timing and IP addresses. Anyone holding your contact card can work out your inbox topic. WebRTC
  reveals IP addresses to the peers you connect to.
- **Forward secrecy is partial.** Each op uses a fresh ephemeral key, but it's wrapped to the
  recipient's long-term ECDH key. If a device's keys are compromised, the history addressed to it
  can be decrypted. A double-ratchet layer would fix this.
- **Group membership and retention are fixed at creation.** Changing either isn't supported yet.
- **Expiry trusts authors' clocks.** An author whose clock runs slow makes their own messages
  expire early. Clocks more than a day fast are rejected.
- **Mailbox relays** you list can see when encrypted mail arrives for your inbox topic and how
  big it is. They can't see the sender, the content or your identity. Use relays you control.
- **Background checks** happen only in installed Chromium apps, on the browser's schedule.
- **Your contact link lets anyone who has it add you** without approval. That's the point of
  sharing it, but if it leaks, reset it.
- **A link code is as sensitive as your private key** for its 5-minute lifetime: anyone who opens
  it first gets your identity. Within one browser, a Web Lock lets only one tab run.
- **Device revocation isn't supported.** A lost device keeps the identity. The remedy is a new
  identity; key rotation is future work.
- **Equivocation.** A malicious member could sign two different ops with the same sequence number.
  Each replica keeps the first one it sees.
- **Both peers must be online at the same time**, unless another member passes the updates along
  or the recipient has a mailbox relay.
- **The app is only as trustworthy as the code you first load.** After that, the cached copy keeps
  running, and updates apply only when you accept the "new version" prompt.

## Development

```bash
npm install
npm test               # unit tests: crypto, CRDT convergence, expiry, multi-device streams and
                       # address-book merge, forgery rejection, BIP-340 vectors
npm run test:e2e       # 3 Chromium users, a "public" relay and a user-owned mailbox relay:
                       # relay/manual WebRTC, offline catch-up, mailbox delivery while never online
                       # together, a background Periodic Sync wake-up with notification, group
                       # gossip, linking an emulated phone from a QR link, phone and laptop chatting
                       # as one identity, convergence, and running with the web server shut down
npm run serve          # http://localhost:8080 (undeployed builds use network-first caching)
```

The e2e test needs Playwright (`npm i -D playwright && npx playwright install chromium`). It uses
Chromium's full headless mode (`channel: 'chromium'`), because the headless shell can't show
notifications.
`node test/relay.mjs` runs a local Nostr relay at `ws://127.0.0.1:7777` for manual testing. Set
`IWT_DEBUG = true` in the console for network logs.

## Deploying

1. Push to `main`.
2. In **Settings → Pages**, set **Source: GitHub Actions**.

The workflow runs the unit tests, stamps `sw.js` with the commit SHA (so each deploy gets a new
cache) and publishes `public/`. All paths are relative, so it works under
`https://<user>.github.io/<repo>/`.
