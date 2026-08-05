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
const MAPS = ['desert', 'arctic', 'volcano', 'night', 'metro', 'toxic'];
const randomMap = () => MAPS[Math.floor(Math.random() * MAPS.length)];
function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function mapSeed(id) { let h = 2166136261; const s = String(id); for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
const MAP_STYLE = {
  desert:  { ground: 'sand',  speckle: ['gravel', 'dirt'],  pillar: 'cobble', wall: 'bricks', roof: 'planks' },
  arctic:  { ground: 'sand',  speckle: ['stone', 'cobble'], pillar: 'stone',  wall: 'stone',  roof: 'planks' },
  volcano: { ground: 'gravel', speckle: ['stone', 'cobble'], pillar: 'cobble', wall: 'cobble', roof: 'gravel' },
  night:   { ground: 'stone', speckle: ['cobble', 'gravel'], pillar: 'bricks', wall: 'bricks', roof: 'planks' },
  metro:   { ground: 'stone', speckle: ['cobble', 'gravel'], pillar: 'stone',  wall: 'cobble', roof: 'planks' },
  toxic:   { ground: 'grass', speckle: ['dirt', 'leaves'],  pillar: 'log',    wall: 'stone',  roof: 'leaves' },
};
function scatterCover(r, style, box, count, maxH) {
  for (let i = 0; i < count; i++) {
    const cx = 6 + Math.floor(r() * 14), cz = Math.floor(r() * 52) - 26, len = 2 + Math.floor(r() * 3), alongX = r() < 0.5;
    if (cx <= 9 && Math.abs(cz) <= 9) continue;
    if (Math.abs(cz) >= 13 && Math.abs(cz) <= 16) continue;
    for (let j = 0; j < len; j++) {
      const h = 1 + Math.floor(r() * maxH), bx = alongX ? cx + j : cx, bz = alongX ? cz : cz + j;
      if (Math.abs(bx) > 24 || Math.abs(bz) > 29) continue;
      box(bx, 1, bz, bx, h, bz, style.wall); box(-bx - 1, 1, bz, -bx - 1, h, bz, style.wall);
    }
  }
}
function buildCentre(mapId, style, r, h) {
  const { set, box, carve } = h;
  if (mapId === 'desert') {
    for (let y = 1; y <= 5; y++) { const B = 8 - y; for (let x = -B; x <= B; x++) for (let z = -B; z <= B; z++) set(x, y, z, y === 1 ? 'cobble' : (r() < 0.22 ? 'cobble' : 'sand')); }
    carve(-3, 1, -3, 3, 3, 3); carve(-7, 1, -1, 7, 2, 1); carve(-1, 1, -7, 1, 2, 7); carve(0, 1, 0, 0, 5, 0);
    [[-3, -3], [-3, 3], [3, -3], [3, 3], [0, 3], [0, -3], [3, 0], [-3, 0]].forEach(([x, z]) => { if (x || z) set(x, 6, z, 'cobble'); });
    set(-2, 1, 2, 'redWool'); set(2, 1, -2, 'blueWool');
    [[11, 4, 4], [8, 9, 4], [4, 11, 3]].forEach(([px, pz, ph]) => [[px, pz], [-px - 1, pz]].forEach(([x, z]) => { box(x, 1, z, x, ph, z, style.pillar); set(x, ph + 1, z, 'leaves'); }));
    scatterCover(r, style, box, 8, 3);
  } else if (mapId === 'arctic') {
    box(-7, 1, -7, 7, 4, 7, style.wall); carve(-6, 1, -6, 6, 4, 6);
    carve(-7, 1, -1, 7, 2, 1); carve(-1, 1, -7, 1, 2, 7);
    [[-7, -7], [7, -7], [-7, 7], [7, 7]].forEach(([x, z]) => box(x < 0 ? x - 1 : x, 1, z < 0 ? z - 1 : z, x < 0 ? x : x + 1, 6, z < 0 ? z : z + 1, style.pillar));
    for (let x = -7; x <= 7; x += 2) { set(x, 5, -7, style.roof); set(x, 5, 7, style.roof); }
    for (let z = -7; z <= 7; z += 2) { set(-7, 5, z, style.roof); set(7, 5, z, style.roof); }
    set(0, 1, 0, 'redWool'); set(1, 1, 0, 'blueWool');
    scatterCover(r, style, box, 10, 3);
  } else if (mapId === 'volcano') {
    for (let y = 1; y <= 6; y++) { const B = 9 - y; for (let x = -B; x <= B; x++) for (let z = -B; z <= B; z++) if (Math.hypot(x, z) <= B + 0.3) set(x, y, z, r() < 0.3 ? 'gravel' : 'cobble'); }
    carve(-1, 4, -1, 1, 6, 1); box(-1, 4, -1, 1, 4, 1, 'redWool'); set(0, 5, 0, 'redWool');
    [[12, 6], [7, 12], [14, -8], [-9, 10]].forEach(([px, pz]) => { const ph = 2 + Math.floor(r() * 4); box(px, 1, pz, px, ph, pz, style.pillar); box(-px - 1, 1, pz, -px - 1, ph, pz, style.pillar); });
    scatterCover(r, style, box, 9, 2);
  } else if (mapId === 'night') {
    const bld = (x, z, w, d, ht) => { box(x, 1, z, x + w, ht, z + d, style.wall); carve(x + 1, 1, z + 1, x + w - 1, ht - 1, z + d - 1); box(x, ht + 1, z, x + w, ht + 1, z + d, style.roof); };
    [[-9, -9, 6, 6, 6], [3, -10, 5, 5, 8], [-10, 3, 5, 6, 5], [4, 4, 6, 6, 7]].forEach(([x, z, w, d, ht]) => bld(x, z, w, d, ht));
    scatterCover(r, style, box, 12, 3);
  } else if (mapId === 'metro') {
    for (let gx = -12; gx <= 8; gx += 8) for (let gz = -12; gz <= 8; gz += 8) {
      if (Math.abs(gx + 2) <= 3 && Math.abs(gz + 2) <= 3) continue;
      const ht = 2 + Math.floor(r() * 2);
      box(gx, 1, gz, gx + 4, ht, gz + 3, r() < 0.5 ? style.wall : style.pillar);
    }
    box(-9, 4, -1, 9, 4, 1, style.roof); box(-9, 1, -1, -9, 4, 1, style.pillar); box(9, 1, -1, 9, 4, 1, style.pillar);
    scatterCover(r, style, box, 10, 3);
  } else {
    for (let y = 1; y <= 4; y++) { const B = 6 - y; for (let x = -B; x <= B; x++) for (let z = -B; z <= B; z++) if (Math.hypot(x, z) <= B + 0.4 && r() < 0.9) set(x, y, z, y >= 3 ? 'leaves' : 'dirt'); }
    const tree = (px, pz, ht) => { box(px, 1, pz, px, ht, pz, 'log'); set(px, ht + 1, pz, 'leaves'); };
    [[10, 8], [8, -11], [-12, 9], [13, -6], [-8, -12]].forEach(([px, pz]) => { tree(px, pz, 2 + Math.floor(r() * 3)); tree(-px - 1, pz, 2 + Math.floor(r() * 3)); });
    for (let i = 0; i < 10; i++) { const cx = 6 + Math.floor(r() * 16), cz = Math.floor(r() * 50) - 25; if (Math.hypot(cx, cz) < 8) continue; box(cx, 1, cz, cx + 1, 1, cz + 1, 'dirt'); box(-cx - 2, 1, cz, -cx - 1, 1, cz + 1, 'dirt'); }
    scatterCover(r, style, box, 7, 2);
  }
}
function buildMapBlocks(mapId) {
  const style = MAP_STYLE[mapId] || MAP_STYLE.desert;
  const m = new Map();
  const set = (x, y, z, type) => m.set(`${x},${y},${z}`, { x, y, z, type });
  const del = (x, y, z) => m.delete(`${x},${y},${z}`);
  const box = (x0, y0, z0, x1, y1, z1, type) => { for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) set(x, y, z, type); };
  const carve = (x0, y0, z0, x1, y1, z1) => { for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) del(x, y, z); };
  const r = seededRng(mapSeed(mapId));
  for (let x = -HALF; x < HALF; x++) for (let z = -HALF; z < HALF; z++) { let t = style.ground; const v = r(); if (v < 0.05) t = style.speckle[0]; else if (v < 0.07) t = style.speckle[1]; set(x, 0, z, t); }
  for (let i = -HALF - 1; i <= HALF; i++) for (let y = 0; y <= 5; y++) { set(i, y, -HALF - 1, 'bedrock'); set(i, y, HALF, 'bedrock'); set(-HALF - 1, y, i, 'bedrock'); set(HALF, y, i, 'bedrock'); }
  buildCentre(mapId, style, r, { set, del, box, carve });
  for (let z = -12; z <= 12; z++) for (let x = 26; x <= 30; x++) { set(-x, 0, z, 'redWool'); set(x, 0, z, 'blueWool'); }
  for (let z = -9; z <= 9; z++) { if ((z + 9) % 4 === 3) continue; box(-24, 1, z, -24, 2, z, 'redWool'); box(23, 1, z, 23, 2, z, 'blueWool'); }
  [[-28, 'redWool'], [27, 'blueWool']].forEach(([bx, wool]) => { box(bx - 2, 1, -16, bx + 2, 3, -16, wool); box(bx - 2, 1, 16, bx + 2, 3, 16, wool); });
  return [...m.values()];
}

// Build a room's solid-voxel Set + per-column ground height for its map.
function buildRoomMap(mapId) {
  const solid = new Set(), ground = new Map();
  for (const b of buildMapBlocks(mapId)) {
    solid.add(`${b.x},${b.y},${b.z}`);
    const k = `${b.x},${b.z}`, cur = ground.get(k);
    if (cur === undefined || b.y > cur) ground.set(k, b.y);
  }
  return { solid, ground };
}
const groundTop = (r, x, z) => { const v = r.ground.get(`${Math.floor(x)},${Math.floor(z)}`); return v === undefined ? -1 : v; };
// Room-aware solidity: the static map, minus destroyed, plus player-built blocks.
function solidRoom(r, x, y, z) {
  const k = `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
  if (r.placed.has(k)) return true;
  if (r.destroyed.has(k)) return false;
  return r.solid.has(k);
}
function losClear(r, ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const dist = Math.hypot(dx, dy, dz);
  const steps = Math.ceil(dist / 0.34);
  for (let i = 1; i < steps; i++) { const t = i / steps; if (solidRoom(r, ax + dx * t, ay + dy * t, az + dz * t)) return false; }
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
  domLimit: 100,           // Domination points to win a match
};
// Domination: a single central hill. Stand in it (with no enemy present) to
// capture it, then hold it to bank points over time.
const ZONE_CX = 0, ZONE_CZ = 0, ZONE_R = 8, ZONE_CAP_SECONDS = 5;
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

function spawnFor(r, team) {
  const z = Math.random() * 16 - 8;
  const x = team === 'red' ? -28 : 28;
  return { x, y: groundTop(r, x, z) + 1.1, z };
}
function ryFor(team) { return team === 'red' ? -Math.PI / 2 : Math.PI / 2; }
// CTF flag home positions (inside each base, within the no-build zone so they
// can't be walled in). Each flag: home, current pos, carrier id, atHome, dropAt.
function makeFlags(r) {
  const z = 0, home = (x) => ({ x, y: groundTop(r, x, z) + 0.5, z });
  const rh = home(-26), bh = home(26);
  return {
    red:  { home: rh, pos: { ...rh }, carrier: null, atHome: true, dropAt: 0 },
    blue: { home: bh, pos: { ...bh }, carrier: null, atHome: true, dropAt: 0 },
  };
}
const clampArena = v => Math.max(-HALF + 1.5, Math.min(HALF - 2.5, v));

// Rank tier from account stats (must match the client's rankOf tiers).
function rankTier(wins, kills) {
  const xp = (wins || 0) * 100 + (kills || 0) * 5;
  const T = [[0, 'BRONZE'], [300, 'SILVER'], [900, 'GOLD'], [2000, 'PLATINUM'], [4000, 'DIAMOND'], [8000, 'MASTER']];
  let t = 'BRONZE'; for (const [th, n] of T) if (xp >= th) t = n; return t;
}

// Health packs at fixed open spots (same on every map). Walk over one at <100 HP
// to heal; it respawns after a delay.
const PICKUP_SPOTS = [[0, 16], [0, -16], [16, 0], [-16, 0]];
const SUPPLY_SPOTS = [[10, -10], [-10, 10]]; // grenade + block resupply
const PICKUP_HEAL = 40, PICKUP_RESPAWN = 12000;
function makePickups(r) {
  // Ground surface sits at groundTop+1 (a block at y occupies [y,y+1]); float the
  // pack ~0.4 above it so it isn't buried under the map.
  const health = PICKUP_SPOTS.map(([x, z]) => ({ x, y: groundTop(r, x, z) + 1.4, z, active: true, respawnAt: 0, type: 'health' }));
  const supply = SUPPLY_SPOTS.map(([x, z]) => ({ x, y: groundTop(r, x, z) + 1.4, z, active: true, respawnAt: 0, type: 'supply' }));
  return health.concat(supply);
}

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
  presenceOnline(pid, name, room, ws) {
    let e = this.online.get(pid);
    if (!e) { e = { name, room, socks: new Set() }; this.online.set(pid, e); }
    e.name = name || e.name; e.room = room; e.socks.add(ws);
  }
  presenceOffline(pid, ws) {
    const e = this.online.get(pid); if (!e) return;
    e.socks.delete(ws); if (!e.socks.size) this.online.delete(pid);
  }
  pushToUser(user, obj) { const e = this.online.get(String(user).toLowerCase()); if (!e) return; for (const ws of e.socks) this.send(ws, obj); }
  presenceQuery(pids) {
    const out = {};
    for (const pid of pids) { const k = String(pid).toLowerCase(); const e = this.online.get(k); if (e) out[pid] = { name: e.name, room: e.room }; }
    return out;
  }

  // ---- accounts (persisted in DO storage online; in-memory in the offline build) ----
  async _get(k) { if (this.ctx?.storage) return await this.ctx.storage.get(k); this._mem ||= new Map(); return this._mem.get(k); }
  async _put(k, v) { if (this.ctx?.storage) return await this.ctx.storage.put(k, v); this._mem ||= new Map(); this._mem.set(k, v); }
  randHex(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2, '0')).join(''); }
  async hashPass(pass, salt) {
    const msg = salt + ':' + pass;
    if (crypto?.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg));
      return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    }
    let h = 5381; for (let i = 0; i < msg.length; i++) h = ((h << 5) + h + msg.charCodeAt(i)) | 0; // fallback (non-secure ctx)
    return 'x' + (h >>> 0).toString(16);
  }
  profileOf(a) { return { coins: a.coins || 0, unlocked: a.unlocked || ['soldier'], friends: a.friends || [], wins: a.wins || 0, kills: a.kills || 0, requests: a.requests || [], lastDaily: a.lastDaily || 0 }; }
  async _list(prefix) { // works for DO storage and the in-memory offline fallback
    if (this.ctx?.storage) { const map = await this.ctx.storage.list({ prefix }); return [...map.values()]; }
    this._mem ||= new Map(); const out = []; for (const [k, v] of this._mem) if (k.startsWith(prefix)) out.push(v); return out;
  }
  async register(user, pass) {
    user = String(user || '').trim().toLowerCase().slice(0, 16);
    if (!/^[a-z0-9_]{3,16}$/.test(user)) return { ok: false, error: 'Username: 3-16 letters/numbers/_' };
    if (String(pass || '').length < 4) return { ok: false, error: 'Password too short (min 4)' };
    if (await this._get('acct:' + user)) return { ok: false, error: 'Username taken' };
    const salt = this.randHex(8);
    const acct = { user, salt, hash: await this.hashPass(pass, salt), coins: 0, unlocked: ['soldier'], friends: [], requests: [], wins: 0, kills: 0, lastDaily: 0 };
    await this._put('acct:' + user, acct);
    const token = this.randHex(16); await this._put('tok:' + token, user);
    return { ok: true, user, token, profile: this.profileOf(acct) };
  }
  async login(user, pass) {
    user = String(user || '').trim().toLowerCase().slice(0, 16);
    const acct = await this._get('acct:' + user);
    if (!acct) return { ok: false, error: 'No such account' };
    if (await this.hashPass(pass, acct.salt) !== acct.hash) return { ok: false, error: 'Wrong password' };
    const token = this.randHex(16); await this._put('tok:' + token, user);
    return { ok: true, user, token, profile: this.profileOf(acct) };
  }
  async byToken(token) { const user = await this._get('tok:' + String(token || '')); if (!user) return null; return (await this._get('acct:' + user)) || null; }
  async saveProfile(token, coins, unlocked, friends) {
    const user = await this._get('tok:' + String(token || '')); if (!user) return;
    const acct = await this._get('acct:' + user); if (!acct) return;
    if (Number.isFinite(coins)) acct.coins = Math.max(0, Math.min(1e9, coins | 0));
    if (Array.isArray(unlocked)) acct.unlocked = unlocked.slice(0, 60).map(String);
    if (Array.isArray(friends)) acct.friends = friends.slice(0, 200);
    await this._put('acct:' + user, acct);
  }
  async userByToken(token) { return (await this._get('tok:' + String(token || ''))) || null; }
  async friendRequest(token, to) {
    const from = await this.userByToken(token); if (!from) return { ok: false, error: 'log in first' };
    to = String(to || '').trim().toLowerCase().slice(0, 16);
    if (!to || to === from) return { ok: false, error: 'invalid user' };
    const tAcct = await this._get('acct:' + to); if (!tAcct) return { ok: false, error: 'no such user' };
    const fAcct = await this._get('acct:' + from);
    if ((fAcct.friends || []).includes(to)) return { ok: false, error: 'already friends' };
    tAcct.requests = tAcct.requests || [];
    if (!tAcct.requests.includes(from)) { tAcct.requests.push(from); await this._put('acct:' + to, tAcct); }
    this.pushToUser(to, { t: 'friend_req_in', from });
    return { ok: true, to };
  }
  async friendAccept(token, from) {
    const me = await this.userByToken(token); if (!me) return { ok: false };
    from = String(from || '').toLowerCase().slice(0, 16);
    const meAcct = await this._get('acct:' + me), fAcct = await this._get('acct:' + from);
    if (!meAcct || !fAcct) return { ok: false };
    meAcct.requests = (meAcct.requests || []).filter(x => x !== from);
    meAcct.friends = meAcct.friends || []; if (!meAcct.friends.includes(from)) meAcct.friends.push(from);
    fAcct.friends = fAcct.friends || []; if (!fAcct.friends.includes(me)) fAcct.friends.push(me);
    await this._put('acct:' + me, meAcct); await this._put('acct:' + from, fAcct);
    this.pushToUser(from, { t: 'friend_added', user: me });
    return { ok: true, friends: meAcct.friends, requests: meAcct.requests };
  }
  async friendDecline(token, from) {
    const me = await this.userByToken(token); if (!me) return { ok: false };
    from = String(from || '').toLowerCase().slice(0, 16);
    const meAcct = await this._get('acct:' + me); if (!meAcct) return { ok: false };
    meAcct.requests = (meAcct.requests || []).filter(x => x !== from);
    await this._put('acct:' + me, meAcct);
    return { ok: true, friends: meAcct.friends || [], requests: meAcct.requests };
  }
  async dailyClaim(token) {
    const user = await this.userByToken(token); if (!user) return { ok: false, error: 'log in to claim' };
    const acct = await this._get('acct:' + user); if (!acct) return { ok: false };
    const now = Date.now(), DAY = 86400000;
    if (now - (acct.lastDaily || 0) < DAY) return { ok: false, error: 'already claimed today', next: (acct.lastDaily || 0) + DAY };
    const reward = 100;
    acct.coins = (acct.coins || 0) + reward; acct.lastDaily = now;
    await this._put('acct:' + user, acct);
    return { ok: true, reward, coins: acct.coins };
  }
  async leaderboard() {
    const accts = await this._list('acct:');
    return accts.map(a => ({ user: a.user, wins: a.wins || 0, kills: a.kills || 0, coins: a.coins || 0 }))
      .sort((x, y) => (y.wins - x.wins) || (y.kills - x.kills) || (y.coins - x.coins)).slice(0, 10);
  }
  // At match end, credit logged-in players: +1 win to the winners, and everyone's
  // match kills toward their lifetime total (drives rank).
  awardStats(r, winnerTeam, winnerName) {
    for (const c of r.clients.values()) {
      const p = c.player; if (!p.acct) continue;
      const won = winnerName ? (p.name === winnerName) : (p.team === winnerTeam);
      const kills = p.kills || 0;
      this._get('acct:' + p.acct).then(a => { if (a) { if (won) a.wins = (a.wins || 0) + 1; a.kills = (a.kills || 0) + kills; this._put('acct:' + p.acct, a); } }).catch(() => {});
    }
  }

  room(id) {
    let r = this.rooms.get(id);
    if (!r) {
      const map = randomMap(); // maps are random, not player-chosen
      r = { id, clients: new Map(), bots: new Map(), scores: { red: 0, blue: 0 }, placed: new Map(), destroyed: new Map(), over: false, mode: 'dm', flags: null, map, ...buildRoomMap(map) };
      r.pickups = makePickups(r);
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
    let id = null, roomId = null, pid = null;
    ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'hello') { // lobby presence (menu, no game join)
        pid = String(m.pid || '').toLowerCase().slice(0, 16) || null;
        if (pid) this.presenceOnline(pid, String(m.name || 'Player').slice(0, 16), 'lobby', ws);
        return;
      }
      if (m.t === 'presence_req') {
        this.send(ws, { t: 'presence', online: this.presenceQuery((Array.isArray(m.pids) ? m.pids : []).slice(0, 50)) });
        return;
      }
      if (m.t === 'register' || m.t === 'login') {
        (m.t === 'register' ? this.register(m.user, m.pass) : this.login(m.user, m.pass))
          .then(res => { if (res.ok) pid = res.user; this.send(ws, { t: 'auth', ...res }); })
          .catch(() => this.send(ws, { t: 'auth', ok: false, error: 'server error' }));
        return;
      }
      if (m.t === 'auth_token') {
        this.byToken(m.token).then(acct => {
          if (acct) { pid = acct.user; this.send(ws, { t: 'auth', ok: true, user: acct.user, token: m.token, profile: this.profileOf(acct) }); }
          else this.send(ws, { t: 'auth', ok: false, error: 'session expired' });
        }).catch(() => {});
        return;
      }
      if (m.t === 'acct_save') { this.saveProfile(m.token, m.coins, m.unlocked, m.friends); return; }
      if (m.t === 'friend_request') { this.friendRequest(m.token, m.to).then(r => this.send(ws, { t: 'friend_request_res', ...r })).catch(() => {}); return; }
      if (m.t === 'friend_accept') { this.friendAccept(m.token, m.from).then(r => this.send(ws, { t: 'friend_update', ...r })).catch(() => {}); return; }
      if (m.t === 'friend_decline') { this.friendDecline(m.token, m.from).then(r => this.send(ws, { t: 'friend_update', ...r })).catch(() => {}); return; }
      if (m.t === 'daily_claim') { this.dailyClaim(m.token).then(r => this.send(ws, { t: 'daily', ...r })).catch(() => {}); return; }
      if (m.t === 'leaderboard') { this.leaderboard().then(list => this.send(ws, { t: 'leaderboard', list })).catch(() => {}); return; }
      if (m.t === 'join') {
        if (id !== null) return;
        roomId = String(m.room || 'pub').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'pub';
        pid = String(m.pid || pid || '').toLowerCase().slice(0, 16) || null;
        id = this.handleJoin(ws, m, roomId);
        if (pid) this.presenceOnline(pid, String(m.name || 'Player').slice(0, 16), roomId, ws);
        return;
      }
      if (id === null) return;
      this.handleMsg(roomId, id, m);
    });
    const bye = () => {
      if (id !== null) { this.handleLeave(roomId, id); id = null; }
      if (pid) { this.presenceOffline(pid, ws); }
    };
    ws.addEventListener('close', bye);
    ws.addEventListener('error', bye);
  }

  // ---- combatant helpers ----
  entities(r) { return [...r.clients.values()].map(c => c.player).concat([...r.bots.values()]); }
  pub(p) { return { id: p.id, name: p.name, team: p.team, pos: p.pos, ry: p.ry, rx: p.rx, anim: p.anim, alive: p.alive, hp: p.hp, kills: p.kills, deaths: p.deaths, bot: !!p.bot, agent: p.agent || 'soldier', color: p.color, rankTier: p.rankTier }; }
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
    const pos = spawnFor(r, team);
    const agent = agentOf(m.agent);
    const player = { id, name, team, pos, ry: ryFor(team), rx: 0, anim: 0, hp: 100, alive: true, kills: 0, deaths: 0, lastHit: 0, level: 0,
      acct: m.acct ? String(m.acct).toLowerCase().slice(0, 16) : null,
      color: (typeof m.color === 'number' && m.color >= 0 && m.color <= 0xffffff) ? (m.color | 0) : null,
      agent, dmgTakenMult: AGENTS[agent].dmgTaken, regenMult: AGENTS[agent].regen };
    r.clients.set(id, { ws, player });
    // First player in a room sets only the game mode; the map is random (set at
    // room creation) and bot difficulty is mixed per-bot.
    if (r.clients.size === 1) {
      if (m.mode === 'ctf') { r.mode = 'ctf'; r.flags = makeFlags(r); }
      else if (m.mode === 'gg') { r.mode = 'gg'; }
      else if (m.mode === 'dom') { r.mode = 'dom'; r.zone = { owner: null, cap: 0, capTeam: null, accum: 0, contested: false }; }
    }

    this.send(ws, {
      t: 'welcome', id, team, pos, ry: player.ry, scores: r.scores, room: roomId, count: this.count(r),
      mode: r.mode, map: r.map, limit: r.mode === 'ctf' ? CFG.captureLimit : r.mode === 'gg' ? GG_LADDER.length : r.mode === 'dom' ? CFG.domLimit : CFG.scoreLimit,
      flags: r.flags ? this.flagPub(r) : undefined,
      zone: r.mode === 'dom' && r.zone ? this.zonePub(r) : undefined,
      pickups: r.pickups.map(p => ({ x: p.x, y: p.y, z: p.z, active: p.active, type: p.type })),
      players: this.entities(r).filter(e => e.id !== id).map(e => this.pub(e)),
      placed: [...r.placed.values()], destroyed: [...r.destroyed.values()],
    });
    this.broadcastExcept(r, id, { t: 'join', p: this.pub(player) });
    // logged-in players show their rank above their name (loaded async)
    if (player.acct) this._get('acct:' + player.acct).then(a => {
      if (a && r.clients.has(id)) { player.rankTier = rankTier(a.wins, a.kills); this.broadcast(r, { t: 'rank', id, tier: player.rankTier }); }
    }).catch(() => {});
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
        p.alive = true; p.hp = 100; p.pos = spawnFor(r, p.team); p.ry = ryFor(p.team); p.rx = 0;
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
      case 'whisper': { // private message to one player by name (/w name msg)
        const to = String(m.to || '').slice(0, 16), text = String(m.text || '').slice(0, 120);
        if (!text) break;
        const tgt = [...r.clients.values()].find(x => x.player.name.toLowerCase() === to.toLowerCase());
        if (!tgt) { this.send(c.ws, { t: 'chat', name: '*', team: p.team, text: `no player "${to}" here`, whisper: true }); break; }
        this.send(tgt.ws, { t: 'chat', name: p.name + ' →you', team: p.team, text, whisper: true });
        this.send(c.ws, { t: 'chat', name: 'you→ ' + tgt.player.name, team: p.team, text, whisper: true });
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
    if (tgt.shieldUntil && tgt.shieldUntil > Date.now()) dmg = Math.max(1, Math.round(dmg * 0.55)); // overshield reward absorbs 45%
    tgt.hp -= dmg;
    tgt.lastHit = Date.now(); // resets the regen delay
    if (tgt.hp > 0) {
      if (!tgt.bot) { const c = r.clients.get(tgt.id); if (c) this.send(c.ws, { t: 'hp', hp: tgt.hp, from: attacker ? { x: attacker.pos.x, z: attacker.pos.z } : undefined }); }
      return;
    }
    tgt.hp = 0; tgt.alive = false; tgt.deaths++;
    tgt.streak = 0; tgt.shieldUntil = 0; // dying breaks your streak and shield
    if (attacker) {
      attacker.kills++;
      attacker.streak = (attacker.streak || 0) + 1;
      const s = attacker.streak;
      // Kill-streak rewards for climbing without dying: heal to full every 3rd kill,
      // and a 10s overshield (45% damage absorption) every 5th kill.
      if (s % 3 === 0 && attacker.alive) {
        attacker.hp = 100; attacker.lastHit = 0;
        if (!attacker.bot) { const c = r.clients.get(attacker.id); if (c) this.send(c.ws, { t: 'heal', hp: 100, streak: s }); }
      }
      if (s % 5 === 0 && attacker.alive) {
        attacker.shieldUntil = Date.now() + 10000;
        if (!attacker.bot) { const c = r.clients.get(attacker.id); if (c) this.send(c.ws, { t: 'buff', kind: 'overshield', ms: 10000, streak: s }); }
      }
    }
    tgt.respawnAt = Date.now() + (tgt.bot ? 3000 : 3500); // auto-respawn (client never asks)
    if (r.mode === 'ctf' && r.flags) this.dropFlagIfCarrier(r, tgt); // drop the flag where they fell
    // Deathmatch kills score for the team; CTF scores only on captures; Gun Game
    // tracks individual weapon-ladder progress instead of team score.
    if (r.mode === 'dm' && attacker) r.scores[attacker.team] = (r.scores[attacker.team] || 0) + 1;
    this.broadcast(r, { t: 'death', victim: tgt.id, killer: attacker ? attacker.id : tgt.id, head, w: weapon || 'rifle' });
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

  // Domination hill state for the client HUD/visual.
  zonePub(r) {
    const z = r.zone;
    return { owner: z.owner, cap: Math.max(0, Math.min(1, z.cap / ZONE_CAP_SECONDS)), capTeam: z.capTeam, contested: z.contested };
  }
  // Tick the central hill: capture when one team holds it alone, then bank points.
  updateZone(r, dt) {
    if (r.mode !== 'dom' || !r.zone || r.over) return;
    const z = r.zone; let red = 0, blue = 0;
    for (const e of this.entities(r)) {
      if (!e.alive) continue;
      const dx = e.pos.x - ZONE_CX, dz = e.pos.z - ZONE_CZ;
      if (dx * dx + dz * dz <= ZONE_R * ZONE_R) { if (e.team === 'red') red++; else if (e.team === 'blue') blue++; }
    }
    // Majority rule: whichever team has more bodies in the ring controls it.
    // (Requiring the enemy to be fully absent made the hill a permanent scrum.)
    const holder = red > blue ? 'red' : blue > red ? 'blue' : null;
    z.contested = red > 0 && blue > 0 && red === blue;
    if (holder && holder !== z.owner) {
      if (z.capTeam !== holder) { z.capTeam = holder; z.cap = 0; }
      z.cap += dt;
      if (z.cap >= ZONE_CAP_SECONDS) {
        z.owner = holder; z.cap = 0; z.capTeam = null; z.accum = 0;
        this.broadcast(r, { t: 'zone', ev: 'capture', team: holder });
      }
    } else if (holder === z.owner) {
      z.cap = 0; z.capTeam = null; // owner reasserting majority — meter idle
    }
    // Owner banks points unless the enemy currently holds the majority (capturing).
    const enemyTeam = z.owner === 'red' ? 'blue' : 'red';
    if (z.owner && holder !== enemyTeam) {
      z.accum = (z.accum || 0) + dt;
      while (z.accum >= 1) {
        z.accum -= 1;
        r.scores[z.owner] = (r.scores[z.owner] || 0) + 2;
        this.broadcast(r, { t: 'scores', scores: r.scores });
        if (r.scores[z.owner] >= CFG.domLimit) { this.endMatch(r, z.owner); return; }
      }
    }
  }
  dropFlagIfCarrier(r, ent) {
    for (const t of ['red', 'blue']) {
      const f = r.flags[t];
      if (f.carrier === ent.id) {
        f.carrier = null; f.atHome = false; f.dropAt = Date.now();
        f.pos = { x: ent.pos.x, y: groundTop(r, ent.pos.x, ent.pos.z) + 0.5, z: ent.pos.z };
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

  // Health packs: heal a hurt player who walks over an active pack, then respawn it.
  updatePickups(r, now) {
    if (r.over || !r.pickups) return;
    for (let i = 0; i < r.pickups.length; i++) {
      const pk = r.pickups[i];
      if (!pk.active) { if (now >= pk.respawnAt) { pk.active = true; this.broadcast(r, { t: 'pickup', i, active: true }); } continue; }
      for (const c of r.clients.values()) {
        const p = c.player;
        if (!p.alive) continue;
        const near = (p.pos.x - pk.x) ** 2 + (p.pos.z - pk.z) ** 2 < 1.6 && Math.abs(p.pos.y - pk.y) < 2.2;
        if (!near) continue;
        if (pk.type === 'supply') {
          pk.active = false; pk.respawnAt = now + PICKUP_RESPAWN;
          this.send(c.ws, { t: 'supply' }); // client refills its own grenades + blocks
          this.broadcast(r, { t: 'pickup', i, active: false });
          break;
        } else {
          if (p.hp >= 100) continue;
          p.hp = Math.min(100, p.hp + PICKUP_HEAL); p.lastHit = now;
          pk.active = false; pk.respawnAt = now + PICKUP_RESPAWN;
          this.send(c.ws, { t: 'heal', hp: Math.round(p.hp) });
          this.broadcast(r, { t: 'pickup', i, active: false });
          break;
        }
      }
    }
  }

  endMatch(r, winner, winnerName) {
    r.over = true;
    this.awardStats(r, winner, winnerName); // credit wins + kills to logged-in players' accounts
    this.broadcast(r, { t: 'matchover', winner, winnerName: winnerName || null, scores: r.scores });
    setTimeout(() => this.resetMatch(r), 6000);
  }
  resetMatch(r) {
    if (!this.rooms.has(r.id)) return;
    r.over = false;
    r.scores = { red: 0, blue: 0 };
    r.placed.clear(); r.destroyed.clear();
    if (r.mode === 'dom') r.zone = { owner: null, cap: 0, capTeam: null, accum: 0, contested: false };
    if (r.pickups) for (const pk of r.pickups) { pk.active = true; pk.respawnAt = 0; }
    if (r.mode === 'ctf') r.flags = makeFlags(r);
    for (const c of r.clients.values()) { const p = c.player; p.hp = 100; p.alive = true; p.kills = 0; p.deaths = 0; p.level = 0; p.streak = 0; p.shieldUntil = 0; p.pos = spawnFor(r, p.team); p.ry = ryFor(p.team); this.send(c.ws, { t: 'respawn', id: p.id, pos: p.pos }); }
    for (const b of r.bots.values()) { b.hp = 100; b.alive = true; b.kills = 0; b.deaths = 0; b.level = 0; b.streak = 0; b.shieldUntil = 0; b.pos = spawnFor(r, b.team); b.ry = ryFor(b.team); this.broadcast(r, { t: 'respawn', id: b.id, pos: b.pos }); }
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
    const pos = spawnFor(r, team);
    // Mixed difficulty: each bot rolls its own tier (some easy, some hard).
    const tier = ['easy', 'easy', 'normal', 'normal', 'normal', 'hard'][Math.floor(Math.random() * 6)];
    const skill = SKILL[tier];
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
        if (now >= bot.respawnAt) { bot.alive = true; bot.hp = 100; bot.pos = spawnFor(r, bot.team); this.broadcast(r, { t: 'respawn', id: bot.id, pos: bot.pos }); }
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
            this.applyDamage(r, target, Math.round(w.dmg * (head ? 2 : 1)), bot, head, 'rifle');
          }
        }
      } else if (r.mode === 'dom' && Math.hypot(bot.pos.x - ZONE_CX, bot.pos.z - ZONE_CZ) > 5) {
        // Domination: with no enemy in sight, march on the central hill to contest it.
        const ang = Math.atan2(-(ZONE_CX - bot.pos.x), -(ZONE_CZ - bot.pos.z));
        bot.ry = ang; this.stepBot(r, bot, ang, dt); moving = 0.8;
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
      const destFeet = groundTop(r, nx, nz) + 1;
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
            p.alive = true; p.hp = 100; p.pos = spawnFor(r, p.team); p.ry = ryFor(p.team); p.respawnAt = 0;
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
        this.updateZone(r, dt);
        this.updatePickups(r, now);
        const states = [];
        for (const e of this.entities(r)) { if (!e.alive) continue; states.push({ id: e.id, pos: e.pos, ry: e.ry, rx: e.rx, anim: e.anim, hp: Math.round(e.hp) }); }
        if (states.length) this.broadcast(r, { t: 'states', states, flags: r.mode === 'ctf' && r.flags ? this.flagPub(r) : undefined, zone: r.mode === 'dom' && r.zone ? this.zonePub(r) : undefined });
      }
    }, CFG.tick);
  }

  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
  broadcast(r, obj) { const s = JSON.stringify(obj); for (const c of r.clients.values()) { try { c.ws.send(s); } catch {} } }
  broadcastExcept(r, id, obj) { const s = JSON.stringify(obj); for (const [cid, c] of r.clients) { if (cid === id) continue; try { c.ws.send(s); } catch {} } }
}
