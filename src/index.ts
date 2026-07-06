import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { clientMsg } from "./protocol.js";
import { handleMessage, onDisconnect, stats, type Session } from "./lobby.js";

const PORT = Number(process.env.PORT ?? 8090);

const app = express();
app.get("/health", (_req, res) => {
  res.json({ ok: true, ...stats() });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 64 * 1024 });

const sessions = new Map<WebSocket, Session>();

wss.on("connection", (ws) => {
  const session: Session = { ws, alive: true };
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

// drop dead connections so seats free up even without clean closes
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
wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`pref-server listening on :${PORT} (ws path /ws)`);
});
