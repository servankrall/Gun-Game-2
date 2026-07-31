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
// true if the straight segment a->b is clear of solid voxels (bot line of sight)
function losClear(ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const dist = Math.hypot(dx, dy, dz);
  const steps = Math.ceil(dist / 0.34);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (solid(ax + dx * t, ay + dy * t, az + dz * t)) return false;
  }
  return true;
}

// ============================================================
// Tuning
// ============================================================
const CFG = {
  scoreLimit: 40,          // team kills to win a match
  tick: 50,                // ms between state broadcasts / bot updates
  bots: true,
  botTeamTarget: 3,        // desired combatants (players+bots) per team
  botCap: 6,               // max bots per room
  botNames: ['Ozan', 'Deniz', 'Kaya', 'Ares', 'Bora', 'Cem', 'Efe', 'Mert', 'Rux', 'Zane', 'Nova', 'Kartal'],
};
const WEAPON = { rifle: { dmg: 16, rate: 220, range: 22 } };

function spawnFor(team) {
  const z = Math.random() * 16 - 8;
  const x = team === 'red' ? -28 : 28;
  return { x, y: groundTop(x, z) + 1.1, z };
}
function ryFor(team) { return team === 'red' ? -Math.PI / 2 : Math.PI / 2; }
const clampArena = v => Math.max(-HALF + 1.5, Math.min(HALF - 2.5, v));

export class GameServer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.rooms = new Map();   // roomId -> room
    this.nextId = 1;
    this.tick = null;
    this.lastTick = Date.now();
  }

  room(id) {
    let r = this.rooms.get(id);
    if (!r) {
      r = { id, clients: new Map(), bots: new Map(), scores: { red: 0, blue: 0 }, placed: new Map(), destroyed: new Map(), over: false };
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
    let id = null, roomId = null;
    ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'join') {
        if (id !== null) return;
        roomId = String(m.room || 'pub').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'pub';
        id = this.handleJoin(ws, m, roomId);
        return;
      }
      if (id === null) return;
      this.handleMsg(roomId, id, m);
    });
    const bye = () => { if (id !== null) { this.handleLeave(roomId, id); id = null; } };
    ws.addEventListener('close', bye);
    ws.addEventListener('error', bye);
  }

  // ---- combatant helpers ----
  entities(r) { return [...r.clients.values()].map(c => c.player).concat([...r.bots.values()]); }
  pub(p) { return { id: p.id, name: p.name, team: p.team, pos: p.pos, ry: p.ry, rx: p.rx, anim: p.anim, alive: p.alive, hp: p.hp, kills: p.kills, deaths: p.deaths, bot: !!p.bot }; }
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
    const player = { id, name, team, pos, ry: ryFor(team), rx: 0, anim: 0, hp: 100, alive: true, kills: 0, deaths: 0 };
    r.clients.set(id, { ws, player });

    this.send(ws, {
      t: 'welcome', id, team, pos, ry: player.ry, scores: r.scores, room: roomId, count: this.count(r), scoreLimit: CFG.scoreLimit,
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
        this.applyDamage(r, tgt, Math.max(0, Math.min(300, m.dmg | 0)), p, !!m.head);
        this.send(c.ws, { t: 'hitconfirm', head: !!m.head });
        break;
      }
      case 'place': {
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

  applyDamage(r, tgt, dmg, attacker, head) {
    if (r.over) return;
    tgt.hp -= dmg;
    if (tgt.hp > 0) {
      if (!tgt.bot) { const c = r.clients.get(tgt.id); if (c) this.send(c.ws, { t: 'hp', hp: tgt.hp }); }
      return;
    }
    tgt.hp = 0; tgt.alive = false; tgt.deaths++;
    if (attacker) attacker.kills++;
    tgt.respawnAt = Date.now() + (tgt.bot ? 3000 : 3500); // auto-respawn (client never asks)
    if (attacker) r.scores[attacker.team] = (r.scores[attacker.team] || 0) + 1;
    this.broadcast(r, { t: 'death', victim: tgt.id, killer: attacker ? attacker.id : tgt.id, head });
    this.broadcast(r, { t: 'scores', scores: r.scores });
    if (attacker && r.scores[attacker.team] >= CFG.scoreLimit) this.endMatch(r, attacker.team);
  }

  endMatch(r, winner) {
    r.over = true;
    this.broadcast(r, { t: 'matchover', winner, scores: r.scores });
    setTimeout(() => this.resetMatch(r), 6000);
  }
  resetMatch(r) {
    if (!this.rooms.has(r.id)) return;
    r.over = false;
    r.scores = { red: 0, blue: 0 };
    r.placed.clear(); r.destroyed.clear();
    for (const c of r.clients.values()) { const p = c.player; p.hp = 100; p.alive = true; p.kills = 0; p.deaths = 0; p.pos = spawnFor(p.team); p.ry = ryFor(p.team); this.send(c.ws, { t: 'respawn', id: p.id, pos: p.pos }); }
    for (const b of r.bots.values()) { b.hp = 100; b.alive = true; b.kills = 0; b.deaths = 0; b.pos = spawnFor(b.team); b.ry = ryFor(b.team); this.broadcast(r, { t: 'respawn', id: b.id, pos: b.pos }); }
    this.broadcast(r, { t: 'scores', scores: r.scores });
    this.broadcast(r, { t: 'matchstart', scores: r.scores });
  }

  handleLeave(roomId, id) {
    const r = this.rooms.get(roomId); if (!r) return;
    if (!r.clients.has(id)) return;
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
    const nm = CFG.botNames[Math.floor(Math.random() * CFG.botNames.length)];
    const pos = spawnFor(team);
    const bot = { id, name: nm, team, pos, ry: ryFor(team), rx: 0, anim: 0, hp: 100, alive: true, kills: 0, deaths: 0, bot: true, nextShot: 0, wander: Math.random() * Math.PI * 2, repick: 0, respawnAt: 0 };
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
            losClear(bot.pos.x, bot.pos.y + 1.5, bot.pos.z, target.pos.x, target.pos.y + 1.0, target.pos.z)) {
          bot.nextShot = now + w.rate + Math.random() * 260;
          const dir = { x: -Math.sin(ang), y: 0.02, z: -Math.cos(ang) };
          const from = { x: bot.pos.x, y: bot.pos.y + 1.5, z: bot.pos.z };
          this.broadcast(r, { t: 'shoot', id: bot.id, from, dir, w: 'rifle' });
          const acc = Math.max(0.12, 0.62 - best * 0.012);
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

  // move a bot in heading `ang` with simple ground-follow + wall avoidance
  stepBot(r, bot, ang, dt) {
    const speed = 5.0;
    const fx = -Math.sin(ang), fz = -Math.cos(ang);
    const nx = clampArena(bot.pos.x + fx * speed * dt);
    const nz = clampArena(bot.pos.z + fz * speed * dt);
    const destFeet = groundTop(nx, nz) + 1;
    if (destFeet - bot.pos.y > 1.25) { bot.repick = 0; return; } // wall too tall — bail, repick heading
    bot.pos.x = nx; bot.pos.z = nz; bot.pos.y = destFeet;
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
        const states = [];
        for (const e of this.entities(r)) { if (!e.alive) continue; states.push({ id: e.id, pos: e.pos, ry: e.ry, rx: e.rx, anim: e.anim, hp: e.hp }); }
        if (states.length) this.broadcast(r, { t: 'states', states });
      }
    }, CFG.tick);
  }

  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
  broadcast(r, obj) { const s = JSON.stringify(obj); for (const c of r.clients.values()) { try { c.ws.send(s); } catch {} } }
  broadcastExcept(r, id, obj) { const s = JSON.stringify(obj); for (const [cid, c] of r.clients) { if (cid === id) continue; try { c.ws.send(s); } catch {} } }
}
