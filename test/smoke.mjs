// End-to-end smoke test: full lobby + relay flow against a running server.
// Usage: node test/smoke.mjs [ws://127.0.0.1:8090/ws]
import WebSocket from "ws";

const URL = process.argv[2] ?? "ws://127.0.0.1:8090/ws";
let failures = 0;

function check(cond, label) {
  if (cond) console.log(`  ok  ${label}`);
  else {
    console.error(`FAIL  ${label}`);
    failures++;
  }
}

class Client {
  constructor(name, playerId) {
    this.name = name;
    this.playerId = playerId;
    this.inbox = [];
    this.waiters = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(URL);
      this.ws.on("open", resolve);
      this.ws.on("error", reject);
      this.ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        const w = this.waiters.findIndex((x) => x.pred(msg));
        if (w >= 0) this.waiters.splice(w, 1)[0].resolve(msg);
        else this.inbox.push(msg);
      });
    });
  }
  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }
  wait(pred, timeoutMs = 3000) {
    const hit = this.inbox.findIndex(pred);
    if (hit >= 0) return Promise.resolve(this.inbox.splice(hit, 1)[0]);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for message")), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(t);
          resolve(m);
        },
      });
    });
  }
  async hello() {
    await this.connect();
    this.send({ type: "hello", playerId: this.playerId, name: this.name });
    await this.wait((m) => m.type === "welcome");
  }
  close() {
    this.ws.close();
  }
}

const host = new Client("Host", "host-0000-0000");
const alice = new Client("Alice", "alice-0000-0000");
const bob = new Client("Bob", "bob-0000-0000");

console.log(`smoke test against ${URL}`);

await host.hello();
await alice.hello();
await bob.hello();

// create a password-protected 3-seat room
host.send({ type: "create_room", name: "Test game", rules: { gameType: "Sochy", limit: 10 }, maxSeats: 3, password: "secret" });
const created = await host.wait((m) => m.type === "room_created");
const roomId = created.roomId;
check(/^[A-Z0-9]{6}$/.test(roomId), `room created: ${roomId}`);

// lobby listing shows it with password flag and rules
alice.send({ type: "list_rooms" });
const rooms = await alice.wait((m) => m.type === "rooms");
const listed = rooms.rooms.find((r) => r.id === roomId);
check(!!listed && listed.hasPassword && listed.rules.gameType === "Sochy", "room listed with rules + password flag");

// wrong password rejected, right password seats Alice
alice.send({ type: "join", roomId, password: "nope" });
check((await alice.wait((m) => m.type === "error")).code === "bad_password", "wrong password rejected");
alice.send({ type: "join", roomId, password: "secret" });
const joined = await alice.wait((m) => m.type === "joined");
check(joined.seat === 1, "alice joined seat 1");

// host fills seat 2 with a bot and starts
host.send({ type: "add_bot" });
const withBot = await host.wait((m) => m.type === "room_state" && m.room.seats[2]?.kind === "bot");
check(withBot.room.seats[2].kind === "bot", "bot added on seat 2");

// host rearranges guests before start
host.send({ type: "swap_seats", a: 1, b: 2 });
const swapped = await host.wait((m) => m.type === "room_state" && m.room.seats[1]?.kind === "bot");
check(swapped.room.seats[2]?.name === "Alice", "seats swapped by host");
host.send({ type: "swap_seats", a: 1, b: 2 });
await host.wait((m) => m.type === "room_state" && m.room.seats[1]?.name === "Alice");
check(true, "seats swapped back");

host.send({ type: "start" });
await host.wait((m) => m.type === "started");
await alice.wait((m) => m.type === "started");
check(true, "game started, both notified");

// relay both directions, opaque payloads
alice.send({ type: "send", data: { action: "bid", contract: 6 } });
const fromAlice = await host.wait((m) => m.type === "player_msg");
check(fromAlice.fromSeat === 1 && fromAlice.data.action === "bid", "guest -> host relay");
host.send({ type: "send", toSeat: 1, data: { snapshot: [1, 2, 3] } });
const fromHost = await alice.wait((m) => m.type === "host_msg");
check(fromHost.data.snapshot.length === 3, "host -> guest relay");

// bob cannot join a started game
bob.send({ type: "join", roomId, password: "secret" });
check((await bob.wait((m) => m.type === "error")).code === "playing", "no join after start");

// alice drops mid-game: seat reserved, hello alone reclaims it and replays
// the room context (auto-rejoin), and explicit join stays idempotent
alice.ws.terminate();
await host.wait((m) => m.type === "room_state" && m.room.seats[1]?.connected === false);
check(true, "disconnected seat kept reserved");
const alice2 = new Client("Alice", "alice-0000-0000");
await alice2.hello();
const autoJoin = await alice2.wait((m) => m.type === "joined");
check(autoJoin.seat === 1 && autoJoin.roomId === roomId, "hello auto-reclaimed the seat");
await alice2.wait((m) => m.type === "started");
check(true, "started replayed on reconnect");
alice2.send({ type: "join", roomId });
const rejoined = await alice2.wait((m) => m.type === "joined");
check(rejoined.seat === 1, "explicit join is idempotent");

// kick
host.send({ type: "kick", seat: 1 });
await alice2.wait((m) => m.type === "kicked");
check(true, "kicked player notified");

// host leaves -> room closes and disappears from the lobby
host.send({ type: "leave" });
await host.wait((m) => m.type === "left");
bob.send({ type: "list_rooms" });
const after = await bob.wait((m) => m.type === "rooms");
check(!after.rooms.some((r) => r.id === roomId), "room closed after host left");

// resume flow: host reopens the same id with reserved seats
host.send({
  type: "reopen_room",
  roomId,
  name: "Test game",
  rules: { gameType: "Sochy", limit: 10 },
  maxSeats: 3,
  seats: [
    { playerId: "host-0000-0000", name: "Host", kind: "human" },
    { playerId: "alice-0000-0000", name: "Alice", kind: "human" },
    { name: "Bot 2", kind: "bot" },
  ],
});
const reopened = await host.wait((m) => m.type === "room_created");
check(reopened.roomId === roomId, "room reopened with same id");
alice2.send({ type: "join", roomId });
const back = await alice2.wait((m) => m.type === "joined");
check(back.seat === 1, "alice rejoined reserved seat on resume");
host.send({ type: "start" });
await host.wait((m) => m.type === "started");
check(true, "resumed game started");

// transient HOST drop: the room survives the grace period and the host
// reclaims seat 0 by reconnecting
host.ws.terminate();
await new Promise((r) => setTimeout(r, 300));
bob.send({ type: "list_rooms" });
const graceList = await bob.wait((m) => m.type === "rooms");
check(graceList.rooms.some((r) => r.id === roomId), "room survives host drop (grace)");
const host2 = new Client("Host", "host-0000-0000");
await host2.hello();
const hostBack = await host2.wait((m) => m.type === "joined");
check(hostBack.seat === 0 && hostBack.roomId === roomId, "host auto-reclaimed seat 0");
await host2.wait((m) => m.type === "started");
check(true, "started replayed to reconnected host");

// open-room guest drop: the seat is kept during grace and hello reclaims it
bob.send({ type: "create_room", name: "Bob game", rules: {}, maxSeats: 3 });
const bobRoom = (await bob.wait((m) => m.type === "room_created")).roomId;
const carol = new Client("Carol", "carol-0000-0000");
await carol.hello();
carol.send({ type: "join", roomId: bobRoom });
await carol.wait((m) => m.type === "joined");
carol.ws.terminate();
await bob.wait((m) => m.type === "room_state" && m.room.seats[1]?.connected === false);
check(true, "open-room seat kept during grace");
const carol2 = new Client("Carol", "carol-0000-0000");
await carol2.hello();
const carolBack = await carol2.wait((m) => m.type === "joined");
check(carolBack.seat === 1 && carolBack.roomId === bobRoom, "guest auto-reclaimed open-room seat");
await bob.wait((m) => m.type === "room_state" && m.room.seats[1]?.connected === true);
check(true, "host sees the guest back online");

host2.close();
alice2.close();
bob.close();
carol2.close();

if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall checks passed");
process.exit(0);
