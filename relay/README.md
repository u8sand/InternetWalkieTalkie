# Run your own Walkie-Talkie relay

One small stack that gives the app everything a server can help with, for you and the people
you share it with:

- **Finding each other**: a meeting point where devices exchange (encrypted) connection offers.
- **Mailbox**: encrypted messages wait here while your app is closed, for up to 8 days.
- **Carrying connections**: when two devices can't reach each other directly (strict routers,
  mobile networks), their connection goes through this machine instead of failing.

The relay never sees message content, names or keys. It sees hashed topics, sizes, timing and
IP addresses.

It runs on a **Raspberry Pi** (any model, 32- or 64-bit OS) as well as on any ordinary server.

## What you need

- Docker with the Compose plugin. On a Pi: `curl -fsSL https://get.docker.com | sh`
- A DNS name pointing at the machine, for example `relay.example.org`. At home, that is your
  router's public address (use a dynamic-DNS name if it changes).
- These ports reachable from the internet. At home, forward them on your router to the Pi:

  | Port | Protocol | For |
  |---|---|---|
  | 443 (and 80 for the certificate) | TCP | The relay itself, over HTTPS |
  | 3478 | UDP and TCP | TURN |
  | 49160–49200 | UDP | Connections carried by TURN |

## Set it up

```bash
git clone https://github.com/u8sand/InternetWalkieTalkie
cd InternetWalkieTalkie/relay
cp .env.example .env
# edit .env: RELAY_HOST, TURN_SECRET (openssl rand -hex 32), ACCESS_CODE
```

Then start it one of two ways:

```bash
# You have no web server on this machine: the bundled Caddy gets an HTTPS certificate itself.
docker compose --profile https up -d

# You already run a reverse proxy (Traefik, nginx, Caddy): start without it and point your
# proxy at port 7777. It must pass WebSocket upgrades through.
docker compose up -d
```

The first start builds the relay image on the machine, which takes a few minutes on a Pi.

Check it: open `https://relay.example.org/` in a browser. It should say "Walkie-Talkie relay".

## Use it

In the app: **Settings → My relay**, enter `wss://relay.example.org` and the access code, then
save. Settings shows whether the relay answered. Give the same address and code to anyone you
want to share it with.

Your contacts don't need to configure anything to leave you mailbox messages: the app tells
them where your mailbox is.

## Notes

- **Access code**: protects only the connection-carrying (TURN) part, because that uses your
  bandwidth. Leave `ACCESS_CODE` empty to let anyone who knows the address use it. The meeting
  point and mailbox are open by design; they only accept Walkie-Talkie's two encrypted event
  kinds, with size, rate and storage limits.
- **Bandwidth**: a carried connection passes all its traffic, files included, through this
  machine. The defaults cap each connection at 1.5 Mbit/s and 100 connections in total. Adjust
  `--max-bps` and `--total-quota` in `docker-compose.yml`.
- **Two devices at home**: if both are on the same network as the Pi, they reach the relay by
  its public name. Most routers allow that; if yours doesn't, add a local DNS entry on the
  router that points the name at the Pi's local address.
- **Storage**: mailbox mail is kept in the `relay-data` volume, capped at 100 MB
  (`MAX_STORED_MB`), oldest dropped first.
- **Updating**: `git pull && docker compose up -d --build`.
- **Logs**: `docker compose logs -f relay turn`.

## Without Docker

The relay is one file with two pure-JavaScript dependencies:

```bash
npm ci --omit=dev
RELAY_HOST=relay.example.org TURN_SECRET=... ACCESS_CODE=... DATA_DIR=./data node server.mjs
```

Run [coturn](https://github.com/coturn/coturn) next to it with `--use-auth-secret` and the same
secret as `--static-auth-secret`.
