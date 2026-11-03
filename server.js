// Who's the Imposter? — online multiplayer server
// The server picks the word and the imposter, and only ever tells each
// player their own role, so nobody can peek at who the imposter is.

const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");
const CATS = require("./app/www/words.js");

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 20;
const MAX_ROOMS = 2000;
const HOST_HANDOFF_MS = 20_000;      // host offline this long -> next player becomes host
const PLAYER_DROP_MS = 3 * 60_000;   // offline this long -> removed from room
const ROOM_IDLE_MS = 30 * 60_000;    // nobody connected this long -> room deleted

const app = express();
app.disable("x-powered-by");
app.get("/healthz", (_req, res) => res.send("ok"));
app.get("/categories.json", (_req, res) =>
  res.json(Object.entries(CATS).map(([key, c]) => ({ key, name: c.name, emo: c.emo, count: c.words.length }))));
app.use("/solo", express.static(path.join(__dirname, "app/www")));
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server, { pingInterval: 15000, pingTimeout: 20000, maxHttpBufferSize: 10_000 });

/** code -> room */
const rooms = new Map();

const randInt = n => crypto.randomInt(n);
const pick = arr => arr[randInt(arr.length)];
const cleanName = s => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g, "").replace(/\s+/g, " ").trim().slice(0, 16);
const validPid = s => typeof s === "string" && /^[A-Za-z0-9_-]{8,40}$/.test(s);
const validCat = k => typeof k === "string" && (k === "random" || Object.prototype.hasOwnProperty.call(CATS, k));

function genCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  for (let tries = 0; tries < 1000; tries++) {
    let c = ""; for (let i = 0; i < 4; i++) c += A[randInt(A.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}

function ordered(room) { return [...room.players.values()].sort((a, b) => a.joinedAt - b.joinedAt); }
function connectedPlayers(room) { return ordered(room).filter(p => p.connected); }

function uniqueName(room, name, pid) {
  const taken = new Set(ordered(room).filter(p => p.id !== pid).map(p => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; i < 100; i++) { const n = `${name.slice(0, 13)} ${i}`; if (!taken.has(n.toLowerCase())) return n; }
  return name;
}

function pickNewHost(room) {
  const next = connectedPlayers(room)[0] || ordered(room)[0];
  room.hostId = next ? next.id : null;
}

/** What one particular player is allowed to see. */
function viewFor(room, pid) {
  const r = room.round;
  const players = ordered(room).map(p => ({ id: p.id, name: p.name, connected: p.connected, catVote: p.catVote || null }));
  let round = null;
  if (r) {
    const dealt = r.dealt.includes(pid);
    const isImp = dealt && r.imps.includes(pid);
    round = {
      id: r.id,
      phase: r.phase,
      // the imposter doesn't learn the category if the host turned the hint off
      cat: isImp && !r.hint && r.phase === "play" ? null : r.cat,
      hint: r.hint,
      starter: r.starter,
      dealt: r.dealt,
      you: dealt ? { imp: isImp, word: isImp ? null : r.word } : null,
      myVote: r.votes.get(pid) || null,
      voted: r.votes.size,
    };
    if (r.phase === "reveal") {
      const tally = {};
      for (const s of r.votes.values()) tally[s] = (tally[s] || 0) + 1;
      Object.assign(round, { imps: r.imps, word: r.word, tally });
    }
  }
  return { code: room.code, you: pid, hostId: room.hostId, sel: room.sel, hint: room.hint, players, round };
}

function broadcast(room) {
  for (const p of room.players.values()) {
    if (p.connected && p.socketId) io.to(p.socketId).emit("state", viewFor(room, p.id));
  }
}

function removePlayer(room, pid) {
  room.players.delete(pid);
  if (room.round) room.round.votes.delete(pid);
  if (room.players.size === 0) { rooms.delete(room.code); return; }
  if (room.hostId === pid) pickNewHost(room);
  broadcast(room);
}

// Imposter count for a round: usually 1, with rare surprise rounds.
//   1%  no imposter at all
//   5%  everyone is the imposter
//   20% two imposters (needs 4+ players, otherwise it stays at 1)
function imposterCount(n) {
  const roll = randInt(100);
  if (roll < 1) return 0;
  if (roll < 6) return n;
  if (roll < 26) return n >= 4 ? 2 : 1;
  return 1;
}
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function startRound(room) {
  const ps = connectedPlayers(room);
  if (ps.length < 3) return "Need at least 3 connected players";
  const cat = room.sel === "random" ? pick(Object.keys(CATS)) : room.sel;
  const used = room.used[cat] || (room.used[cat] = []);
  let pool = CATS[cat].words.filter(w => !used.includes(w));
  if (!pool.length) { room.used[cat] = []; pool = CATS[cat].words.slice(); }
  const word = pick(pool); room.used[cat].push(word);
  const imps = shuffle(ps.map(p => p.id)).slice(0, imposterCount(ps.length));
  const crew = ps.filter(p => !imps.includes(p.id));
  const starter = pick(crew.length ? crew : ps).id;
  room.round = {
    id: crypto.randomBytes(6).toString("hex"),
    phase: "play", cat, word, imps, starter, hint: room.hint,
    dealt: ps.map(p => p.id), votes: new Map(),
  };
  return null;
}

io.on("connection", socket => {
  const ctx = () => {
    const room = rooms.get(socket.data.code);
    const me = room && room.players.get(socket.data.pid);
    if (!room || !me || me.socketId !== socket.id) return {};
    return { room, me, host: room.hostId === me.id };
  };
  const reply = (ack, payload) => { if (typeof ack === "function") ack(payload); };

  socket.on("join", (msg, ack) => {
    msg = msg || {};
    const name = cleanName(msg.name);
    const pid = msg.pid;
    if (!name) return reply(ack, { error: "Enter your name first" });
    if (!validPid(pid)) return reply(ack, { error: "Bad player id — reload the page" });

    let room;
    if (msg.create) {
      if (rooms.size >= MAX_ROOMS) return reply(ack, { error: "Server is full, try again soon" });
      const code = genCode();
      if (!code) return reply(ack, { error: "Couldn't make a room, try again" });
      room = { code, hostId: pid, sel: validCat(msg.cat) ? msg.cat : "animals", hint: true, players: new Map(), round: null, used: {}, lastActive: Date.now() };
      rooms.set(code, room);
    } else {
      const code = String(msg.code || "").toUpperCase().replace(/[^A-Z]/g, "");
      room = rooms.get(code);
      if (!room) return reply(ack, { error: `No room called ${code || "that"} — check the code` });
    }

    // leave any other room this socket was in
    if (socket.data.code && socket.data.code !== room.code) {
      const old = rooms.get(socket.data.code);
      if (old && old.players.get(socket.data.pid)?.socketId === socket.id) removePlayer(old, socket.data.pid);
    }

    let me = room.players.get(pid);
    if (!me) {
      if (room.players.size >= MAX_PLAYERS) return reply(ack, { error: "That room is full" });
      me = { id: pid, joinedAt: Date.now(), catVote: null };
      room.players.set(pid, me);
    } else if (me.socketId && me.socketId !== socket.id) {
      // same player opened another tab: the older tab stops getting updates
      io.to(me.socketId).emit("kicked", "You opened this game in another tab.");
    }
    me.name = uniqueName(room, name, pid);
    me.socketId = socket.id;
    me.connected = true;
    me.offlineSince = null;
    if (!room.hostId || !room.players.has(room.hostId)) room.hostId = pid;
    socket.data.code = room.code;
    socket.data.pid = pid;
    room.lastActive = Date.now();
    reply(ack, { ok: true, code: room.code });
    broadcast(room);
  });

  socket.on("vote_cat", k => {
    const { room, me, host } = ctx(); if (!room || !validCat(k)) return;
    me.catVote = me.catVote === k && !host ? null : k;
    if (host) room.sel = k;
    broadcast(room);
  });

  socket.on("set_cat", k => {
    const { room, host } = ctx(); if (!room || !host || !validCat(k)) return;
    room.sel = k; broadcast(room);
  });

  socket.on("set_hint", on => {
    const { room, host } = ctx(); if (!room || !host) return;
    room.hint = !!on; broadcast(room);
  });

  socket.on("start", (_m, ack) => {
    const { room, host } = ctx(); if (!room || !host) return;
    if (room.round && room.round.phase === "play") return;
    const err = startRound(room);
    if (err) return reply(ack, { error: err });
    reply(ack, { ok: true });
    broadcast(room);
  });

  socket.on("reveal", () => {
    const { room, host } = ctx(); if (!room || !host || !room.round) return;
    room.round.phase = "reveal"; broadcast(room);
  });

  socket.on("to_lobby", () => {
    const { room, host } = ctx(); if (!room || !host) return;
    room.round = null; broadcast(room);
  });

  socket.on("suspect", target => {
    const { room, me } = ctx(); const r = room && room.round;
    if (!r || r.phase !== "play" || !r.dealt.includes(me.id)) return;
    if (typeof target !== "string" || target === me.id || (target !== "none" && !r.dealt.includes(target))) return;
    if (r.votes.get(me.id) === target) r.votes.delete(me.id); else r.votes.set(me.id, target);
    broadcast(room);
  });

  socket.on("make_host", target => {
    const { room, host } = ctx(); if (!room || !host || !room.players.has(target)) return;
    room.hostId = target; broadcast(room);
  });

  socket.on("kick", target => {
    const { room, me, host } = ctx(); if (!room || !host || target === me.id) return;
    const p = room.players.get(target); if (!p) return;
    if (p.socketId) io.to(p.socketId).emit("kicked", "The host removed you from the room.");
    removePlayer(room, target);
  });

  socket.on("leave", () => {
    const { room, me } = ctx(); if (!room) return;
    socket.data.code = null;
    removePlayer(room, me.id);
  });

  socket.on("disconnect", () => {
    const { room, me } = ctx(); if (!room) return;
    me.connected = false; me.offlineSince = Date.now();
    broadcast(room);
  });
});

// Housekeeping: hand off host, drop long-gone players, delete dead rooms.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    let changed = false;
    const anyone = connectedPlayers(room).length > 0;
    if (anyone) room.lastActive = now;
    else if (now - room.lastActive > ROOM_IDLE_MS) { rooms.delete(room.code); continue; }

    const host = room.players.get(room.hostId);
    if (host && !host.connected && now - host.offlineSince > HOST_HANDOFF_MS && anyone) { pickNewHost(room); changed = true; }

    for (const p of [...room.players.values()]) {
      if (!p.connected && now - p.offlineSince > PLAYER_DROP_MS && anyone) {
        room.players.delete(p.id);
        if (room.round) room.round.votes.delete(p.id);
        if (room.hostId === p.id) pickNewHost(room);
        changed = true;
      }
    }
    if (changed) broadcast(room);
  }
}, 5000).unref();

server.listen(PORT, () => console.log(`Imposter server on http://localhost:${PORT}`));
