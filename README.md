# Preferans Master — Relay Server

Real-time lobby and relay server for the Preferans card game
([PrefAndroid](https://github.com/SmaginStepan/PrefAndroid)).  
Live: `wss://preferansmaster.com/ws`

The server knows nothing about Preferans. The **host device runs the game engine**; the
server only matches players in rooms and relays opaque JSON between them.

---

## What the server does (and doesn't do)

- Keeps an in-memory lobby of rooms (name, opaque rules JSON, 3–4 seats, optional password).
- Seats players, lets the host add bots / kick / start the game.
- Blindly relays JSON moves between host and guests — content is never interpreted or logged.
- Reserves the seat of a disconnected player so they can rejoin mid-game.
- Lets the host *reopen* a finished room under the same ID to resume a saved game (the save lives on the host device).
- Does **not** persist anything to disk, run game logic, or collect personal data.

---

## Data processed

| Data | Purpose | Retention |
|---|---|---|
| Device-generated player UUID (8–64 chars) | Identify connections; reserve seats on reconnect | Memory only; cleared when room closes or server restarts |
| Display name (max 24 chars) | Shown to other players in the same room | Same |
| Room name (max 32 chars) | Lobby listing | Same |
| SHA-256 hash of room password | Verify joining players | Same — plaintext is never stored |
| Opaque room rules JSON | Passed through to clients unchanged | Same |
| Opaque relay move JSON | Forwarded to target seat immediately | Never stored — forwarded and discarded |

**Not collected:** email, real name, device ID, location, contacts, payment info, advertising or tracking data.

---

## HTTP endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | `{"ok":true,"rooms":<n>,"players":<n>}` |
| `GET` | `/privacy` | Privacy policy HTML — required by App Store / Google Play |
| `GET` | `/support` | Support contact page HTML |
| `WS`  | `/ws`     | WebSocket lobby + relay |

---

## Retention policy

- **Open rooms** (waiting for players): closed after **2 hours of inactivity**.
- **Playing rooms**: closed after **24 hours of inactivity**, or immediately if all human players disconnect.
- **Server restart**: memory is cleared; hosts simply reopen their rooms.

When the server closes a stale room, all connected clients receive `room_closed`.

---

## Rate limits (server-side, per connection)

| Action | Limit |
|---|---|
| Create / reopen room | 5 per hour |
| Relay messages (`send`) | 60 per second |

Exceeded limits return `{"type":"error","code":"rate_limited","message":"..."}`.

---

## WebSocket protocol

All messages are JSON objects. Clients send:

```
hello        { playerId, name }
list_rooms   {}
create_room  { name, rules, maxSeats, password? }
reopen_room  { roomId, name, rules, maxSeats, password?, seats[] }
join         { roomId, password? }
leave        {}
kick         { seat }
add_bot      { seat? }
start        {}
send         { toSeat?, data }   ← host targets a seat; guests always send to host
```

Server replies:

```
welcome      {}
rooms        { rooms[] }
room_created { roomId }
room_state   { room }
joined       { roomId, seat }
left         {}
kicked       { roomId }
started      {}
host_msg     { data }
player_msg   { fromSeat, data }
room_closed  { roomId, reason }
error        { code, message }
```

`rules` and `data` are opaque — the server passes them through unchanged.

---

## Run locally

```bash
npm install
npm run dev          # ts-node-dev with auto-reload
# or:
npm run build && npm start
```

Requires Node 20+.

---

## Deploy (VPS + Nginx + Docker Compose)

```bash
# 1. Clone and start
git clone https://github.com/SmaginStepan/PrefServer ~/PrefServer
cd ~/PrefServer
docker compose up -d --build
curl http://127.0.0.1:8090/health   # {"ok":true,"rooms":0,"players":0}

# 2. Nginx — copy template, set server_name, enable, reload
sudo cp deploy/nginx-pref.conf /etc/nginx/sites-available/pref
# edit server_name in the file, then:
sudo ln -s /etc/nginx/sites-available/pref /etc/nginx/sites-enabled/pref
sudo nginx -t && sudo systemctl reload nginx

# 3. TLS
sudo certbot --nginx -d preferansmaster.com

# 4. Verify
curl https://preferansmaster.com/health
echo | openssl s_client -connect preferansmaster.com:443 \
  -servername preferansmaster.com | openssl x509 -noout -subject
```

The Nginx block in `deploy/nginx-pref.conf` already includes WebSocket `Upgrade`/`Connection`
headers and 1-hour `proxy_read_timeout` / `proxy_send_timeout` for idle game connections.

### Restart on reboot

`restart: unless-stopped` is set in `docker-compose.yml`.  
Verify Docker starts on boot: `sudo systemctl is-enabled docker` → `enabled`.

---

## Smoke test

Runs an end-to-end flow — room creation, lobby, passwords, bots, relay, reconnect, resume, and
rate limiting — against a live server:

```bash
npm run smoke                                        # local (ws://127.0.0.1:8090/ws)
npm run smoke -- wss://preferansmaster.com/ws       # production
```

All 17 checks must pass.
