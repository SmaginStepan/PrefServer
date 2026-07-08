import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { clientMsg } from "./protocol.js";
import {
  handleMessage,
  onDisconnect,
  stats,
  cleanupStaleRooms,
  type Session,
} from "./lobby.js";

const PORT = Number(process.env.PORT ?? 8090);

const PRIVACY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Privacy Policy – Preferans Master</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
           max-width: 680px; margin: 48px auto; padding: 0 24px; color: #1a1a1a; line-height: 1.7; }
    h1 { font-size: 1.8rem; }
    h2 { font-size: 1.1rem; margin-top: 2em; }
    p, ul { color: #333; }
    a { color: #007aff; }
    .meta { color: #888; font-size: 0.875rem; }
  </style>
</head>
<body>
  <h1>Privacy Policy</h1>
  <p class="meta">Last updated: July 2026</p>

  <h2>What This Server Does</h2>
  <p>Preferans Master is a real-time multiplayer relay server for the card game Preferans.
     It matches players in game rooms and relays game moves between devices.
     The host device runs the game engine; the server only forwards opaque messages.</p>

  <h2>Data We Process</h2>
  <ul>
    <li><strong>Player ID</strong> — a UUID generated on your device. It is never linked to
        your real identity, email, or any account.</li>
    <li><strong>Display name</strong> — the name you choose when you join a room (e.g. "Alice").
        Visible only to players in the same room.</li>
    <li><strong>Room name</strong> — the name the host gives to a game room.</li>
    <li><strong>Room password hash</strong> — if you protect a room with a password, only a
        SHA-256 hash is held in memory. The plaintext password is never retained.</li>
    <li><strong>Room and seat state</strong> — who is in which seat, connection status, and
        opaque game rules set by the host.</li>
    <li><strong>Relayed game moves</strong> — opaque JSON messages forwarded between host and
        guests. The server does not interpret or log the content of these messages.</li>
  </ul>

  <h2>Data We Do Not Collect</h2>
  <p>We do not collect, store, or process:</p>
  <ul>
    <li>Email addresses or user accounts</li>
    <li>Device identifiers, IMEI, or advertising IDs</li>
    <li>Location data</li>
    <li>Contacts or address books</li>
    <li>Payment information</li>
    <li>Analytics or behavioural tracking data</li>
  </ul>
  <p>We do not use third-party analytics, advertising SDKs, or data brokers of any kind.</p>

  <h2>Data Retention</h2>
  <p>All room and player state is held in memory only and is never written to disk or a database.
     It is automatically removed when:</p>
  <ul>
    <li>A room is closed (host leaves or game ends).</li>
    <li>An open room has been idle for more than 2 hours.</li>
    <li>A playing room has been idle for more than 24 hours.</li>
    <li>The server restarts (memory is cleared).</li>
  </ul>

  <h2>Security</h2>
  <p>All connections use TLS (WSS / HTTPS). Room passwords are hashed with SHA-256 before
     being held in memory and are never transmitted back to clients.</p>

  <h2>Children</h2>
  <p>We do not knowingly collect any information from children under 13.
     The only personal data processed is a device-generated UUID and a freely chosen display name.</p>

  <h2>Contact &amp; Support</h2>
  <p>Questions, bug reports, or support requests:<br>
     <a href="mailto:smagines@gmail.com">smagines@gmail.com</a></p>
</body>
</html>`;

const SUPPORT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Support – Preferans Master</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
           max-width: 600px; margin: 60px auto; padding: 0 24px; color: #1a1a1a; line-height: 1.6; }
    h1 { font-size: 1.8rem; margin-bottom: 8px; }
    p { color: #444; }
    a { color: #007aff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .card { margin-top: 32px; padding: 20px 24px; background: #f5f5f7; border-radius: 12px; }
    .fine { margin-top: 32px; font-size: 0.875rem; color: #888; }
  </style>
</head>
<body>
  <h1>Preferans Master Support</h1>
  <p>Have a question, found a bug, or need help with the app? We're here to help.</p>
  <div class="card">
    <p style="margin:0">Send your question to:<br>
      <strong><a href="mailto:smagines@gmail.com">smagines@gmail.com</a></strong>
    </p>
  </div>
  <p class="fine">We typically respond within 1–2 business days.</p>
  <p class="fine"><a href="/privacy">Privacy Policy</a></p>
</body>
</html>`;

const app = express();

app.get("/health", (_req, res) => {
  res.json({ ok: true, ...stats() });
});

app.get("/privacy", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(PRIVACY_HTML);
});

app.get("/support", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(SUPPORT_HTML);
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 64 * 1024 });

const sessions = new Map<WebSocket, Session>();

wss.on("connection", (ws) => {
  const session: Session = {
    ws,
    alive: true,
    roomCreations: [],
    msgCount: 0,
    msgWindowStart: Date.now(),
  };
  sessions.set(ws, session);

  ws.on("pong", () => {
    session.alive = true;
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = clientMsg.parse(JSON.parse(raw.toString()));
    } catch {
      ws.send(
        JSON.stringify({ type: "error", code: "bad_message", message: "Malformed message" })
      );
      return;
    }
    try {
      handleMessage(session, msg);
    } catch (e) {
      console.error("handler error", e);
      ws.send(
        JSON.stringify({ type: "error", code: "internal", message: "Internal error" })
      );
    }
  });

  ws.on("close", () => {
    sessions.delete(ws);
    onDisconnect(session);
  });
});

// Drop dead connections so seats free up even without clean closes
const heartbeat = setInterval(() => {
  for (const [ws, session] of sessions) {
    if (!session.alive) {
      ws.terminate();
      continue;
    }
    session.alive = false;
    ws.ping();
  }
}, 30_000);

// Remove rooms that have been idle too long
const staleCleanup = setInterval(() => {
  const closed = cleanupStaleRooms();
  if (closed > 0) console.log(`[cleanup] removed ${closed} stale room(s)`);
}, 10 * 60 * 1000);

wss.on("close", () => {
  clearInterval(heartbeat);
  clearInterval(staleCleanup);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`pref-server listening on :${PORT} (ws path /ws)`);
});
