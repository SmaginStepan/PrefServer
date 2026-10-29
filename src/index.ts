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
  <p class="meta">Last updated: October 2026</p>

  <p>This policy covers the <strong>Preferans Master</strong> app for Android by aN0obIs ("the app")
     and the two online services it can connect to: the multiplayer relay at
     <code>preferansmaster.com</code> and the leaderboard service at
     <code>scores.preferansmaster.com</code>. The game itself is played offline on your device;
     the online features are optional.</p>

  <h2>Stored on Your Device Only</h2>
  <ul>
    <li>Saved games, score sheets, settings and statistics.</li>
    <li>A counter of finished deals, whether you have rated the app, and whether you have
        removed ads. These are never sent to us.</li>
  </ul>

  <h2>Multiplayer</h2>
  <p>Multiplayer rooms use a relay server. The host device runs the game engine; the server only
     forwards opaque messages between devices. It processes:</p>
  <ul>
    <li><strong>Player ID</strong> — a random UUID generated on your device. It is not linked to
        your real identity, email, or any account.</li>
    <li><strong>Display name</strong> — the name you choose. Visible to players in the same room.</li>
    <li><strong>Room name</strong> and, if the host sets one, a <strong>SHA-256 hash</strong> of the
        room password. The plaintext password is never retained.</li>
    <li><strong>Room and seat state</strong> and <strong>relayed game moves</strong> — the server
        does not interpret or log the content of game messages.</li>
  </ul>
  <p>All room and player state is held in memory only and is never written to disk. It is removed
     when a room closes, after 2 hours of idleness for an open room, after 24 hours of idleness for
     a playing room, or when the server restarts.</p>

  <h2>Leaderboards and Seasons</h2>
  <p>If you finish a single-player pool or play a monthly season, the app sends the following to
     the leaderboard service so that rankings can be shown:</p>
  <ul>
    <li>your random <strong>Player ID</strong> (the same UUID as above);</li>
    <li>the <strong>display name</strong> you set in the app;</li>
    <li>the <strong>score</strong> and the time it was achieved on the device.</li>
  </ul>
  <p>Your name and score are shown to other players on the leaderboard. To detect cheating, the
     service also records the time of every submission and the <strong>IP address</strong> it came
     from; this log is kept for as long as it is needed for that purpose and is not shown to
     anyone. Seasons use a published seed so that every player gets the same deals; the seed
     contains no personal data.</p>
  <p>You can ask us to delete your leaderboard entries (see Contact below). Send us the name you
     played under.</p>

  <h2>Advertising</h2>
  <p>The free version shows a full-screen advertisement after some finished single-player deals
     (never during the first deals, and never in the middle of a hand). Ads are provided by
     <strong>Google AdMob</strong>. To show and measure ads, Google may collect and process your
     device's <strong>advertising ID</strong>, IP address, approximate location derived from the IP
     address, and information about the device and about how you interact with ads. We do not
     receive this data and do not use it ourselves.</p>
  <ul>
    <li>If you are in the European Economic Area, the United Kingdom or another region that requires
        it, the app first shows a consent form (Google's User Messaging Platform). You can change
        your choice later through the app's privacy options where offered, or by resetting or
        deleting your advertising ID in Android Settings.</li>
    <li>You can turn off ad personalisation in Android Settings → Google → Ads.</li>
    <li>More about how Google uses data from apps that use its services:
        <a href="https://policies.google.com/technologies/partner-sites">policies.google.com/technologies/partner-sites</a>.</li>
  </ul>

  <h2>Removing Ads (In-App Purchase)</h2>
  <p>The one-time "Remove ads" purchase is processed entirely by <strong>Google Play</strong>. We
     never see your payment details. The app only asks Google Play whether you own the product and
     remembers the result on your device so ads stay off.</p>

  <h2>What We Do Not Collect</h2>
  <ul>
    <li>No email addresses, accounts or passwords.</li>
    <li>No contacts, photos, files or precise location.</li>
    <li>No analytics or behavioural-tracking SDK of our own. The only third-party SDKs that process
        data are Google AdMob (ads) and Google Play Billing (purchases), described above.</li>
  </ul>

  <h2>Security</h2>
  <p>All connections to our servers use TLS (WSS / HTTPS). Leaderboard submissions are signed, and
     room passwords are hashed before being held in memory.</p>

  <h2>Children</h2>
  <p>The app is not directed at children under 13, and we do not knowingly collect personal
     information from them. The only personal data we process is a device-generated UUID and a
     freely chosen display name.</p>

  <h2>Changes</h2>
  <p>If we change how data is handled, we will update this page and its "Last updated" date.</p>

  <h2>Contact &amp; Support</h2>
  <p>Questions, deletion requests, bug reports, or support:<br>
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
