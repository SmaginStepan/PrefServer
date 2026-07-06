# pref-server

Lobby and message-relay server for the Preferans multiplayer (Android app:
[PrefAndroid](https://github.com/SmaginStepan/PrefAndroid)).

The server knows nothing about Preferans. The **host's device runs the game
engine**; the server only:

- keeps a lobby of rooms (name, opaque rules JSON, 3 or 4 seats, optional password),
- seats players, lets the host kick players / add bots / start,
- blindly relays JSON messages between the host and each guest,
- reserves the seat of a disconnected player so they can rejoin,
- lets the host *reopen* a finished-for-today room under the same id to resume
  a saved game (the save lives on the host device).

## Protocol (WebSocket, path `/ws`, JSON messages)

Client → server: `hello {playerId, name}` · `list_rooms` ·
`create_room {name, rules, maxSeats, password?}` ·
`reopen_room {roomId, name, rules, maxSeats, password?, seats[]}` ·
`join {roomId, password?}` · `leave` · `kick {seat}` · `add_bot {seat?}` ·
`start` · `send {toSeat?, data}` (host addresses a seat; guests always reach the host)

Server → client: `welcome` · `rooms` · `room_created` · `room_state` ·
`joined` · `started` · `kicked` · `room_closed` · `host_msg {data}` ·
`player_msg {fromSeat, data}` · `error {code, message}`

`playerId` is a device-generated UUID and doubles as the reconnect token.
State is in-memory only — a server restart drops rooms, hosts simply reopen them.

## Run locally

    npm install
    npm run dev          # or: npm run build && npm start
    npm run smoke        # end-to-end test against the running server

Health check: `GET /health`.

## Deploy (VPS with Nginx, alongside agent-platform)

1. `docker compose up -d --build` — binds to `127.0.0.1:8090`.
2. Point the new domain's DNS at the VPS.
3. Copy `deploy/nginx-pref.conf` to `/etc/nginx/sites-available/`, edit the
   `server_name`, symlink to `sites-enabled`, `nginx -t && systemctl reload nginx`.
4. `certbot --nginx -d <domain>` for TLS.
5. Verify: `curl https://<domain>/health` and connect the smoke test with
   `node test/smoke.mjs wss://<domain>/ws`.
