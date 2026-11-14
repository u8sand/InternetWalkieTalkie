# Walkie-Talkie relay on Cloudflare (free)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/u8sand/InternetWalkieTalkie/tree/main/worker)

The same relay as the [Docker version](../relay/README.md), with nothing to host: it runs on
your own Cloudflare account, on the free plan.

- **Finding each other**: a meeting point where devices exchange (encrypted) connection offers.
- **Mailbox**: encrypted messages wait here while your app is closed, for up to 8 days.
- **Carrying connections** (optional): when two devices can't reach each other directly, the
  relay gives the app short-lived credentials for Cloudflare's TURN service.

The relay never sees message content, names or keys. It sees hashed topics, sizes, timing and
IP addresses, and so does Cloudflare.

## Deploy

1. Click **Deploy to Cloudflare** above and sign in (a free account is enough).
2. It asks for three optional values. You can leave them all empty and add them later:
   - `TURN_KEY_ID` and `TURN_KEY_API_TOKEN`: only needed for carrying connections. In the
     Cloudflare dashboard, open **Realtime → TURN Server → Create**; it shows a Token ID and an
     API token.
   - `ACCESS_CODE`: a code people must enter in the app before the relay hands out TURN access,
     because that traffic counts against your Cloudflare account.
3. When it finishes you get an address like `https://walkie-talkie-relay.<you>.workers.dev`.

In the app: **Settings → My relay**, enter it with `wss://` instead of `https://`, plus the access
code, and save. Give the same address and code to anyone you want to share it with.

## What it costs

Nothing for personal and small-group use. Cloudflare's free plan allows, per day, 100,000
Durable Object requests (incoming WebSocket messages count 20 to 1), 13,000 GB-seconds of
duration (idle connections hibernate and aren't charged) and 100,000 rows written; mailbox
storage is capped at 100 MB here. A chatty day for a handful of people is a few thousand
requests. If you go over a limit, requests fail until the next day (00:00 UTC); you are not
charged unless you move to a paid plan.

TURN is separate: Cloudflare's first 1,000 GB a month are free, then $0.05/GB. Only
connections that can't be made directly use it, and they carry everything, files included.
(Prices from Cloudflare's documentation as of November 2026.)

## Settings

Optional, in `wrangler.jsonc` under `vars`: `RELAY_NAME`, `MAIL_TTL_DAYS` (8), `MAX_STORED_MB`
(100), `TURN_TTL_HOURS` (12). Secrets can be changed later in the dashboard (**Workers →
walkie-talkie-relay → Settings → Variables and Secrets**) or with
`npx wrangler secret put TURN_KEY_ID`.

## Differences from the Docker relay

- It doesn't check events' Nostr signatures (Workers have no secp256k1). The app doesn't rely on
  them: they come from throwaway keys, and every payload is signed again inside its encryption.
- TURN comes from Cloudflare instead of a coturn server you run.

## Develop

```bash
npm install
npm test         # runs the Worker in Cloudflare's local runtime and checks it
npx wrangler dev # local relay at ws://127.0.0.1:8787
npx wrangler deploy
```
