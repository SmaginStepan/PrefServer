import type { WebSocket } from "ws";
import { createHash } from "node:crypto";
import type { ClientMsg } from "./protocol.js";

export interface Session {
  ws: WebSocket;
  alive: boolean;
  playerId?: string;
  name?: string;
  roomId?: string;
  seat?: number;
}

interface Seat {
  playerId?: string;
  name: string;
  kind: "human" | "bot";
  connected: boolean;
}

interface Room {
  id: string;
  name: string;
  rules: unknown;
  maxSeats: 3 | 4;
  passwordHash?: string;
  phase: "open" | "playing";
  seats: (Seat | null)[];
  createdAt: number;
}

const MAX_ROOMS = 200;

const rooms = new Map<string, Room>();
const byPlayerId = new Map<string, Session>();

function hash(password: string): string {
  return createHash("sha256").update(password).digest("hex");
}

function newRoomId(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (;;) {
    let id = "";
    for (let i = 0; i < 6; i++)
      id += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (!rooms.has(id)) return id;
  }
}

function send(session: Session, msg: unknown) {
  if (session.ws.readyState === session.ws.OPEN)
    session.ws.send(JSON.stringify(msg));
}

function error(session: Session, code: string, message: string) {
  send(session, { type: "error", code, message });
}

function publicRoom(room: Room) {
  return {
    id: room.id,
    name: room.name,
    rules: room.rules,
    maxSeats: room.maxSeats,
    phase: room.phase,
    hasPassword: !!room.passwordHash,
    hostName: room.seats[0]?.name ?? "",
    seats: room.seats.map((s) =>
      s ? { name: s.name, kind: s.kind, connected: s.connected } : null
    ),
  };
}

function broadcastRoom(room: Room) {
  const msg = { type: "room_state", room: publicRoom(room) };
  for (const seat of room.seats) {
    if (seat?.playerId) {
      const s = byPlayerId.get(seat.playerId);
      if (s && s.roomId === room.id) send(s, msg);
    }
  }
}

function hostSession(room: Room): Session | undefined {
  const host = room.seats[0];
  if (!host?.playerId) return undefined;
  const s = byPlayerId.get(host.playerId);
  return s && s.roomId === room.id ? s : undefined;
}

function closeRoom(room: Room, reason: string) {
  const msg = { type: "room_closed", roomId: room.id, reason };
  for (const seat of room.seats) {
    if (seat?.playerId) {
      const s = byPlayerId.get(seat.playerId);
      if (s && s.roomId === room.id) {
        send(s, msg);
        s.roomId = undefined;
        s.seat = undefined;
      }
    }
  }
  rooms.delete(room.id);
}

function leaveRoom(session: Session, disconnected: boolean) {
  const room = session.roomId ? rooms.get(session.roomId) : undefined;
  session.roomId = undefined;
  const seatNo = session.seat;
  session.seat = undefined;
  if (!room || seatNo === undefined) return;

  if (seatNo === 0) {
    // Host gone: the room cannot continue (the host runs the game). The host
    // can reopen the room later to resume.
    closeRoom(room, disconnected ? "host_disconnected" : "host_left");
    return;
  }
  const seat = room.seats[seatNo];
  if (seat) {
    if (room.phase === "playing") {
      // keep the seat reserved so the player can rejoin
      seat.connected = false;
    } else {
      room.seats[seatNo] = null;
    }
  }
  broadcastRoom(room);
}

export function onDisconnect(session: Session) {
  if (session.playerId && byPlayerId.get(session.playerId) === session)
    byPlayerId.delete(session.playerId);
  leaveRoom(session, true);
}

export function handleMessage(session: Session, msg: ClientMsg) {
  if (msg.type === "hello") {
    const existing = byPlayerId.get(msg.playerId);
    if (existing && existing !== session) {
      // a newer connection for the same player replaces the old one
      error(existing, "replaced", "Connected from another device");
      existing.ws.close();
      // inherit the room binding so a quick reconnect keeps the seat
      session.roomId = existing.roomId;
      session.seat = existing.seat;
      existing.roomId = undefined;
      existing.seat = undefined;
    }
    session.playerId = msg.playerId;
    session.name = msg.name;
    byPlayerId.set(msg.playerId, session);
    const room = session.roomId ? rooms.get(session.roomId) : undefined;
    if (room && session.seat !== undefined) {
      const seat = room.seats[session.seat];
      if (seat) seat.connected = true;
      broadcastRoom(room);
    }
    send(session, { type: "welcome" });
    return;
  }

  if (!session.playerId || !session.name) {
    error(session, "no_hello", "Say hello first");
    return;
  }

  switch (msg.type) {
    case "list_rooms": {
      send(session, {
        type: "rooms",
        rooms: [...rooms.values()].map(publicRoom),
      });
      return;
    }

    case "create_room":
    case "reopen_room": {
      if (session.roomId) {
        error(session, "in_room", "Already in a room");
        return;
      }
      if (rooms.size >= MAX_ROOMS) {
        error(session, "server_full", "Too many rooms");
        return;
      }
      let id: string;
      let seats: (Seat | null)[];
      if (msg.type === "reopen_room") {
        if (rooms.has(msg.roomId)) {
          error(session, "room_exists", "Room id already in use");
          return;
        }
        id = msg.roomId;
        seats = new Array(msg.maxSeats).fill(null);
        for (let i = 0; i < Math.min(msg.seats.length, msg.maxSeats); i++) {
          const s = msg.seats[i];
          if (s)
            seats[i] = {
              playerId: s.playerId,
              name: s.name,
              kind: s.kind,
              connected: s.kind === "bot",
            };
        }
      } else {
        id = newRoomId();
        seats = new Array(msg.maxSeats).fill(null);
      }
      // seat 0 is always the (current) host
      seats[0] = {
        playerId: session.playerId,
        name: session.name,
        kind: "human",
        connected: true,
      };
      const room: Room = {
        id,
        name: msg.name,
        rules: msg.rules,
        maxSeats: msg.maxSeats,
        passwordHash: msg.password ? hash(msg.password) : undefined,
        phase: "open",
        seats,
        createdAt: Date.now(),
      };
      rooms.set(id, room);
      session.roomId = id;
      session.seat = 0;
      send(session, { type: "room_created", roomId: id });
      broadcastRoom(room);
      return;
    }

    case "join": {
      if (session.roomId) {
        error(session, "in_room", "Already in a room");
        return;
      }
      const room = rooms.get(msg.roomId);
      if (!room) {
        error(session, "no_room", "Room not found");
        return;
      }
      // reclaiming a reserved seat skips the password (the player was invited)
      let seatNo = room.seats.findIndex(
        (s) => s?.kind === "human" && s.playerId === session.playerId
      );
      if (seatNo < 0) {
        if (room.passwordHash && hash(msg.password ?? "") !== room.passwordHash) {
          error(session, "bad_password", "Wrong password");
          return;
        }
        if (room.phase !== "open") {
          error(session, "playing", "Game already started");
          return;
        }
        seatNo = room.seats.findIndex((s) => s === null);
        if (seatNo < 0) {
          error(session, "room_full", "Room is full");
          return;
        }
        room.seats[seatNo] = {
          playerId: session.playerId,
          name: session.name,
          kind: "human",
          connected: true,
        };
      } else {
        const seat = room.seats[seatNo]!;
        seat.connected = true;
        seat.name = session.name;
      }
      session.roomId = room.id;
      session.seat = seatNo;
      send(session, { type: "joined", roomId: room.id, seat: seatNo });
      broadcastRoom(room);
      return;
    }

    case "leave": {
      leaveRoom(session, false);
      return;
    }

    case "kick": {
      const room = session.roomId ? rooms.get(session.roomId) : undefined;
      if (!room || session.seat !== 0) {
        error(session, "not_host", "Only the host can do that");
        return;
      }
      if (msg.seat >= room.maxSeats) {
        error(session, "bad_seat", "No such seat");
        return;
      }
      const seat = room.seats[msg.seat];
      if (!seat) {
        error(session, "empty_seat", "Seat is empty");
        return;
      }
      if (seat.kind === "human" && seat.playerId) {
        const target = byPlayerId.get(seat.playerId);
        if (target && target.roomId === room.id) {
          send(target, { type: "kicked", roomId: room.id });
          target.roomId = undefined;
          target.seat = undefined;
        }
      }
      room.seats[msg.seat] = null;
      broadcastRoom(room);
      return;
    }

    case "add_bot": {
      const room = session.roomId ? rooms.get(session.roomId) : undefined;
      if (!room || session.seat !== 0) {
        error(session, "not_host", "Only the host can do that");
        return;
      }
      let seatNo = msg.seat;
      if (seatNo === undefined) {
        const free = room.seats.findIndex(
          (s, i) => i > 0 && (s === null || (s.kind === "human" && !s.connected))
        );
        if (free < 0) {
          error(session, "room_full", "No free seat");
          return;
        }
        seatNo = free;
      }
      if (seatNo >= room.maxSeats) {
        error(session, "bad_seat", "No such seat");
        return;
      }
      const current = room.seats[seatNo];
      if (current && !(current.kind === "human" && !current.connected)) {
        error(session, "seat_taken", "Seat is taken");
        return;
      }
      room.seats[seatNo] = {
        name: `Bot ${seatNo}`,
        kind: "bot",
        connected: true,
      };
      broadcastRoom(room);
      return;
    }

    case "start": {
      const room = session.roomId ? rooms.get(session.roomId) : undefined;
      if (!room || session.seat !== 0) {
        error(session, "not_host", "Only the host can do that");
        return;
      }
      const ready = room.seats.every((s) => s !== null && s.connected);
      if (!ready) {
        error(session, "not_ready", "All seats must be filled and connected");
        return;
      }
      room.phase = "playing";
      broadcastRoom(room);
      for (const seat of room.seats) {
        if (seat?.playerId) {
          const s = byPlayerId.get(seat.playerId);
          if (s && s.roomId === room.id) send(s, { type: "started" });
        }
      }
      return;
    }

    case "send": {
      const room = session.roomId ? rooms.get(session.roomId) : undefined;
      if (!room) {
        error(session, "no_room", "Not in a room");
        return;
      }
      if (session.seat === 0) {
        // host -> guest
        if (msg.toSeat === undefined || msg.toSeat >= room.maxSeats) {
          error(session, "bad_seat", "toSeat required");
          return;
        }
        const seat = room.seats[msg.toSeat];
        if (!seat?.playerId) {
          error(session, "bad_seat", "No player on that seat");
          return;
        }
        const target = byPlayerId.get(seat.playerId);
        if (target && target.roomId === room.id)
          send(target, { type: "host_msg", data: msg.data });
        return;
      }
      // guest -> host
      const host = hostSession(room);
      if (host)
        send(host, { type: "player_msg", fromSeat: session.seat, data: msg.data });
      return;
    }
  }
}

export function stats() {
  return { rooms: rooms.size, players: byPlayerId.size };
}
