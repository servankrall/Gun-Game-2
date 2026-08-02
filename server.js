// Blockfield — authoritative realtime server for the Higgsfield apps-engine.
// One DurableObject backs the single /ws endpoint. It hosts multiple ROOMS
// (partitioned by a join-time room id), fills each room with controlled BOTS,
// and runs a team-deathmatch MATCH loop (first team to SCORE_LIMIT wins).
//
// Protocol matches the Blockfield client (js/game.js).
import { DurableObject } from 'cloudflare:workers';

// ============================================================
// Map (duplicated verbatim from js/map.js so the server shares the exact
// voxel layout — used for bot line-of-sight and ground following).
// The deploy validator forbids importing local modules, hence the copy.
// ============================================================
const HALF = 32;
function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function buildMapBlocks() {
  const m = new Map();
  const set = (x, y, z, type) => m.set(`${x},${y},${z}`, { x, y, z, type });
  const del = (x, y, z) => m.delete(`${x},${y},${z}`);
  const box = (x0, y0, z0, x1, y1, z1, type) => {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) set(x, y, z, type);
  };
  const carve = (x0, y0, z0, x1, y1, z1) => {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) del(x, y, z);
  };
  const r = seededRng(4242);
  for (let x = -HALF; x < HALF; x++) for (let z = -HALF; z < HALF; z++) {
    let t = 'sand'; const v = r();
    if (v < 0.05) t = 'gravel'; else if (v < 0.07) t = 'dirt';
    set(x, 0, z, t);
  }
  for (let x = -HALF; x < HALF; x++) for (let z = -HALF; z < HALF; z++) {
    const d = Math.hypot(x + 0.5, z + 0.5);
    if (d >= 11 && d <= 12.8) set(x, 0, z, 'stone');
  }
  for (let x = 13; x <= 25; x++) for (let z = -1; z <= 1; z++) { set(x, 0, z, 'gravel'); set(-x - 1, 0, z, 'gravel'); }
  for (let z = 13; z <= 27; z++) for (let x = -1; x <= 1; x++) { set(x, 0, z, 'gravel'); set(x, 0, -z - 1, 'gravel'); }
  for (let i = -HALF - 1; i <= HALF; i++) for (let y = 0; y <= 5; y++) {
    set(i, y, -HALF - 1, 'bedrock'); set(i, y, HALF, 'bedrock'); set(-HALF - 1, y, i, 'bedrock'); set(HALF, y, i, 'bedrock');
  }
  for (let y = 1; y <= 5; y++) { const B = 8 - y; for (let x = -B; x <= B; x++) for (let z = -B; z <= B; z++) set(x, y, z, y === 1 ? 'cobble' : (r() < 0.22 ? 'cobble' : 'sand')); }
  carve(-3, 1, -3, 3, 3, 3); carve(-7, 1, -1, 7, 2, 1); carve(-1, 1, -7, 1, 2, 7); carve(0, 1, 0, 0, 5, 0);
  [[-3, -3], [-3, 3], [3, -3], [3, 3], [0, 3], [0, -3], [3, 0], [-3, 0]].forEach(([x, z]) => { if (x || z) set(x, 6, z, 'cobble'); });
  set(-2, 1, -2, 'planks'); set(2, 1, 2, 'planks'); set(2, 2, 2, 'planks'); set(-2, 1, 2, 'redWool'); set(2, 1, -2, 'blueWool');
  const pillars = [[11, 4, 4], [11, -5, 3], [8, 9, 4], [8, -10, 2], [4, 11, 3], [4, -12, 4]];
  pillars.forEach(([px, pz, h]) => { [[px, pz], [-px - 1, pz]].forEach(([x, z]) => { box(x, 1, z, x, h, z, 'cobble'); if (h >= 4) set(x, h + 1, z, 'leaves'); }); });
  [[0, 18], [0, -19]].forEach(([tx, tz]) => {
    const sz = tz > 0 ? 1 : -1;
    box(tx - 1, 1, tz - 1, tx + 1, 4, tz + 1, 'bricks'); box(tx - 2, 5, tz - 2, tx + 2, 5, tz + 2, 'planks');
    box(tx, 1, tz + 3 * sz, tx, 1, tz + 3 * sz, 'cobble'); box(tx, 1, tz + 2 * sz, tx, 2, tz + 2 * sz, 'cobble');
    box(tx - 1, 1, tz + 2 * sz, tx - 1, 3, tz + 2 * sz, 'cobble'); box(tx - 1, 1, tz + 1 * sz, tx - 1, 4, tz + 1 * sz, 'cobble');
  });
  [[19, 20], [19, -21], [-20, 20], [-20, -21]].forEach(([ox, oz]) => {
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) if (dx * dx + dz * dz <= 9 && r() < 0.85) set(ox + dx, 0, oz + dz, 'grass');
    const palm = (px, pz, h) => { box(px, 1, pz, px, h, pz, 'log'); set(px + 1, h + 1, pz, 'leaves'); set(px - 1, h + 1, pz, 'leaves'); set(px, h + 1, pz + 1, 'leaves'); set(px, h + 1, pz - 1, 'leaves'); set(px, h + 2, pz, 'leaves'); };
    palm(ox, oz, 4); palm(ox + 2, oz - 2, 3); set(ox - 2, 1, oz + 1, 'leaves'); set(ox + 1, 1, oz + 2, 'leaves');
  });
  for (let i = 0; i < 9; i++) {
    const cx = 6 + Math.floor(r() * 14); const cz = Math.floor(r() * 52) - 26; const len = 3 + Math.floor(r() * 3); const alongX = r() < 0.5;
    if (cx <= 9 && Math.abs(cz) <= 9) continue;
    if (Math.abs(cz) >= 13 && Math.abs(cz) <= 16) continue;
    const heights = Array.from({ length: len }, () => 1 + Math.floor(r() * 3));
    heights.forEach((h, j) => { const bx = alongX ? cx + j : cx; const bz = alongX ? cz : cz + j; if (Math.abs(bx) > 24 || Math.abs(bz) > 29) return; box(bx, 1, bz, bx, h, bz, 'bricks'); box(-bx - 1, 1, bz, -bx - 1, h, bz, 'bricks'); });
  }
  for (let i = 0; i < 12; i++) {
    const cx = 5 + Math.floor(r() * 18); const cz = Math.floor(r() * 54) - 27; if (Math.hypot(cx, cz) < 11) continue;
    box(cx, 1, cz, cx + 1, 1, cz + 1, 'sand'); box(-cx - 2, 1, cz, -cx - 1, 1, cz + 1, 'sand');
  }
  for (let z = -12; z <= 12; z++) for (let x = 26; x <= 30; x++) { set(-x, 0, z, 'redWool'); set(x, 0, z, 'blueWool'); }
  for (let z = -9; z <= 9; z++) { if ((z + 9) % 4 === 3) continue; box(-24, 1, z, -24, 2, z, 'redWool'); box(23, 1, z, 23, 2, z, 'blueWool'); }
  [[-28, 'redWool'], [27, 'blueWool']].forEach(([bx, wool]) => { box(bx - 2, 1, -16, bx + 2, 3, -16, wool); box(bx - 2, 1, 16, bx + 2, 3, 16, wool); });
  return [...m.values()];
}

// Precompute a solid-voxel Set and a per-column ground height once.
const SOLID = new Set();
const GROUND = new Map(); // "x,z" -> highest solid y
for (const b of buildMapBlocks()) {
  SOLID.add(`${b.x},${b.y},${b.z}`);
  const k = `${b.x},${b.z}`;
  const cur = GROUND.get(k);
  if (cur === undefined || b.y > cur) GROUND.set(k, b.y);
}
const solid = (x, y, z) => SOLID.has(`${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`);
const groundTop = (x, z) => { const v = GROUND.get(`${Math.floor(x)},${Math.floor(z)}`); return v === undefined ? -1 : v; };
// Room-aware solidity: the static map, minus blocks players have destroyed, plus
// blocks players have built. Bot line-of-sight must use this so player-built
// cover actually blocks bot fire (bots were shooting through built walls).
function solidRoom(r, x, y, z) {
  const k = `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
  if (r.placed.has(k)) return true;
  if (r.destroyed.has(k)) return false;
  return SOLID.has(k);
}
// true if the straight segment a->b is clear of solid voxels (bot line of sight)
function losClear(r, ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const dist = Math.hypot(dx, dy, dz);
  const steps = Math.ceil(dist / 0.34);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (solidRoom(r, ax + dx * t, ay + dy * t, az + dz * t)) return false;
  }
  return true;
}

// ============================================================
// Tuning
// ============================================================
const CFG = {
  scoreLimit: 150,         // team kills to win a match
  tick: 50,                // ms between state broadcasts / bot updates
  bots: true,
  botTeamTarget: 3,        // desired combatants (players+bots) per team
  botCap: 6,               // max bots per room
  botNames: ['Ozan', 'Deniz', 'Kaya', 'Ares', 'Bora', 'Cem', 'Efe', 'Mert', 'Rux', 'Zane', 'Nova', 'Kartal'],
  regenDelay: 5000,        // ms without taking damage before health regenerates
  regenRate: 14,           // HP restored per second while regenerating
  captureLimit: 3,         // flag captures to win a CTF match
  flagReturn: 30000,       // ms a dropped flag waits before auto-returning home
};
const WEAPON = { rifle: { dmg: 16, rate: 220, range: 22 } };
// Gun Game weapon ladder: every kill promotes the killer one rung, and the
// first player to score a kill with the final rung wins. The last rung is the
// pickaxe — the classic melee "humiliation" finisher. Must match the client.
const GG_LADDER = ['pistol', 'smg', 'rifle', 'shotgun', 'lmg', 'sniper', 'bazooka', 'pickaxe'];
// Per-difficulty bot skill range (skill scales fire rate + accuracy).
const SKILL = {
  easy:   { min: 0.40, span: 0.35 },
  normal: { min: 0.72, span: 0.56 },
  hard:   { min: 1.05, span: 0.60 },
};
// Agent perks the server enforces (damage taken + regen rate). Everyone keeps
// 100 HP; HEAVY just absorbs more. Client handles speed/jump/loadout perks.
const AGENTS = {
  soldier:  { dmgTaken: 1.0,  regen: 1.0 },
  scout:    { dmgTaken: 1.15, regen: 1.0 },
  heavy:    { dmgTaken: 0.7,  regen: 1.0 },
  medic:    { dmgTaken: 1.0,  regen: 2.2 },
  ninja:    { dmgTaken: 1.1,  regen: 1.0 },
  engineer: { dmgTaken: 0.9,  regen: 1.0 },
  demo:     { dmgTaken: 1.0,  regen: 1.0 },
};
const agentOf = id => AGENTS[id] ? id : 'soldier';

function spawnFor(team) {
  const z = Math.random() * 16 - 8;
  const x = team === 'red' ? -28 : 28;
  return { x, y: groundTop(x, z) + 1.1, z };
}
function ryFor(team) { return team === 'red' ? -Math.PI / 2 : Math.PI / 2; }
// CTF flag home positions (inside each base, within the no-build zone so they
// can't be walled in). Each flag: home, current pos, carrier id, atHome, dropAt.
function makeFlags() {
  const z = 0, home = (x) => ({ x, y: groundTop(x, z) + 0.5, z });
  const rh = home(-26), bh = home(26);
  return {
    red:  { home: rh, pos: { ...rh }, carrier: null, atHome: true, dropAt: 0 },
    blue: { home: bh, pos: { ...bh }, carrier: null, atHome: true, dropAt: 0 },
  };
}
const clampArena = v => Math.max(-HALF + 1.5, Math.min(HALF - 2.5, v));

export class GameServer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.rooms = new Map();   // roomId -> room
    this.nextId = 1;
    this.tick = null;
    this.lastTick = Date.now();
    this.online = new Map();  // pid -> { name, room, socks:Set } for friend presence
  }

  // ---- friend presence (pid = a persistent client id sent at hello/join) ----
  presenceOnline(pid, name, room, conn) {
    let e = this.online.get(pid);
    if (!e) { e = { name, room, socks: new Set() }; this.online.set(pid, e); }
    e.name = name || e.name; e.room = room; e.socks.add(conn);
  }
  presenceOffline(pid, conn) {
    const e = this.online.get(pid); if (!e) return;
    e.socks.delete(conn); if (!e.socks.size) this.online.delete(pid);
  }
  presenceQuery(pids) {
    const out = {};
    for (const pid of pids) { const e = this.online.get(pid); if (e) out[pid] = { name: e.name, room: e.room }; }
    return out;
  }

  room(id) {
    let r = this.rooms.get(id);
    if (!r) {
      r = { id, clients: new Map(), bots: new Map(), scores: { red: 0, blue: 0 }, placed: new Map(), destroyed: new Map(), over: false, diff: 'normal', mode: 'dm', flags: null, map: 'desert' };
      this.rooms.set(id, r);
    }
    return r;
  }

  async fetch(request) {
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket')
      return new Response('expected websocket', { status: 426 });
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    server.accept();
    this.onConnect(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  onConnect(ws) {
    let id = null, roomId = null, pid = null; const conn = {};
    ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'hello') { // lobby presence (menu, no game join)
        pid = String(m.pid || '').toUpperCase().slice(0, 12) || null;
        if (pid) this.presenceOnline(pid, String(m.name || 'Player').slice(0, 16), 'lobby', conn);
        return;
      }
      if (m.t === 'presence_req') {
        this.send(ws, { t: 'presence', online: this.presenceQuery((Array.isArray(m.pids) ? m.pids : []).slice(0, 50)) });
        return;
      }
      if (m.t === 'join') {
        if (id !== null) return;
        roomId = String(m.room || 'pub').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'pub';
        pid = String(m.pid || pid || '').toUpperCase().slice(0, 12) || null;
        id = this.handleJoin(ws, m, roomId);
        if (pid) this.presenceOnline(pid, String(m.name || 'Player').slice(0, 16), roomId, conn);
        return;
      }
      if (id === null) return;
      this.handleMsg(roomId, id, m);
    });
    const bye = () => {
      if (id !== null) { this.handleLeave(roomId, id); id = null; }
      if (pid) { this.presenceOffline(pid, conn); }
    };
    ws.addEventListener('close', bye);
    ws.addEventListener('error', bye);
  }

  // ---- combatant helpers ----
  entities(r) { return [...r.clients.values()].map(c => c.player).concat([...r.bots.values()]); }
  pub(p) { return { id: p.id, name: p.name, team: p.team, pos: p.pos, ry: p.ry, rx: p.rx, anim: p.anim, alive: p.alive, hp: p.hp, kills: p.kills, deaths: p.deaths, bot: !!p.bot, agent: p.agent || 'soldier' }; }
  count(r) { return r.clients.size + r.bots.size; }
  teamCount(r, team) { return this.entities(r).filter(e => e.team === team).length; }
  humanTeamCount(r, team) { return [...r.clients.values()].filter(c => c.player.team === team).length; }

  pickTeam(r) {
    // balance by HUMANS (bots fill around them, so a 2nd human takes the other side)
    const red = this.humanTeamCount(r, 'red'), blue = this.humanTeamCount(r, 'blue');
    if (red !== blue) return red < blue ? 'red' : 'blue';
    return this.teamCount(r, 'red') <= this.teamCount(r, 'blue') ? 'red' : 'blue';
  }

  handleJoin(ws, m, roomId) {
    const r = this.room(roomId);
    const id = this.nextId++;
    const team = this.pickTeam(r);
    const name = String(m.name || 'Player').slice(0, 16) || 'Player';
    const pos = spawnFor(team);
    const agent = agentOf(m.agent);
    const player = { id, name, team, pos, ry: ryFor(team), rx: 0, anim: 0, hp: 100, alive: true, kills: 0, deaths: 0, lastHit: 0, level: 0,
      agent, dmgTakenMult: AGENTS[agent].dmgTaken, regenMult: AGENTS[agent].regen };
    r.clients.set(id, { ws, player });
    // First player in a room sets the bot difficulty AND the game mode for it.
    if (r.clients.size === 1) {
      if (['easy', 'normal', 'hard'].includes(m.diff)) r.diff = m.diff;
      if (m.mode === 'ctf') { r.mode = 'ctf'; r.flags = makeFlags(); }
      else if (m.mode === 'gg') { r.mode = 'gg'; }
      if (['desert', 'arctic', 'volcano', 'night', 'metro'].includes(m.map)) r.map = m.map;
    }

    this.send(ws, {
      t: 'welcome', id, team, pos, ry: player.ry, scores: r.scores, room: roomId, count: this.count(r),
      mode: r.mode, map: r.map, limit: r.mode === 'ctf' ? CFG.captureLimit : r.mode === 'gg' ? GG_LADDER.length : CFG.scoreLimit,
      flags: r.flags ? this.flagPub(r) : undefined,
      players: this.entities(r).filter(e => e.id !== id).map(e => this.pub(e)),
      placed: [...r.placed.values()], destroyed: [...r.destroyed.values()],
    });
    this.broadcastExcept(r, id, { t: 'join', p: this.pub(player) });
    this.balanceBots(r);
    this.broadcast(r, { t: 'roster', count: this.count(r) });
    this.ensureTick();
    return id;
  }

  handleMsg(roomId, id, m) {
    const r = this.rooms.get(roomId); if (!r) return;
    const c = r.clients.get(id); if (!c) return;
    const p = c.player;
    switch (m.t) {
      case 'state':
        if (m.pos) p.pos = { x: +m.pos.x, y: +m.pos.y, z: +m.pos.z };
        p.ry = +m.ry; p.rx = +m.rx; p.anim = +m.anim || 0;
        break;
      case 'shoot':
        this.broadcastExcept(r, id, { t: 'shoot', id, from: m.from, dir: m.dir, w: m.w });
        break;
      case 'hit': {
        const tgt = this.find(r, m.target);
        if (!tgt || !tgt.alive || tgt.team === p.team) break;
        this.applyDamage(r, tgt, Math.max(0, Math.min(300, m.dmg | 0)), p, !!m.head, m.w);
        this.send(c.ws, { t: 'hitconfirm', head: !!m.head });
        break;
      }
      case 'place': {
        if (Math.abs(m.x) >= 22) break; // no building in spawn zones (anti-trap) — matches client
        const key = `${m.x},${m.y},${m.z}`;
        r.destroyed.delete(key); r.placed.set(key, { x: m.x, y: m.y, z: m.z, team: p.team });
        this.broadcastExcept(r, id, { t: 'place', x: m.x, y: m.y, z: m.z, team: p.team });
        break;
      }
      case 'destroy': {
        const key = `${m.x},${m.y},${m.z}`;
        if (r.placed.has(key)) r.placed.delete(key); else r.destroyed.set(key, { x: m.x, y: m.y, z: m.z });
        this.broadcastExcept(r, id, { t: 'destroy', x: m.x, y: m.y, z: m.z });
        break;
      }
      case 'nade': { // relay a thrown grenade so everyone sees it fly + explode
        this.broadcastExcept(r, id, { t: 'nade', from: m.from, vel: m.vel });
        break;
      }
      case 'respawn':
        p.alive = true; p.hp = 100; p.pos = spawnFor(p.team); p.ry = ryFor(p.team); p.rx = 0;
        this.broadcast(r, { t: 'respawn', id: p.id, pos: p.pos });
        break;
      case 'rtc': {
        const tc = r.clients.get(m.to);
        if (tc) this.send(tc.ws, { t: 'rtc', from: id, data: m.data });
        break;
      }
      case 'chat': {
        const text = String(m.text || '').slice(0, 120);
        if (text) this.broadcast(r, { t: 'chat', name: p.name, team: p.team, text });
        break;
      }
      case 'ping':
        this.send(c.ws, { t: 'pong', ts: m.ts });
        break;
    }
  }

  find(r, id) { const c = r.clients.get(id); if (c) return c.player; return r.bots.get(id) || null; }

  applyDamage(r, tgt, dmg, attacker, head, weapon) {
    if (r.over) return;
    dmg = Math.max(1, Math.round(dmg * (tgt.dmgTakenMult || 1))); // agent damage-taken perk
    tgt.hp -= dmg;
    tgt.lastHit = Date.now(); // resets the regen delay
    if (tgt.hp > 0) {
      if (!tgt.bot) { const c = r.clients.get(tgt.id); if (c) this.send(c.ws, { t: 'hp', hp: tgt.hp }); }
      return;
    }
    tgt.hp = 0; tgt.alive = false; tgt.deaths++;
    tgt.streak = 0; // dying breaks your streak
    if (attacker) {
      attacker.kills++;
      attacker.streak = (attacker.streak || 0) + 1;
      // Kill-streak reward: every 3rd kill without dying refills you to full health.
      if (attacker.streak % 3 === 0 && attacker.alive) {
        attacker.hp = 100; attacker.lastHit = 0;
        if (!attacker.bot) { const c = r.clients.get(attacker.id); if (c) this.send(c.ws, { t: 'heal', hp: 100, streak: attacker.streak }); }
      }
    }
    tgt.respawnAt = Date.now() + (tgt.bot ? 3000 : 3500); // auto-respawn (client never asks)
    if (r.mode === 'ctf' && r.flags) this.dropFlagIfCarrier(r, tgt); // drop the flag where they fell
    // Deathmatch kills score for the team; CTF scores only on captures; Gun Game
    // tracks individual weapon-ladder progress instead of team score.
    if (r.mode === 'dm' && attacker) r.scores[attacker.team] = (r.scores[attacker.team] || 0) + 1;
    this.broadcast(r, { t: 'death', victim: tgt.id, killer: attacker ? attacker.id : tgt.id, head });
    this.broadcast(r, { t: 'scores', scores: r.scores });
    if (r.mode === 'gg') this.ggProgress(r, attacker, tgt, weapon);
    if (r.mode === 'dm' && attacker && r.scores[attacker.team] >= CFG.scoreLimit) this.endMatch(r, attacker.team);
  }

  // Gun Game: advance the killer up the weapon ladder (refilling their health),
  // and knock the victim down a rung on a melee/pickaxe kill (the humiliation).
  ggProgress(r, attacker, victim, weapon) {
    if (weapon === 'pickaxe' && victim && (victim.level || 0) > 0) {
      victim.level--;
      this.broadcast(r, { t: 'level', id: victim.id, level: victim.level, name: victim.name, demote: true });
    }
    if (!attacker) return;
    attacker.level = (attacker.level || 0) + 1;
    attacker.hp = 100; attacker.lastHit = 0; // fresh health on promotion
    if (!attacker.bot) { const c = r.clients.get(attacker.id); if (c) this.send(c.ws, { t: 'heal', hp: 100 }); }
    const won = attacker.level >= GG_LADDER.length;
    this.broadcast(r, { t: 'level', id: attacker.id, level: Math.min(attacker.level, GG_LADDER.length), name: attacker.name, up: true });
    if (won) this.endMatch(r, attacker.team, attacker.name);
  }

  flagPub(r) {
    const f = r.flags; const p = t => ({ x: f[t].pos.x, y: f[t].pos.y, z: f[t].pos.z, carrier: f[t].carrier, atHome: f[t].atHome });
    return { red: p('red'), blue: p('blue') };
  }
  dropFlagIfCarrier(r, ent) {
    for (const t of ['red', 'blue']) {
      const f = r.flags[t];
      if (f.carrier === ent.id) {
        f.carrier = null; f.atHome = false; f.dropAt = Date.now();
        f.pos = { x: ent.pos.x, y: groundTop(ent.pos.x, ent.pos.z) + 0.5, z: ent.pos.z };
        this.broadcast(r, { t: 'flag', ev: 'drop', team: t });
      }
    }
  }
  // CTF flag interactions — humans only (bots just fight).
  updateFlags(r, now) {
    if (r.mode !== 'ctf' || !r.flags || r.over) return;
    for (const t of ['red', 'blue']) { // auto-return a flag left on the ground
      const f = r.flags[t];
      if (!f.atHome && f.carrier === null && now - f.dropAt > CFG.flagReturn) {
        f.pos = { ...f.home }; f.atHome = true;
        this.broadcast(r, { t: 'flag', ev: 'returned', team: t });
      }
    }
    const near = (a, b, d) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2 < d * d;
    for (const c of r.clients.values()) {
      const p = c.player; if (!p.alive) continue;
      const own = r.flags[p.team], enemyT = p.team === 'red' ? 'blue' : 'red', enemy = r.flags[enemyT];
      if (enemy.carrier === p.id) {                 // carrying — follow + try to capture
        enemy.pos = { x: p.pos.x, y: p.pos.y + 0.2, z: p.pos.z };
        // Capture by carrying the enemy flag back into your own SPAWN ZONE
        // (x past the no-build line on your side) — no longer requires your
        // own flag to be home.
        const inHomeSpawn = p.team === 'red' ? p.pos.x <= -22 : p.pos.x >= 22;
        if (inHomeSpawn) {
          r.scores[p.team] = (r.scores[p.team] || 0) + 1;
          enemy.carrier = null; enemy.atHome = true; enemy.pos = { ...enemy.home };
          this.broadcast(r, { t: 'flag', ev: 'capture', team: enemyT, by: p.id, name: p.name });
          this.broadcast(r, { t: 'scores', scores: r.scores });
          if (r.scores[p.team] >= CFG.captureLimit) { this.endMatch(r, p.team); return; }
        }
      } else {
        if (enemy.carrier === null && near(p.pos, enemy.pos, 1.5)) { // grab enemy flag
          enemy.carrier = p.id; enemy.atHome = false;
          this.broadcast(r, { t: 'flag', ev: 'pickup', team: enemyT, by: p.id, name: p.name });
        } else if (!own.atHome && own.carrier === null && near(p.pos, own.pos, 1.5)) { // return own flag
          own.pos = { ...own.home }; own.atHome = true;
          this.broadcast(r, { t: 'flag', ev: 'returned', team: p.team, by: p.id, name: p.name });
        }
      }
    }
  }

  endMatch(r, winner, winnerName) {
    r.over = true;
    this.broadcast(r, { t: 'matchover', winner, winnerName: winnerName || null, scores: r.scores });
    setTimeout(() => this.resetMatch(r), 6000);
  }
  resetMatch(r) {
    if (!this.rooms.has(r.id)) return;
    r.over = false;
    r.scores = { red: 0, blue: 0 };
    r.placed.clear(); r.destroyed.clear();
    if (r.mode === 'ctf') r.flags = makeFlags();
    for (const c of r.clients.values()) { const p = c.player; p.hp = 100; p.alive = true; p.kills = 0; p.deaths = 0; p.level = 0; p.pos = spawnFor(p.team); p.ry = ryFor(p.team); this.send(c.ws, { t: 'respawn', id: p.id, pos: p.pos }); }
    for (const b of r.bots.values()) { b.hp = 100; b.alive = true; b.kills = 0; b.deaths = 0; b.level = 0; b.pos = spawnFor(b.team); b.ry = ryFor(b.team); this.broadcast(r, { t: 'respawn', id: b.id, pos: b.pos }); }
    this.broadcast(r, { t: 'scores', scores: r.scores });
    this.broadcast(r, { t: 'matchstart', scores: r.scores });
  }

  handleLeave(roomId, id) {
    const r = this.rooms.get(roomId); if (!r) return;
    if (!r.clients.has(id)) return;
    if (r.mode === 'ctf' && r.flags) this.dropFlagIfCarrier(r, r.clients.get(id).player);
    r.clients.delete(id);
    this.broadcast(r, { t: 'leave', id });
    this.balanceBots(r);
    this.broadcast(r, { t: 'roster', count: this.count(r) });
    if (r.clients.size === 0) this.rooms.delete(r.id); // drop empty rooms (and their bots)
  }

  // ============================================================
  // Bots (controlled: fill missing team slots, capped, removed as humans
  // arrive). Simulated server-side; appear to clients as normal remotes.
  // ============================================================
  balanceBots(r) {
    if (!CFG.bots) return;
    if (r.clients.size === 0) { for (const b of [...r.bots.keys()]) this.removeBot(r, b); return; }
    // Fill each team up to the target combatant count. Humans count toward the
    // target, so every human who joins quietly frees exactly one bot slot on
    // their side — the rest of the bots stay in the match.
    for (const team of ['red', 'blue']) {
      let need = CFG.botTeamTarget - this.teamCount(r, team);
      while (need > 0 && r.bots.size < CFG.botCap) { this.addBot(r, team); need--; }
      let over = this.teamCount(r, team) - Math.max(CFG.botTeamTarget, this.humanTeamCount(r, team));
      while (over > 0) {
        const botId = [...r.bots.values()].find(b => b.team === team)?.id;
        if (botId == null) break;
        this.removeBot(r, botId); over--;
      }
    }
  }
  addBot(r, team) {
    const id = this.nextId++;
    // Pick a name nobody in the room is already using (no more "3 Efes").
    const used = new Set(this.entities(r).map(e => e.name));
    const free = CFG.botNames.filter(n => !used.has(n));
    let nm;
    if (free.length) nm = free[Math.floor(Math.random() * free.length)];
    else { let i = 2; do { nm = CFG.botNames[Math.floor(Math.random() * CFG.botNames.length)] + ' ' + i++; } while (used.has(nm)); }
    const pos = spawnFor(team);
    const skill = SKILL[r.diff] || SKILL.normal;
    const agent = Object.keys(AGENTS)[Math.floor(Math.random() * Object.keys(AGENTS).length)];
    const bot = { id, name: nm, team, pos, ry: ryFor(team), rx: 0, anim: 0, hp: 100, alive: true, kills: 0, deaths: 0, level: 0, bot: true, nextShot: 0, wander: Math.random() * Math.PI * 2, repick: 0, respawnAt: 0, skill: skill.min + Math.random() * skill.span, lastHit: 0, agent, dmgTakenMult: AGENTS[agent].dmgTaken, regenMult: AGENTS[agent].regen };
    r.bots.set(id, bot);
    this.broadcast(r, { t: 'join', p: this.pub(bot) });
  }
  removeBot(r, id) { if (r.bots.delete(id)) this.broadcast(r, { t: 'leave', id }); }

  updateBots(r, dt, now) {
    if (r.over) return;
    for (const bot of r.bots.values()) {
      if (!bot.alive) {
        if (now >= bot.respawnAt) { bot.alive = true; bot.hp = 100; bot.pos = spawnFor(bot.team); this.broadcast(r, { t: 'respawn', id: bot.id, pos: bot.pos }); }
        continue;
      }
      let target = null, best = Infinity;
      for (const e of this.entities(r)) {
        if (!e.alive || e.team === bot.team || e.id === bot.id) continue;
        const d = Math.hypot(e.pos.x - bot.pos.x, e.pos.z - bot.pos.z);
        if (d < best) { best = d; target = e; }
      }
      let moving = 0;
      if (target && best < 34) {
        const ang = Math.atan2(-(target.pos.x - bot.pos.x), -(target.pos.z - bot.pos.z));
        bot.ry = ang;
        if (best > 6) { this.stepBot(r, bot, ang, dt); moving = 1; }
        else { this.stepBot(r, bot, ang + Math.PI / 2 * (bot.id % 2 ? 1 : -1), dt * 0.6); moving = 0.6; }
        const w = WEAPON.rifle;
        if (best < w.range && now >= bot.nextShot &&
            losClear(r, bot.pos.x, bot.pos.y + 1.5, bot.pos.z, target.pos.x, target.pos.y + 1.0, target.pos.z)) {
          bot.nextShot = now + w.rate / bot.skill + Math.random() * 260;
          const dir = { x: -Math.sin(ang), y: 0.02, z: -Math.cos(ang) };
          const from = { x: bot.pos.x, y: bot.pos.y + 1.5, z: bot.pos.z };
          this.broadcast(r, { t: 'shoot', id: bot.id, from, dir, w: 'rifle' });
          const acc = Math.max(0.1, Math.min(0.9, (0.6 - best * 0.012) * bot.skill));
          if (Math.random() < acc) {
            const head = Math.random() < 0.12;
            this.applyDamage(r, target, Math.round(w.dmg * (head ? 2 : 1)), bot, head);
          }
        }
      } else {
        if (now >= bot.repick) { bot.repick = now + 1200 + Math.random() * 1600; bot.wander += (Math.random() - 0.5) * 2; }
        this.stepBot(r, bot, bot.wander, dt); moving = 0.6; bot.ry = bot.wander;
      }
      bot.anim = moving;
    }
  }

  // Move a bot toward heading `ang`, following the ground and sliding around
  // walls: if the straight path is blocked, try progressively wider left/right
  // deflections so the bot rounds obstacles instead of grinding into them.
  stepBot(r, bot, ang, dt) {
    const step = 5.0 * dt;
    for (const off of [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6, 2.4, -2.4]) {
      const a = ang + off;
      const nx = clampArena(bot.pos.x - Math.sin(a) * step);
      const nz = clampArena(bot.pos.z - Math.cos(a) * step);
      if (nx === bot.pos.x && nz === bot.pos.z) continue; // clamped at arena edge
      const destFeet = groundTop(nx, nz) + 1;
      if (destFeet - bot.pos.y > 1.25) continue;          // wall too tall this way
      if (bot.pos.y - destFeet > 4) continue;             // don't walk off big drops
      bot.pos.x = nx; bot.pos.z = nz; bot.pos.y = destFeet;
      if (off !== 0) bot.ry = a;                          // face the way we actually moved
      return true;
    }
    bot.repick = 0; // fully boxed in — pick a new heading next wander
    return false;
  }

  ensureTick() {
    if (this.tick) return;
    this.lastTick = Date.now();
    this.tick = setInterval(() => {
      if (this.rooms.size === 0) { clearInterval(this.tick); this.tick = null; return; }
      const now = Date.now();
      const dt = Math.min(0.2, (now - this.lastTick) / 1000);
      this.lastTick = now;
      for (const r of this.rooms.values()) {
        this.updateBots(r, dt, now);
        // auto-respawn dead human players (the client shows a countdown but never asks)
        if (!r.over) for (const c of r.clients.values()) {
          const p = c.player;
          if (!p.alive && p.respawnAt && now >= p.respawnAt) {
            p.alive = true; p.hp = 100; p.pos = spawnFor(p.team); p.ry = ryFor(p.team); p.respawnAt = 0;
            this.broadcast(r, { t: 'respawn', id: p.id, pos: p.pos });
          }
        }
        // Passive health regeneration once an entity has avoided damage a while.
        if (!r.over) for (const e of this.entities(r)) {
          if (!e.alive || e.hp >= 100 || now - (e.lastHit || 0) < CFG.regenDelay) continue;
          const was = Math.round(e.hp);
          e.hp = Math.min(100, e.hp + CFG.regenRate * (e.regenMult || 1) * dt);
          const nowHp = Math.round(e.hp);
          if (!e.bot && nowHp !== was) { const c = r.clients.get(e.id); if (c) this.send(c.ws, { t: 'heal', hp: nowHp }); }
        }
        this.updateFlags(r, now);
        const states = [];
        for (const e of this.entities(r)) { if (!e.alive) continue; states.push({ id: e.id, pos: e.pos, ry: e.ry, rx: e.rx, anim: e.anim, hp: Math.round(e.hp) }); }
        if (states.length) this.broadcast(r, { t: 'states', states, flags: r.mode === 'ctf' && r.flags ? this.flagPub(r) : undefined });
      }
    }, CFG.tick);
  }

  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
  broadcast(r, obj) { const s = JSON.stringify(obj); for (const c of r.clients.values()) { try { c.ws.send(s); } catch {} } }
  broadcastExcept(r, id, obj) { const s = JSON.stringify(obj); for (const [cid, c] of r.clients) { if (cid === id) continue; try { c.ws.send(s); } catch {} } }
}
