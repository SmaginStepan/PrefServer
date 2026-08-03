import { z } from "zod";

// The server never interprets `rules` or relayed `data` — both are opaque JSON
// owned by the game clients.

const roomId = z.string().regex(/^[A-Z0-9]{6}$/);
const playerId = z.string().min(8).max(64);
const displayName = z.string().min(1).max(24);
const seatIndex = z.number().int().min(1).max(3);

export const helloMsg = z.object({
  type: z.literal("hello"),
  playerId,
  name: displayName,
});

export const listRoomsMsg = z.object({ type: z.literal("list_rooms") });

export const createRoomMsg = z.object({
  type: z.literal("create_room"),
  name: z.string().min(1).max(32),
  rules: z.unknown(),
  maxSeats: z.union([z.literal(3), z.literal(4)]),
  password: z.string().min(1).max(32).optional(),
});

/** Host re-opens a previously started game to resume it (same room id). */
export const reopenRoomMsg = z.object({
  type: z.literal("reopen_room"),
  roomId,
  name: z.string().min(1).max(32),
  rules: z.unknown(),
  maxSeats: z.union([z.literal(3), z.literal(4)]),
  password: z.string().min(1).max(32).optional(),
  seats: z
    .array(
      z
        .object({
          playerId: playerId.optional(),
          name: displayName,
          kind: z.enum(["human", "bot"]),
        })
        .nullable()
    )
    .max(4),
});

export const joinMsg = z.object({
  type: z.literal("join"),
  roomId,
  password: z.string().max(32).optional(),
});

export const leaveMsg = z.object({ type: z.literal("leave") });

export const kickMsg = z.object({ type: z.literal("kick"), seat: seatIndex });

export const addBotMsg = z.object({
  type: z.literal("add_bot"),
  seat: seatIndex.optional(),
});

export const startMsg = z.object({ type: z.literal("start") });

/** Host rearranges guests before the game starts (seat 0 stays the host). */
export const swapSeatsMsg = z.object({
  type: z.literal("swap_seats"),
  a: seatIndex,
  b: seatIndex,
});

/** Blind relay. Host must address a seat; guests always talk to the host. */
export const sendMsg = z.object({
  type: z.literal("send"),
  toSeat: z.number().int().min(1).max(3).optional(),
  data: z.unknown(),
});

export const clientMsg = z.discriminatedUnion("type", [
  helloMsg,
  listRoomsMsg,
  createRoomMsg,
  reopenRoomMsg,
  joinMsg,
  leaveMsg,
  kickMsg,
  addBotMsg,
  startMsg,
  swapSeatsMsg,
  sendMsg,
]);

export type ClientMsg = z.infer<typeof clientMsg>;
