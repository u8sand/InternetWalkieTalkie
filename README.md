# Internet Walkie-Talkie

A fully decentralized, end-to-end encrypted messenger that runs as a static
Progressive Web App on GitHub Pages.

- **No servers, no accounts.** Your identity is a key pair generated on your device.
- **Works from cache.** After the first visit, the service worker serves the whole app, so it
  still runs when GitHub Pages is unreachable.
- **CRDT sync.** Conversations are conflict-free replicated data types. Two devices merge their
  histories directly over WebRTC whenever both are online. Concurrent and offline edits
  always converge to the same history.
- **End-to-end encrypted.** Every update is encrypted to each recipient's public key and signed
  by its author. Relays, networks and even group members passing updates along can't read or
  forge anything.
- **Zero dependencies at runtime.** Plain ES modules and WebCrypto, with no build step and no
  CDN. The only vendored file is a small MIT QR-code encoder.

## Using it

1. Open the site and pick a display name.
2. **Add contact**: share your contact link or QR code, or paste someone else's. When they come
   online they get a contact request to accept.
3. Chat. The status pill shows how many relays you're connected to and how many peers are online.
   Messages you write while a contact is offline are stored locally and sync the next time you're
   both online.
4. **Groups**: any member who is online passes updates along to the others. So Bob and Carol can
   sync through Alice even if they never connect directly.
5. **Direct connection codes** (Settings): connect with no relay at all by swapping two codes
   (copy/paste or QR). This works on a local network with no internet.
6. **Safety number** (tap a contact): compare it with your contact in person to rule out a
   swapped link.
7. **Backup** (Settings): export an encrypted file (PBKDF2 + AES-GCM) to restore on another device.

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
- **Group membership is fixed at creation.** Adding or removing members isn't supported yet.
- **One device per identity.** Running a restored backup alongside the original device at the same
  time would reuse sequence numbers. Within one browser, a Web Lock lets only one tab run.
- **Equivocation.** A malicious member could sign two different ops with the same sequence number.
  Each replica keeps the first one it sees.
- **Both peers must be online at the same time**, unless another member of the conversation passes
  the updates along.
- **The app is only as trustworthy as the code you first load.** After that, the cached copy keeps
  running, and updates apply only when you accept the "new version" prompt.

## Development

```bash
npm install
npm test               # unit tests: crypto, CRDT convergence, forgery rejection, BIP-340 vectors
npm run test:e2e       # 3 Chromium users + local relay: relay/manual WebRTC, offline catch-up,
                       # group gossip, convergence, and running with the web server shut down
npm run serve          # http://localhost:8080 (undeployed builds use network-first caching)
```

The e2e test needs Playwright (`npm i -D playwright && npx playwright install chromium`).
`node test/relay.mjs` runs a local Nostr relay at `ws://127.0.0.1:7777` for manual testing. Set
`IWT_DEBUG = true` in the console for network logs.

## Deploying

1. Push to `main`.
2. In **Settings → Pages**, set **Source: GitHub Actions**.

The workflow runs the unit tests, stamps `sw.js` with the commit SHA (so each deploy gets a new
cache) and publishes `public/`. All paths are relative, so it works under
`https://<user>.github.io/<repo>/`.
