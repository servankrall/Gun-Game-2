import * as THREE from 'three';
import { buildTextures, buildMaterials } from './textures.js';
import { buildMapBlocks, HALF } from './map.js';

// ============================================================
// Constants
// ============================================================
const EYE = 1.62, P_HALF = 0.3, P_HEIGHT = 1.8;
const SPAWN_NOBUILD_X = 22; // no player-built blocks where |x| >= this (protects both spawns)
const GRAVITY = 23, JUMP_V = 8.6, WALK = 5.8, SPRINT = 8.4;
const SENS = 0.0023;

const WEAPONS = {
  rifle:   { name: 'RIFLE',  dmg: 18, rate: 110,  mag: 30, reload: 1800, spread: 0.014, auto: true,  pellets: 1, range: 90 },
  smg:     { name: 'SMG',    dmg: 12, rate: 72,   mag: 28, reload: 1500, spread: 0.03,  auto: true,  pellets: 1, range: 52 },
  shotgun: { name: 'SHOTGUN', dmg: 9,  rate: 850,  mag: 6,  reload: 2200, spread: 0.06,  auto: false, pellets: 8, range: 32 },
  sniper:  { name: 'SNIPER', dmg: 70, rate: 1400, mag: 5,  reload: 2400, spread: 0.002, auto: false, pellets: 1, range: 140 },
  lmg:     { name: 'LMG',    dmg: 16, rate: 95,   mag: 60, reload: 3200, spread: 0.045, auto: true,  pellets: 1, range: 78 },
  pistol:  { name: 'PISTOL', dmg: 26, rate: 250,  mag: 12, reload: 1100, spread: 0.02,  auto: false, pellets: 1, range: 60 },
  blocks:  { name: 'BLOCKS',    builder: true },
  pickaxe: { name: 'PICKAXE',    tool: true, auto: true },
  bazooka: { name: 'BAZOOKA',   dmg: 110, rate: 2000, mag: 1, reload: 3200, spread: 0, auto: false, pellets: 1, range: 120, rocket: true },
};
const SLOTS = ['rifle', 'smg', 'shotgun', 'sniper', 'lmg', 'pistol', 'blocks', 'pickaxe', 'bazooka'];
// Gun Game weapon ladder — must match the server. Each kill promotes you one
// rung; the final rung is the pickaxe (a one-hit melee finisher).
const GG_LADDER = ['pistol', 'smg', 'rifle', 'shotgun', 'lmg', 'sniper', 'bazooka', 'pickaxe'];
const TEAM_RU = { red: 'RED', blue: 'BLUE' };
const TEAM_COL = { red: '#ff5555', blue: '#7f9fff' };

// ============================================================
// Globals
// ============================================================
let scene, camera, renderer, clock;
let tex, mats;
const collision = new Set();
const placedMeshes = new Map(); // "x,y,z" -> mesh
const mapBlockIndex = new Map(); // "x,y,z" -> { mesh: InstancedMesh, i: instance index } for map blocks
let ws = null, myId = -1, myTeam = 'red', myName = '';
const remotes = new Map(); // id -> remote player record
const scores = { red: 0, blue: 0 };

const me = {
  pos: new THREE.Vector3(0, 1.05, 0),
  vel: new THREE.Vector3(),
  ry: 0, rx: 0,
  onGround: false,
  hp: 100, dead: false,
  kills: 0, deaths: 0,
  slot: 0,
  ammo: { rifle: 30, smg: 28, shotgun: 6, sniper: 5, lmg: 60, pistol: 12, bazooka: 1 },
  blocks: 64,
  nades: 3,
  reloading: false, reloadEnd: 0,
  lastShot: 0, lastNade: 0,
  zoomed: false,
  jumps: 0,
  shieldUntil: 0, // overshield killstreak reward expiry (performance.now ms)
};
let lastKilledBy = null;        // id of whoever last killed me (for REVENGE!)
const nemesisDeaths = {};       // id -> times they've killed me this match
let jumpPrev = false; // edge-detect the jump key so double-jump fires once per press
const MAX_NADES = 3;

const keys = {};
let mouseDown = false;
let locked = false;
let inGame = false;
let tabHeld = false;
let chatOpen = false;

// Mobile / touch input
let mobile = false, mobileSprint = false, sprintHeld = false;
const mobileMove = { x: 0, z: 0, active: false };

// Room / match / feel
let myRoom = (new URLSearchParams(location.search).get('room') || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
let scoreLimit = 150;
let botDiff = 'normal';
let gameMode = 'dm';   // 'dm' | 'ctf' | 'gg' | 'dom' (domination) | 'surv' (survival)
let waveNum = 0;       // current Survival wave
let menuMode = 'dm';   // mode chosen on the menu, sent at join
let myLevel = 0;       // gun-game rung (index into GG_LADDER)
let sunLight = null, ambLight = null;
// Graphics quality: 'low' drops shadows + pixel ratio for weaker devices.
let gfxQuality = localStorage.getItem('bf_gfx') === 'low' ? 'low' : 'high';
function applyGfx() {
  if (!renderer) return;
  const low = gfxQuality === 'low';
  renderer.setPixelRatio(low ? 1 : Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = !low;
  renderer.shadowMap.needsUpdate = true;
  if (sunLight) sunLight.castShadow = !low;
}
let mapTheme = 'desert', menuMap = 'desert';
// Map themes: same arena collision, different look (materials + sky/fog/light).
const THEMES = {
  desert:  { name: 'DESERT TEMPLE', sky: 0x87ceeb, fog: 0x87ceeb, fogN: 60, fogF: 140, sun: 0xfff4d6, sunI: 1.6, amb: 0xffffff, ambI: 0.75, tints: {} },
  arctic:  { name: 'ARCTIC OUTPOST', sky: 0xcfe6f2, fog: 0xdaeaf2, fogN: 45, fogF: 120, sun: 0xeaf4ff, sunI: 1.5, amb: 0xdfeaff, ambI: 0.9,
             tints: { sand: 0xdff0ff, gravel: 0xb9c9d6, dirt: 0xcfe0ea, stone: 0xc2d4e0, cobble: 0xb8c8d4 } },
  volcano: { name: 'VOLCANO', sky: 0x2a1512, fog: 0x3a1a14, fogN: 34, fogF: 105, sun: 0xffb27a, sunI: 1.35, amb: 0x3a2420, ambI: 0.6,
             tints: { sand: 0x5c4a42, gravel: 0x352c28, dirt: 0x4a2a20, stone: 0x463c36, cobble: 0x3c332e } },
  night:   { name: 'NIGHT RAID', sky: 0x0b1020, fog: 0x0c1530, fogN: 40, fogF: 118, sun: 0xaebfff, sunI: 0.85, amb: 0x4a5a7a, ambI: 0.78,
             tints: { sand: 0x8a8f9c, gravel: 0x5a606c, dirt: 0x6a6250, stone: 0x6b7280, cobble: 0x5a6270 } },
  metro:   { name: 'METRO', sky: 0x9aa3ad, fog: 0xa7b0ba, fogN: 50, fogF: 130, sun: 0xdfe4ea, sunI: 1.1, amb: 0xc7cdd6, ambI: 0.85,
             tints: { sand: 0x9a9a9c, gravel: 0x6e6e72, dirt: 0x7a7570, stone: 0x8a8f96, cobble: 0x777c84 } },
  toxic:   { name: 'TOXIC MARSH', sky: 0x2b3b1f, fog: 0x33421f, fogN: 32, fogF: 100, sun: 0xd2e089, sunI: 1.15, amb: 0x3a4a2a, ambI: 0.72,
             tints: { sand: 0x6a7a3a, gravel: 0x44502a, dirt: 0x4a5a24, stone: 0x516039, cobble: 0x3e4a2a } },
};
const MAP_IDS = ['desert', 'arctic', 'volcano', 'night', 'metro', 'toxic'];
function applyTheme(id) {
  mapTheme = THEMES[id] ? id : 'desert';
  const t = THEMES[mapTheme];
  if (scene) { scene.background = new THREE.Color(t.sky); scene.fog = new THREE.Fog(t.fog, t.fogN, t.fogF); }
  if (sunLight) { sunLight.color.setHex(t.sun); sunLight.intensity = t.sunI; }
  if (ambLight) { ambLight.color.setHex(t.amb); ambLight.intensity = t.ambI; }
  for (const ty of ['sand', 'gravel', 'dirt', 'stone', 'cobble']) if (mats[ty]) mats[ty].color.setHex(0xffffff);
  for (const ty in t.tints) if (mats[ty]) mats[ty].color.setHex(t.tints[ty]);
}

// Selectable agents. Client perks: speed/jump (movement), starting nades/blocks,
// accent colour (helmet/shoulders). Damage-taken and regen perks live on the
// server (see AGENTS there); everyone still has 100 HP so the health bar is
// unchanged — HEAVY just takes less damage.
const AGENTS = {
  soldier:  { name: 'SOLDIER',    role: 'Balanced all-rounder',        accent: 0x9aa4b2, speed: 1.0,  jump: 1.0,  nades: 3, blocks: 64,  cost: 0 },
  scout:    { name: 'SCOUT',      role: 'Fast & fragile · +1 grenade', accent: 0x49c26a, speed: 1.2,  jump: 1.15, nades: 4, blocks: 64,  cost: 150 },
  heavy:    { name: 'HEAVY',      role: 'Tank · takes less damage',    accent: 0xe08a2a, speed: 0.85, jump: 0.92, nades: 3, blocks: 80,  cost: 300 },
  medic:    { name: 'MEDIC',      role: 'Regenerates much faster',     accent: 0xf2f2f2, speed: 1.0,  jump: 1.0,  nades: 3, blocks: 64,  cost: 300 },
  ninja:    { name: 'NINJA',      role: 'Double-jump · very agile',    accent: 0x9b5cff, speed: 1.15, jump: 1.4,  nades: 3, blocks: 64,  cost: 500, doubleJump: true },
  engineer: { name: 'ENGINEER',   role: 'Builder · lots of blocks',    accent: 0x3f9bd6, speed: 0.95, jump: 1.0,  nades: 3, blocks: 110, cost: 600 },
  demo:     { name: 'DEMOLITION', role: 'Explosives · +2 grenades',    accent: 0xd23b3b, speed: 0.95, jump: 1.0,  nades: 5, blocks: 64,  cost: 450 },
};
const AGENT_IDS = Object.keys(AGENTS);
// ---- in-game coins + class unlocks (persisted locally) ----
let coins = Math.max(0, parseInt(localStorage.getItem('bf_coins')) || 0);
let unlocked = (() => {
  try { const u = JSON.parse(localStorage.getItem('bf_unlocked')); if (Array.isArray(u)) return new Set(u); } catch {}
  return new Set(['soldier']);
})();
unlocked.add('soldier'); // soldier is always free
function isUnlocked(id) { return (AGENTS[id]?.cost || 0) === 0 || unlocked.has(id); }
// When logged in, coins/unlocks/friends live on the account (synced); as a guest
// they persist to this device's localStorage.
function saveCoins() { if (account) syncAccount(); else localStorage.setItem('bf_coins', String(coins)); }
function saveUnlocked() { if (account) syncAccount(); else localStorage.setItem('bf_unlocked', JSON.stringify([...unlocked])); }
const COIN = '<span class="coin"></span>'; // CSS gold-coin icon (emoji renders as tofu in the pixel font)
function setCoinBal() { const el = $('coinBal'); if (el) el.innerHTML = COIN + coins; if (coins >= 1000) unlockAch('rich'); updateProfileCard(); }
function awardCoins(n) { coins += n; saveCoins(); setCoinBal(); }

// ============================================================
// Career + Battle Pass + Cosmetics (titles)
// ============================================================
let careerXp = Math.max(0, parseInt(localStorage.getItem('bf_xp')) || 0);
const XP_PER_TIER = 500, MAX_TIER = 50;
function careerLevel() { return Math.min(MAX_TIER, 1 + Math.floor(careerXp / XP_PER_TIER)); }
function tierFrac() { return Math.min(1, (careerXp % XP_PER_TIER) / XP_PER_TIER); }
function saveXp() { localStorage.setItem('bf_xp', String(careerXp)); }
// Cosmetic titles: some unlock free at a career tier, some are coin-shop exclusives.
const TITLES = {
  none:         { name: 'NO TITLE', tier: 0, cost: 0 },
  rookie:       { name: 'ROOKIE', tier: 2, cost: 0 },
  fighter:      { name: 'FIGHTER', tier: 4, cost: 0 },
  sharpshooter: { name: 'SHARPSHOOTER', tier: 7, cost: 0 },
  veteran:      { name: 'VETERAN', tier: 11, cost: 0 },
  warlord:      { name: 'WARLORD', tier: 16, cost: 0 },
  elite:        { name: 'ELITE', tier: 24, cost: 0 },
  legend:       { name: 'LEGEND', tier: 35, cost: 0 },
  apex:         { name: 'APEX', tier: 50, cost: 0 },
  ghost:        { name: 'GHOST', tier: 0, cost: 400 },
  reaper:       { name: 'REAPER', tier: 0, cost: 800 },
  overlord:     { name: 'OVERLORD', tier: 0, cost: 1500 },
  godmode:      { name: 'GOD MODE', tier: 0, cost: 3000 },
};
let ownedTitles = (() => { try { const a = JSON.parse(localStorage.getItem('bf_titles')); return new Set(Array.isArray(a) ? a : []); } catch { return new Set(); } })();
ownedTitles.add('none');
let equippedTitle = localStorage.getItem('bf_title') || 'none';
function saveTitles() { localStorage.setItem('bf_titles', JSON.stringify([...ownedTitles])); localStorage.setItem('bf_title', equippedTitle); }

// Weapon SKINS (Valorant-style finishes). Each skin recolours your gun and
// bundles its own tracer colour — buying/equipping a skin applies both.
const SKINS = {
  standard:    { name: 'STANDARD',     body: 0x26262b, accent: 0x3a3a40, emissive: 0x000000, tracer: 0xffd080, tier: 0, cost: 0 },
  recruit:     { name: 'RECRUIT',      body: 0x2b3550, accent: 0x4a6299, emissive: 0x0a1428, tracer: 0x9fe0ff, tier: 5, cost: 0 },
  ranger:      { name: 'RANGER',       body: 0x223018, accent: 0x5a7a2a, emissive: 0x0a1405, tracer: 0x6bffa0, tier: 12, cost: 0 },
  chronovoid:  { name: 'CHRONOVOID',   body: 0x141026, accent: 0x6a4bff, emissive: 0x1a0a4a, tracer: 0x8a4bff, tier: 20, cost: 0 },
  radiant:     { name: 'RADIANT',      body: 0xf0e6c0, accent: 0xffd24a, emissive: 0x3a3010, tracer: 0xffd24a, tier: 40, cost: 0 },
  prime:       { name: 'PRIME',        body: 0xdcc7a6, accent: 0xb9902f, emissive: 0x201800, tracer: 0x35f0ff, tier: 0, cost: 1000 },
  neofrontier: { name: 'NEO FRONTIER', body: 0x0f2a2a, accent: 0x35f0c0, emissive: 0x0a3a30, tracer: 0x35f0c0, tier: 0, cost: 1200 },
  kuronami:    { name: 'KURONAMI',     body: 0x121212, accent: 0x9a1018, emissive: 0x5a0a0a, tracer: 0xff3b3b, tier: 0, cost: 1500 },
  sovereign:   { name: 'SOVEREIGN',    body: 0xe8e2cf, accent: 0xcaa64a, emissive: 0x2a2410, tracer: 0xffe08a, tier: 0, cost: 1800 },
  oni:         { name: 'ONI',          body: 0x1a1030, accent: 0xc23bd6, emissive: 0x3a0a4a, tracer: 0xff4fd8, tier: 0, cost: 2000 },
  glitchpop:   { name: 'GLITCHPOP',    body: 0x2a0a3a, accent: 0x35f0ff, emissive: 0x2a0a3a, tracer: 0xff4fd8, tier: 0, cost: 2400 },
  dragon:      { name: 'ELDER DRAGON', body: 0x2a1206, accent: 0xff7a1a, emissive: 0x5a2600, tracer: 0xff7a1a, tier: 0, cost: 3200 },
};
let ownedSkins = (() => { try { const a = JSON.parse(localStorage.getItem('bf_skins')); return new Set(Array.isArray(a) ? a : []); } catch { return new Set(); } })();
ownedSkins.add('standard');
let equippedSkin = localStorage.getItem('bf_skin') || 'standard';
function saveSkins() { localStorage.setItem('bf_skins', JSON.stringify([...ownedSkins])); localStorage.setItem('bf_skin', equippedSkin); }
function skinUnlocked(id) { const s = SKINS[id]; if (!s) return false; if (ownedSkins.has(id)) return true; return s.tier > 0 && careerLevel() >= s.tier; }

// Character (agent) skins — outfits that recolour helmet/pants and can glow.
// The team jersey stays team-coloured so red/blue is always readable.
const CHAR_SKINS = {
  default: { name: 'DEFAULT', accent: null, pants: 0x33343c, glow: false, tier: 0, cost: 0 },
  cadet:   { name: 'CADET', accent: 0x4a6299, pants: 0x2b3550, glow: false, tier: 4, cost: 0 },
  ranger:  { name: 'RANGER', accent: 0x5a7a2a, pants: 0x223018, glow: false, tier: 10, cost: 0 },
  radiant: { name: 'RADIANT', accent: 0xffe08a, pants: 0x4a4020, glow: true, tier: 30, cost: 0 },
  shadow:  { name: 'SHADOW OPS', accent: 0x2a2a30, pants: 0x111114, glow: false, tier: 0, cost: 700 },
  frost:   { name: 'FROSTBITE', accent: 0x9fe0ff, pants: 0x25414f, glow: false, tier: 0, cost: 900 },
  ember:   { name: 'EMBER', accent: 0xff7a1a, pants: 0x3a1a06, glow: true, tier: 0, cost: 1200 },
  neon:    { name: 'NEON RONIN', accent: 0xff4fd8, pants: 0x2a0a2a, glow: true, tier: 0, cost: 1600 },
  voidwlk: { name: 'VOIDWALKER', accent: 0x8a4bff, pants: 0x1a1030, glow: true, tier: 0, cost: 2000 },
  golden:  { name: 'GOLD PLATE', accent: 0xffd24a, pants: 0x3a3010, glow: true, tier: 0, cost: 2800 },
};
let ownedChars = (() => { try { const a = JSON.parse(localStorage.getItem('bf_chars')); return new Set(Array.isArray(a) ? a : []); } catch { return new Set(); } })();
ownedChars.add('default');
let equippedChar = localStorage.getItem('bf_char') || 'default';
function saveChars() { localStorage.setItem('bf_chars', JSON.stringify([...ownedChars])); localStorage.setItem('bf_char', equippedChar); }
function charUnlocked(id) { const s = CHAR_SKINS[id]; if (!s) return false; if (ownedChars.has(id)) return true; return s.tier > 0 && careerLevel() >= s.tier; }

// Tracer colour comes from the equipped skin (bundled).
function myTracerColor(wkey) {
  const s = SKINS[equippedSkin];
  if (!s || equippedSkin === 'standard') return wkey === 'sniper' ? 0xaadfff : 0xffd080;
  return s.tracer;
}
// Each skin has a procedural surface pattern (not just a flat colour).
const SKIN_PATTERN = {
  standard: 'plain', recruit: 'camo', ranger: 'camo', chronovoid: 'hex', radiant: 'gold',
  prime: 'plain', neofrontier: 'circuit', kuronami: 'wave', sovereign: 'gold', oni: 'scale',
  glitchpop: 'glitch', dragon: 'scale',
};
// Premium skins pulse an animated glow in-game and in the preview.
const GLOW_SKINS = new Set(['chronovoid', 'radiant', 'neofrontier', 'oni', 'glitchpop', 'dragon']);
const _skinTexCache = {};
function makeSkinTexture(id) {
  if (_skinTexCache[id]) return _skinTexCache[id];
  const s = SKINS[id] || SKINS.standard, pat = SKIN_PATTERN[id] || 'plain';
  const hx6 = n => '#' + (n >>> 0).toString(16).padStart(6, '0');
  const body = hx6(s.body), acc = hx6(s.accent), tr = hx6(s.tracer);
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = body; g.fillRect(0, 0, 64, 64);
  let x = (s.body ^ s.accent ^ 0x9e3779b1) >>> 0; const rnd = () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };
  if (pat === 'camo') {
    g.fillStyle = acc; for (let i = 0; i < 24; i++) { g.beginPath(); g.arc(rnd() * 64, rnd() * 64, 4 + rnd() * 8, 0, 7); g.fill(); }
    g.fillStyle = 'rgba(0,0,0,.28)'; for (let i = 0; i < 16; i++) { g.beginPath(); g.arc(rnd() * 64, rnd() * 64, 3 + rnd() * 6, 0, 7); g.fill(); }
  } else if (pat === 'hex') {
    g.strokeStyle = acc; g.lineWidth = 1.3; for (let y = 0; y < 64; y += 10) for (let px = 0; px < 64; px += 12) g.strokeRect(px + ((y / 10) % 2 ? 6 : 0), y, 10, 10);
  } else if (pat === 'circuit') {
    g.strokeStyle = acc; g.lineWidth = 1.3; for (let i = 0; i < 10; i++) { const y = rnd() * 64; g.beginPath(); g.moveTo(0, y); g.lineTo(64, y + (rnd() * 20 - 10)); g.stroke(); }
    g.fillStyle = tr; for (let i = 0; i < 14; i++) g.fillRect(rnd() * 62, rnd() * 62, 3, 3);
  } else if (pat === 'glitch') {
    const cols = [acc, tr, body]; for (let i = 0; i < 64; i++) { g.fillStyle = cols[Math.floor(rnd() * 3)]; g.fillRect(Math.floor(rnd() * 8) * 8, Math.floor(rnd() * 16) * 4, 8, 4); }
  } else if (pat === 'scale') {
    g.strokeStyle = 'rgba(0,0,0,.35)'; for (let y = 0; y < 64; y += 8) for (let px = 0; px < 64; px += 10) { const ox = (y / 8) % 2 ? 5 : 0; g.fillStyle = acc; g.beginPath(); g.arc(px + ox, y + 8, 6, Math.PI, 0); g.fill(); g.stroke(); }
  } else if (pat === 'wave') {
    for (let y = 0; y < 64; y += 6) { g.fillStyle = (y / 6) % 2 ? acc : body; g.beginPath(); g.moveTo(0, y); for (let px = 0; px <= 64; px += 8) g.lineTo(px, y + Math.sin(px / 8 + y) * 2); g.lineTo(64, y + 6); g.lineTo(0, y + 6); g.fill(); }
  } else if (pat === 'gold') {
    for (let i = -64; i < 64; i += 8) { g.strokeStyle = (i % 16) ? acc : 'rgba(255,255,255,.55)'; g.lineWidth = 3; g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 64, 64); g.stroke(); }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter;
  if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  _skinTexCache[id] = tex; return tex;
}
// Recolour + texture the first-person weapon materials to match the equipped skin.
function applyWeaponSkin(id) {
  const s = SKINS[id] || SKINS.standard;
  if (!vm || !vm.mats) return;
  const tex = id === 'standard' ? null : makeSkinTexture(id);
  const parts = [['dark', s.body], ['dark2', s.accent], ['wood', s.accent]];
  for (const [key, col] of parts) {
    const m = vm.mats[key]; if (!m) continue;
    m.color.setHex(tex ? 0xffffff : col); // map multiplies colour, so go white under a texture
    if (m.emissive) m.emissive.setHex(s.emissive);
    m.emissiveIntensity = 1; // reset; pulsed per-frame only for glow skins
    m.map = tex; m.needsUpdate = true;
  }
}
function titleUnlocked(id) { const t = TITLES[id]; if (!t) return false; if (ownedTitles.has(id)) return true; return t.tier > 0 && careerLevel() >= t.tier; }
function titleText(id) { const t = TITLES[id]; return (t && id !== 'none') ? t.name : ''; }
function awardXp(n) {
  if (!(n > 0)) return;
  const before = careerLevel();
  careerXp += n; saveXp();
  const after = careerLevel();
  if (after > before) {
    let reward = 0; for (let t = before + 1; t <= after; t++) reward += 40 + t * 5;
    awardCoins(reward);
    if (inGame) announce(`CAREER LEVEL ${after}!  +${reward}`, '#ffd24a');
    try { feed(`Reached career level ${after} — +${reward} coins!`, myTeam); } catch {}
    renderCareer(); renderShop();
  }
  updateProfileCard();
}
// Top-bar profile card (level ring, xp bar, coins, equipped title).
function updateProfileCard() {
  const lvl = careerLevel();
  const set = (id, html) => { const e = $(id); if (e) e.innerHTML = html; };
  set('pcLevel', String(lvl));
  const bar = $('pcXpBar'); if (bar) bar.style.width = Math.round(tierFrac() * 100) + '%';
  set('pcXpTxt', lvl >= MAX_TIER ? 'MAX' : `${careerXp % XP_PER_TIER} / ${XP_PER_TIER} XP`);
  set('pcCoins', COIN + coins);
  const tt = $('pcTitle'); if (tt) { const t = titleText(equippedTitle); tt.textContent = t || 'NO TITLE'; tt.style.opacity = t ? '1' : '0.5'; }
  const nm = $('pcName'); if (nm) nm.textContent = (localStorage.getItem('blockade_name') || (typeof input !== 'undefined' && input && input.value) || 'PLAYER').toUpperCase();
}
// Battle-pass track: tiers 1..MAX with their reward + any title unlock.
function renderCareer() {
  const box = $('careerTrack'); if (!box) return;
  const lvl = careerLevel();
  const titleAt = {}; for (const id in TITLES) if (TITLES[id].tier > 0) titleAt[TITLES[id].tier] = TITLES[id].name;
  let h = '';
  for (let t = 1; t <= MAX_TIER; t++) {
    const done = lvl >= t, cur = lvl === t;
    const reward = 40 + t * 5;
    const title = titleAt[t];
    h += `<div class="ptier ${done ? 'done' : ''} ${cur ? 'cur' : ''}">
      <div class="pt-n">${t}</div>
      <div class="pt-r">${COIN}${reward}</div>
      ${title ? `<div class="pt-t">${title}</div>` : ''}
    </div>`;
  }
  box.innerHTML = h;
  const hdr = $('careerHdr');
  if (hdr) hdr.innerHTML = `LEVEL <b>${lvl}</b> / ${MAX_TIER} &nbsp;·&nbsp; <span style="color:#9fb0d0">${lvl >= MAX_TIER ? 'MAX RANK' : `${careerXp % XP_PER_TIER} / ${XP_PER_TIER} XP to next`}</span>`;
  const fill = $('careerBar'); if (fill) fill.style.width = Math.round(tierFrac() * 100) + '%';
  // auto-scroll to current tier
  const curEl = box.querySelector('.ptier.cur'); if (curEl) curEl.scrollIntoView({ inline: 'center', block: 'nearest' });
}
// Cosmetics shop: TITLES + Valorant-style WEAPON SKINS (with a live 3D preview).
let shopCat = 'titles';
let selectedSkin = equippedSkin;
function hx(n) { return '#' + (n >>> 0).toString(16).padStart(6, '0'); }
function actionBtn(owned, equipped, tier, cost, id) {
  if (equipped) return `<button class="shop-b eq" disabled>EQUIPPED</button>`;
  if (owned) return `<button class="shop-b" data-equip="${id}">EQUIP</button>`;
  if (tier > 0) return `<button class="shop-b lock" disabled>LEVEL ${tier}</button>`;
  return `<button class="shop-b buy" data-buy="${id}">${COIN}${cost}</button>`;
}
function renderShop() {
  const box = $('shopGrid'); if (!box) return;
  document.querySelectorAll('#shopTabs .shopcat').forEach(t => t.classList.toggle('active', t.dataset.cat === shopCat));
  const stage = $('skinStage');
  let h = '';
  if (shopCat === 'titles') {
    if (stage) stage.style.display = 'none'; stopPreview();
    for (const id in TITLES) {
      if (id === 'none') continue;
      const t = TITLES[id], owned = titleUnlocked(id), equipped = equippedTitle === id;
      h += `<div class="shop-card ${owned ? 'owned' : ''} ${equipped ? 'equipped' : ''}">
        <div class="shop-badge" style="background:linear-gradient(90deg,#ffd24a,#ffb14a)">${t.name}</div>
        <div class="shop-src">${t.tier > 0 ? 'Career reward' : 'Shop exclusive'}</div>
        ${actionBtn(owned, equipped, t.tier, t.cost, id)}</div>`;
    }
    box.innerHTML = h;
    box.querySelectorAll('[data-equip]').forEach(b => b.addEventListener('click', () => equipTitle(b.dataset.equip)));
    box.querySelectorAll('[data-buy]').forEach(b => b.addEventListener('click', () => buyTitle(b.dataset.buy)));
    const none = $('shopUnequip'); if (none) { none.style.display = ''; none.onclick = () => equipTitle('none'); }
  } else if (shopCat === 'skins') { // weapon skins
    const none = $('shopUnequip'); if (none) none.style.display = 'none';
    if (stage) stage.style.display = 'flex';
    if (!SKINS[selectedSkin]) selectedSkin = equippedSkin;
    setPreviewSkin(selectedSkin); startPreview();
    renderSkinInfo();
    for (const id in SKINS) {
      const s = SKINS[id], owned = skinUnlocked(id), equipped = equippedSkin === id, sel = selectedSkin === id, rar = skinRarity(id);
      h += `<div class="skin-card ${owned ? 'owned' : ''} ${equipped ? 'equipped' : ''} ${sel ? 'sel' : ''}" data-sel="${id}" style="border-top:3px solid ${rar.color}">
        <div class="skin-sw"><span style="background:${hx(s.body)}"></span><span style="background:${hx(s.accent)}"></span><span class="tr" style="background:${hx(s.tracer)}"></span></div>
        <div class="skin-nm">${s.name}</div>
        <div class="shop-src" style="color:${rar.color}">${rar.name}</div>
        <div class="shop-src">${s.tier > 0 ? 'Career Lv ' + s.tier : id === 'standard' ? 'Default' : COIN + s.cost}</div>
      </div>`;
    }
    box.innerHTML = h;
    box.querySelectorAll('[data-sel]').forEach(c => c.addEventListener('click', () => { selectedSkin = c.dataset.sel; renderShop(); }));
  } else { // character skins
    const none = $('shopUnequip'); if (none) none.style.display = 'none';
    if (stage) stage.style.display = 'flex';
    if (!CHAR_SKINS[selectedChar]) selectedChar = equippedChar;
    setPreviewChar(selectedChar); startPreview();
    renderCharInfo();
    for (const id in CHAR_SKINS) {
      const s = CHAR_SKINS[id], owned = charUnlocked(id), equipped = equippedChar === id, sel = selectedChar === id, rar = charRarity(id);
      const accSw = s.accent != null ? hx(s.accent) : '#9aa4b2';
      h += `<div class="skin-card ${owned ? 'owned' : ''} ${equipped ? 'equipped' : ''} ${sel ? 'sel' : ''}" data-selc="${id}" style="border-top:3px solid ${rar.color}">
        <div class="skin-sw"><span style="background:${accSw}"></span><span style="background:${hx(s.pants)}"></span>${s.glow ? `<span class="tr" style="background:${accSw}"></span>` : ''}</div>
        <div class="skin-nm">${s.name}</div>
        <div class="shop-src" style="color:${rar.color}">${rar.name}</div>
        <div class="shop-src">${s.tier > 0 ? 'Career Lv ' + s.tier : id === 'default' ? 'Default' : COIN + s.cost}</div>
      </div>`;
    }
    box.innerHTML = h;
    box.querySelectorAll('[data-selc]').forEach(c => c.addEventListener('click', () => { selectedChar = c.dataset.selc; renderShop(); }));
  }
}
let selectedChar = equippedChar;
function charRarity(id) {
  const s = CHAR_SKINS[id]; if (!s) return { name: 'RARE', color: '#5ad1ff' };
  if (id === 'default') return { name: 'STANDARD', color: '#9fb0d0' };
  if (s.tier > 0) return { name: 'CAREER', color: '#7be0a0' };
  if (s.cost >= 2000) return { name: 'LEGENDARY', color: '#ffd24a' };
  if (s.cost >= 1200) return { name: 'EPIC', color: '#c78bff' };
  return { name: 'RARE', color: '#5ad1ff' };
}
function renderCharInfo() {
  const info = $('skinInfo'); if (!info) return;
  const s = CHAR_SKINS[selectedChar], owned = charUnlocked(selectedChar), equipped = equippedChar === selectedChar, rar = charRarity(selectedChar);
  const glow = s.glow ? '<span class="si-tag">GLOW</span>' : '';
  info.innerHTML = `<div class="si-rar" style="color:${rar.color};border-color:${rar.color}">${rar.name}</div>
    <div class="si-name">${s.name}</div>
    <div class="si-src">${s.tier > 0 ? 'Career reward · Level ' + s.tier : selectedChar === 'default' ? 'Default outfit' : 'Shop exclusive'}</div>
    <div class="si-tr">OUTFIT${glow}</div>
    <div class="si-hint">Others see your outfit in-game</div>
    <div class="si-act">${actionBtn(owned, equipped, s.tier, s.cost, selectedChar)}</div>`;
  info.querySelectorAll('[data-equip]').forEach(b => b.addEventListener('click', () => equipChar(b.dataset.equip)));
  info.querySelectorAll('[data-buy]').forEach(b => b.addEventListener('click', () => buyChar(b.dataset.buy)));
}
function equipChar(id) { if (!charUnlocked(id)) return; equippedChar = id; selectedChar = id; saveChars(); renderShop(); }
function buyChar(id) {
  const s = CHAR_SKINS[id]; if (!s || charUnlocked(id)) return;
  if (coins < s.cost) { const m = $('shopMsg'); if (m) m.textContent = `Need ${s.cost} coins`; return; }
  awardCoins(-s.cost); ownedChars.add(id); saveChars(); equipChar(id);
  const m = $('shopMsg'); if (m) m.textContent = `Unlocked ${s.name}!`;
}
function skinRarity(id) {
  const s = SKINS[id]; if (!s) return { name: 'RARE', color: '#5ad1ff' };
  if (id === 'standard') return { name: 'STANDARD', color: '#9fb0d0' };
  if (id === 'dragon') return { name: 'EXOTIC', color: '#ff7a1a' };
  if (s.tier > 0) return { name: 'CAREER', color: '#7be0a0' };
  if (s.cost >= 1800) return { name: 'LEGENDARY', color: '#ffd24a' };
  if (s.cost >= 1000) return { name: 'EPIC', color: '#c78bff' };
  return { name: 'RARE', color: '#5ad1ff' };
}
function renderSkinInfo() {
  const info = $('skinInfo'); if (!info) return;
  const s = SKINS[selectedSkin]; const owned = skinUnlocked(selectedSkin), equipped = equippedSkin === selectedSkin;
  const rar = skinRarity(selectedSkin);
  const glow = GLOW_SKINS.has(selectedSkin) ? '<span class="si-tag">GLOW</span>' : '';
  info.innerHTML = `<div class="si-rar" style="color:${rar.color};border-color:${rar.color}">${rar.name}</div>
    <div class="si-name">${s.name}</div>
    <div class="si-src">${s.tier > 0 ? 'Career reward · Level ' + s.tier : selectedSkin === 'standard' ? 'Default finish' : 'Shop exclusive'}</div>
    <div class="si-tr">TRACER <span style="background:${hx(s.tracer)}"></span>${glow}</div>
    <div class="si-hint">Press <b>Y</b> in-game to inspect</div>
    <div class="si-act">${actionBtn(owned, equipped, s.tier, s.cost, selectedSkin)}</div>`;
  info.querySelectorAll('[data-equip]').forEach(b => b.addEventListener('click', () => equipSkin(b.dataset.equip)));
  info.querySelectorAll('[data-buy]').forEach(b => b.addEventListener('click', () => buySkin(b.dataset.buy)));
}
function equipSkin(id) {
  if (!skinUnlocked(id)) return;
  equippedSkin = id; selectedSkin = id; saveSkins(); applyWeaponSkin(id); renderShop();
}
function buySkin(id) {
  const s = SKINS[id]; if (!s || skinUnlocked(id)) return;
  if (coins < s.cost) { const m = $('shopMsg'); if (m) m.textContent = `Need ${s.cost} coins`; return; }
  awardCoins(-s.cost); ownedSkins.add(id); saveSkins(); equipSkin(id);
  const m = $('shopMsg'); if (m) m.textContent = `Unlocked ${s.name}!`;
}

// ---- Live 3D weapon preview (Valorant-style inspect) ----
let pv = null;
function makePreviewGun(id) {
  const s = SKINS[id] || SKINS.standard;
  const tex = id === 'standard' ? null : makeSkinTexture(id);
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: tex ? 0xffffff : s.body, map: tex, emissive: s.emissive, metalness: 0.55, roughness: 0.45 });
  const acc = new THREE.MeshStandardMaterial({ color: tex ? 0xffffff : s.accent, map: tex, emissive: s.emissive, metalness: 0.65, roughness: 0.35 });
  const b = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.24, 1.05), body);
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.62), acc); barrel.position.set(0, 0.02, -0.8);
  const tip = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.13, 0.1), acc); tip.position.set(0, 0.02, -1.12);
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.32, 0.18), acc); mag.position.set(0.02, -0.26, -0.05);
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.18, 0.34), body); stock.position.set(0, -0.02, 0.64);
  const scope = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.11, 0.24), acc); scope.position.set(0, 0.19, -0.08);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.2, 0.12), body); grip.position.set(0, -0.2, 0.28);
  g.add(b, barrel, tip, mag, stock, scope, grip);
  g.rotation.y = -0.5;
  return g;
}
function ensureSkinPreview() {
  if (pv) return pv;
  const canvas = document.getElementById('skinPreview'); if (!canvas || !window.THREE) return null;
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }); } catch { return null; }
  const w = canvas.clientWidth || 420, h = canvas.clientHeight || 240;
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(w, h, false);
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(32, w / h, 0.1, 100); cam.position.set(0, 0.05, 2.5);
  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const dl = new THREE.DirectionalLight(0xffffff, 1.0); dl.position.set(2, 3, 2); scene.add(dl);
  const dl2 = new THREE.DirectionalLight(0x88aaff, 0.5); dl2.position.set(-2, -1, -2); scene.add(dl2);
  const holder = new THREE.Group(); scene.add(holder);
  pv = { renderer, scene, cam, holder, gun: null, raf: 0, skin: null };
  return pv;
}
function makePreviewChar(id) {
  const s = CHAR_SKINS[id] || CHAR_SKINS.default;
  const acc = s.accent != null ? s.accent : 0x9aa4b2, pantsC = s.pants != null ? s.pants : 0x33343c;
  const M = (c, glow) => new THREE.MeshStandardMaterial({ color: c, emissive: glow ? c : 0x000000, emissiveIntensity: glow ? 0.6 : 0, metalness: 0.25, roughness: 0.7 });
  const g = new THREE.Group();
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), M(0xd8a37a)); head.position.y = 1.65;
  const helmet = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.2, 0.58), M(acc, s.glow)); helmet.position.y = 1.92;
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.28), M(0x8f3a38)); body.position.y = 1.05;
  const armL = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.62, 0.24), M(0x8f3a38)); armL.position.set(-0.37, 1.07, 0);
  const armR = armL.clone(); armR.position.x = 0.37;
  const legL = new THREE.Mesh(new THREE.BoxGeometry(0.23, 0.7, 0.26), M(pantsC)); legL.position.set(-0.13, 0.35, 0);
  const legR = legL.clone(); legR.position.x = 0.13;
  g.add(head, helmet, body, armL, armR, legL, legR);
  g.scale.set(1.05, 1.05, 1.05); g.position.y = -1.05; g.rotation.y = -0.35;
  return g;
}
function setPreviewObj(obj, key, glow) {
  const p = ensureSkinPreview(); if (!p) return;
  if (p.skin === key && p.gun) return;
  if (p.gun) { p.holder.remove(p.gun); p.gun.traverse(o => { o.geometry && o.geometry.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose()); }); }
  p.gun = obj; p.holder.add(obj); p.skin = key; p.glow = !!glow;
}
function setPreviewSkin(id) { setPreviewObj(makePreviewGun(id), 'gun:' + id, GLOW_SKINS.has(id)); }
function setPreviewChar(id) { setPreviewObj(makePreviewChar(id), 'char:' + id, !!(CHAR_SKINS[id] && CHAR_SKINS[id].glow)); }
function previewLoop() {
  if (!pv) return;
  pv.raf = requestAnimationFrame(previewLoop);
  if (pv.holder) pv.holder.rotation.y += 0.012;
  if (pv.gun && pv.glow) {
    const gi = 0.8 + Math.sin(performance.now() * 0.006) * 0.7;
    pv.gun.traverse(o => { if (o.material && o.material.emissive && o.material.emissiveIntensity !== undefined && o.material.emissive.getHex() !== 0) o.material.emissiveIntensity = gi; });
  }
  pv.renderer.render(pv.scene, pv.cam);
}
function startPreview() { if (pv && !pv.raf) previewLoop(); }
function stopPreview() { if (pv && pv.raf) { cancelAnimationFrame(pv.raf); pv.raf = 0; } }
function equipTitle(id) {
  if (!titleUnlocked(id) && id !== 'none') return;
  equippedTitle = id; saveTitles(); renderShop(); updateProfileCard();
}
function buyTitle(id) {
  const t = TITLES[id]; if (!t || titleUnlocked(id)) return;
  if (coins < t.cost) { const m = $('shopMsg'); if (m) m.textContent = `Need ${t.cost} coins`; return; }
  awardCoins(-t.cost); ownedTitles.add(id); saveTitles();
  equipTitle(id);
  const m = $('shopMsg'); if (m) m.textContent = `Unlocked ${t.name}!`;
  renderShop();
}
// ---- achievements (one-off milestones, small coin rewards, persisted) ----
const ACHIEVEMENTS = {
  firstkill: { name: 'FIRST BLOOD', reward: 20 },
  spree5:    { name: 'KILLING SPREE', reward: 40 },
  win:       { name: 'WINNER', reward: 60 },
  ggwin:     { name: 'GUN GOD', reward: 80 },
  unlockall: { name: 'COLLECTOR', reward: 150 },
  rich:      { name: 'TYCOON', reward: 0 },
  overshield:{ name: 'JUGGERNAUT', reward: 50 },
  revenge:   { name: 'PAYBACK', reward: 30 },
};
let achievements = (() => { try { const a = JSON.parse(localStorage.getItem('bf_ach')); return new Set(Array.isArray(a) ? a : []); } catch { return new Set(); } })();
function unlockAch(id) {
  const a = ACHIEVEMENTS[id]; if (!a || achievements.has(id)) return;
  achievements.add(id); localStorage.setItem('bf_ach', JSON.stringify([...achievements]));
  feed('★ ACHIEVEMENT: ' + a.name + (a.reward ? ' (+' + a.reward + ' coins)' : ''), myTeam);
  try { SND.kill(); } catch {}
  renderAchievements();
  if (a.reward) awardCoins(a.reward);
}
// ---- persistent identity + friends (friend code = your player id) ----
let myPid = localStorage.getItem('bf_pid');
if (!myPid) { myPid = Math.random().toString(36).slice(2, 8).toUpperCase(); localStorage.setItem('bf_pid', myPid); }
let friends = (() => { try { const f = JSON.parse(localStorage.getItem('bf_friends')); return Array.isArray(f) ? f : []; } catch { return []; } })();
function saveFriends() { if (account) syncAccount(); else localStorage.setItem('bf_friends', JSON.stringify(friends)); }
let lobbyWs = null, lobbyTimer = null, presenceCache = {};
let menuRefresh = null; // set by setupMenu so auth changes can refresh the menu view
// ---- account (optional login; syncs coins/unlocks/friends across devices) ----
let account = null; // { user, token } when logged in
let authToken = localStorage.getItem('bf_token') || null;
let pendingRequests = [];   // incoming friend requests (account mode)
let myWins = 0, myKills = 0; // account stats (drive rank)
function xpOf(w, k) { return (w || 0) * 100 + (k || 0) * 5; }
const RANK_TIERS = [[0, 'BRONZE'], [300, 'SILVER'], [900, 'GOLD'], [2000, 'PLATINUM'], [4000, 'DIAMOND'], [8000, 'MASTER']];
function rankOf(w, k) { const xp = xpOf(w, k); let tier = 'BRONZE'; for (const [th, n] of RANK_TIERS) if (xp >= th) tier = n; return { tier, level: 1 + Math.floor(Math.sqrt(xp / 25)) }; }
let syncTimer = null;
function presenceId() { return account ? account.user : myPid; }
// Send a message over whichever socket is live (game in-game, else lobby).
function authSend(obj) {
  const s = JSON.stringify(obj);
  if (ws && ws.readyState === 1) ws.send(s);
  else if (lobbyWs && lobbyWs.readyState === 1) lobbyWs.send(s);
  else { connectLobby(); setTimeout(() => { if (lobbyWs && lobbyWs.readyState === 1) lobbyWs.send(s); }, 400); }
}
// Push coins + unlocks to the server (debounced) when logged in. Friends are
// managed server-side via requests/accept, so they're not sent here.
function syncAccount() {
  if (!account) return;
  const payload = JSON.stringify({ t: 'acct_save', token: account.token, coins, unlocked: [...unlocked] });
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => authSend(JSON.parse(payload)), 400);
}
let myAgent = (AGENTS[localStorage.getItem('blockade_agent')] && isUnlocked(localStorage.getItem('blockade_agent'))) ? localStorage.getItem('blockade_agent') : 'soldier';
let myColor = (() => { const v = parseInt(localStorage.getItem('bf_color')); return Number.isFinite(v) && v >= 0 ? v : null; })(); // custom accent, null = use class colour
const COLOR_SWATCHES = [null, 0xff5555, 0xffa53a, 0xffe23a, 0x49c26a, 0x39e6ff, 0x7f9fff, 0x9b5cff, 0xff5cc8, 0xffffff];
const hex6 = n => '#' + n.toString(16).padStart(6, '0');
const agentArtSVG = (h) => `<svg viewBox="0 0 20 24" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">
  <rect x="2" y="14" width="16" height="10" fill="#4b566d"/><rect x="2" y="14" width="16" height="2" fill="#5c6a86"/>
  <rect x="1" y="14" width="4" height="6" fill="${h}"/><rect x="15" y="14" width="4" height="6" fill="${h}"/>
  <rect x="8" y="12" width="4" height="3" fill="#d8a37a"/><rect x="6" y="4" width="8" height="9" fill="#d8a37a"/>
  <rect x="5" y="2" width="10" height="4" fill="${h}"/><rect x="6" y="6" width="8" height="2" fill="#1b2230"/>
  <rect x="7" y="9" width="2" height="2" fill="#1b2230"/><rect x="11" y="9" width="2" height="2" fill="#1b2230"/>
  <rect x="8" y="17" width="11" height="3" fill="#20262f"/><rect x="7" y="18" width="3" height="4" fill="#20262f"/>
  <rect x="9" y="15" width="6" height="2" fill="${h}"/></svg>`;
let killStreak = 0;
let multiKill = 0, lastKillTime = 0;   // rapid-frag (multi-kill) tracking
let firstBloodDone = false;            // first kill of the current match
let matchKills = 0, matchDeaths = 0, bestStreak = 0; // per-match personal stats
let lookMul = parseFloat(localStorage.getItem('bf_sens') || '1') || 1;
let fov = Math.max(60, Math.min(100, parseInt(localStorage.getItem('bf_fov')) || 70));
let sndVol = (() => { const v = parseFloat(localStorage.getItem('bf_vol')); return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.8; })();
function applyFov() { if (camera) { camera.fov = fov; camera.updateProjectionMatrix(); } }
function applyVol() { if (masterGain) masterGain.gain.value = sndVol; }
let xhColor = localStorage.getItem('bf_xh') || 'white';
const XH_COLORS = { white: null, green: '#49ff6a', cyan: '#39e6ff', red: '#ff4444', yellow: '#ffe23a', pink: '#ff5cc8' };
function applyCrosshair() {
  const root = document.documentElement.style, c = XH_COLORS[xhColor];
  if (c) { root.setProperty('--xh', c); root.setProperty('--xh-blend', 'normal'); }
  else { root.removeProperty('--xh'); root.removeProperty('--xh-blend'); }
}
applyCrosshair();
// Settings inputs exist in both the menu and the pause screen (prefix '' and 'p');
// keep them wired to the same state and in sync.
function refreshSettingInputs() {
  const S = (id, v) => { const e = document.getElementById(id); if (e) e.value = v; };
  const T = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  for (const p of ['', 'p']) {
    S(p + 'sensRange', lookMul); T(p + 'sensVal', lookMul.toFixed(2) + 'x');
    S(p + 'fovRange', fov); T(p + 'fovVal', fov);
    S(p + 'volRange', sndVol); T(p + 'volVal', Math.round(sndVol * 100) + '%');
    S(p + 'gfxSel', gfxQuality); S(p + 'xhSel', xhColor);
  }
}
function wireSettingsPanel(p) {
  const $$ = id => document.getElementById(p + id);
  const sr = $$('sensRange'); if (sr) sr.addEventListener('input', () => { lookMul = parseFloat(sr.value) || 1; localStorage.setItem('bf_sens', String(lookMul)); refreshSettingInputs(); });
  const fr = $$('fovRange'); if (fr) fr.addEventListener('input', () => { fov = parseInt(fr.value) || 70; localStorage.setItem('bf_fov', String(fov)); applyFov(); refreshSettingInputs(); });
  const vr = $$('volRange'); if (vr) vr.addEventListener('input', () => { sndVol = parseFloat(vr.value); localStorage.setItem('bf_vol', String(sndVol)); applyVol(); refreshSettingInputs(); });
  const gs = $$('gfxSel'); if (gs) gs.addEventListener('change', () => { gfxQuality = gs.value === 'low' ? 'low' : 'high'; localStorage.setItem('bf_gfx', gfxQuality); applyGfx(); refreshSettingInputs(); });
  const xs = $$('xhSel'); if (xs) xs.addEventListener('change', () => { xhColor = xs.value; localStorage.setItem('bf_xh', xhColor); applyCrosshair(); refreshSettingInputs(); });
}

const tracers = [], particles = [], flashes = [], rockets = [], grenades = [], dmgTexts = [];
function spawnDamageNumber(pos, dmg, head) {
  if (dmgTexts.length > 40) { const d = dmgTexts.shift(); scene.remove(d.obj); d.obj.material.map.dispose(); d.obj.material.dispose(); }
  const c = document.createElement('canvas'); c.width = 64; c.height = 40;
  const g = c.getContext('2d');
  g.font = 'bold 26px monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 5; g.strokeStyle = '#000'; g.strokeText(dmg, 32, 20);
  g.fillStyle = head ? '#ffdd55' : '#ffffff'; g.fillText(dmg, 32, 20);
  const tex = new THREE.CanvasTexture(c);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sp.position.copy(pos); sp.position.x += (Math.random() - 0.5) * 0.4; sp.position.y += 1.1;
  sp.scale.set(head ? 1.1 : 0.85, head ? 0.7 : 0.55, 1);
  scene.add(sp);
  dmgTexts.push({ obj: sp, ttl: 0.8 });
}

// ============================================================
// Audio (tiny synth)
// ============================================================
let AC = null, masterGain = null;
function ac() {
  if (!AC) {
    AC = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = AC.createGain(); masterGain.gain.value = sndVol; masterGain.connect(AC.destination);
  }
  return AC;
}
function noiseBurst(dur, freq, vol, type = 'lowpass') {
  try {
    const ctx = ac();
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    const g = ctx.createGain(); g.gain.value = vol;
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    src.connect(f); f.connect(g); g.connect(masterGain || ctx.destination);
    src.start();
  } catch {}
}
function tone(freq, dur, vol, type = 'square', slide = 0) {
  try {
    const ctx = ac();
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), ctx.currentTime + dur);
    const g = ctx.createGain(); g.gain.value = vol;
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    o.connect(g); g.connect(masterGain || ctx.destination);
    o.start(); o.stop(ctx.currentTime + dur);
  } catch {}
}
const SND = {
  shot: (w, vol = 0.22) => {
    if (w === 'rifle') { noiseBurst(0.09, 1800, vol); tone(160, 0.06, vol * 0.5, 'square', -90); }
    else if (w === 'shotgun') { noiseBurst(0.22, 900, vol * 1.4); tone(90, 0.13, vol * 0.7, 'square', -50); }
    else { noiseBurst(0.16, 2600, vol * 1.2); tone(220, 0.12, vol * 0.6, 'sawtooth', -160); }
  },
  hit: () => tone(880, 0.06, 0.12, 'square'),
  headshot: () => { tone(1240, 0.07, 0.14, 'square'); setTimeout(() => tone(1650, 0.08, 0.12, 'square'), 60); },
  hurt: () => tone(140, 0.18, 0.25, 'sawtooth', -60),
  death: () => { tone(300, 0.5, 0.2, 'sawtooth', -240); noiseBurst(0.4, 500, 0.15); },
  reload: () => { tone(500, 0.04, 0.1, 'square'); setTimeout(() => tone(700, 0.04, 0.1, 'square'), 120); },
  place: () => noiseBurst(0.08, 700, 0.25),
  brk: () => { noiseBurst(0.12, 420, 0.3); tone(180, 0.07, 0.12, 'square', -60); },
  swing: () => noiseBurst(0.05, 2200, 0.07, 'highpass'),
  rocket: (vol = 0.3) => { noiseBurst(0.5, 600, vol); tone(120, 0.4, vol * 0.6, 'sawtooth', 90); },
  boom: (vol = 0.5) => { noiseBurst(0.7, 250, vol); tone(70, 0.5, vol * 0.8, 'sawtooth', -40); },
  spawn: () => { tone(520, 0.08, 0.12, 'square'); setTimeout(() => tone(780, 0.1, 0.12, 'square'), 90); },
  kill: () => { tone(660, 0.07, 0.14, 'square'); setTimeout(() => tone(880, 0.07, 0.14, 'square'), 70); setTimeout(() => tone(1100, 0.1, 0.14, 'square'), 140); },
  nade: () => { tone(320, 0.05, 0.12, 'square'); noiseBurst(0.05, 1600, 0.08, 'highpass'); },
  lowhp: () => { tone(120, 0.16, 0.16, 'sine'); },
};

// ============================================================
// Menu
// ============================================================
function dirtBackground() {
  const c = document.createElement('canvas'); c.width = 16; c.height = 16;
  const g = c.getContext('2d');
  const cols = ['#5a3f29', '#523a25', '#62452d', '#4a3421'];
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    g.fillStyle = cols[Math.floor(Math.random() * cols.length)];
    g.fillRect(x, y, 1, 1);
  }
  // darken like MC menu
  g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(0, 0, 16, 16);
  document.getElementById('menu').style.backgroundImage = `url(${c.toDataURL()})`;
}

const $ = id => document.getElementById(id);

function setupMenu() {
  const input = $('nameInput'), btn = $('playBtn'), err = $('menuErr');
  input.value = localStorage.getItem('blockade_name') || '';
  input.focus();
  const diffSel = $('diffSel');
  if (diffSel) diffSel.value = localStorage.getItem('blockade_diff') || 'normal';
  const mapSel = $('mapSel');
  if (mapSel) {
    menuMap = MAP_IDS.includes(localStorage.getItem('blockade_map')) ? localStorage.getItem('blockade_map') : 'desert';
    mapSel.value = menuMap;
    mapSel.addEventListener('change', () => { menuMap = mapSel.value; localStorage.setItem('blockade_map', menuMap); });
  }

  // ---- agent (character) selection, with coin-gated unlocks ----
  const chips = $('agentchips');
  function refreshChips() {
    if (!chips) return;
    for (const c of chips.children) {
      const id = c.dataset.id;
      c.classList.toggle('sel', id === myAgent);
      c.classList.toggle('locked', !isUnlocked(id));
    }
  }
  function renderAgent() {
    const a = AGENTS[myAgent];
    const accent = (typeof myColor === 'number') ? myColor : a.accent; // custom colour preview
    $('agentArt').innerHTML = agentArtSVG(hex6(accent));
    $('agentName').textContent = a.name;
    $('agentRole').textContent = a.role;
    const cf = document.querySelector('.cardframe');
    if (cf) cf.style.borderColor = hex6(accent);
    setCoinBal();
    refreshChips();
  }
  // custom accent colour swatches
  const colorRow = $('colorRow');
  if (colorRow) {
    colorRow.innerHTML = '';
    COLOR_SWATCHES.forEach(col => {
      const sw = document.createElement('div');
      sw.className = 'sw' + (col === null ? ' def' : '') + (col === myColor ? ' sel' : '');
      if (col !== null) sw.style.background = hex6(col);
      sw.addEventListener('click', () => {
        myColor = col;
        if (col === null) localStorage.removeItem('bf_color'); else localStorage.setItem('bf_color', String(col));
        for (const s of colorRow.children) s.classList.remove('sel');
        sw.classList.add('sel');
        renderAgent();
      });
      colorRow.appendChild(sw);
    });
  }
  // Clicking an owned class selects it; clicking a locked class buys it if you
  // have enough coins, otherwise tells you how many more you need.
  function buyOrPick(id) {
    if (!AGENTS[id]) return;
    const err = $('menuErr');
    if (isUnlocked(id)) {
      myAgent = id; localStorage.setItem('blockade_agent', id);
      if (err) err.textContent = '';
      renderAgent();
      return;
    }
    const cost = AGENTS[id].cost || 0;
    if (coins >= cost) {
      coins -= cost; saveCoins(); unlocked.add(id); saveUnlocked();
      myAgent = id; localStorage.setItem('blockade_agent', id);
      if (err) err.textContent = `Unlocked ${AGENTS[id].name}!`;
      renderAgent();
      if (AGENT_IDS.every(isUnlocked)) unlockAch('unlockall');
    } else {
      if (err) err.innerHTML = `${AGENTS[id].name} is locked — need ${cost - coins} more ${COIN} (you have ${coins})`;
    }
  }
  function cycle(dir) {
    const owned = AGENT_IDS.filter(isUnlocked);
    const i = Math.max(0, owned.indexOf(myAgent));
    const n = owned[(i + dir + owned.length) % owned.length];
    if (n) { myAgent = n; localStorage.setItem('blockade_agent', n); renderAgent(); }
  }
  if (chips) {
    chips.innerHTML = '';
    for (const id of AGENT_IDS) {
      const c = document.createElement('div');
      c.className = 'chip'; c.dataset.id = id;
      const lock = isUnlocked(id) ? '' : `<b class="lk">🔒${AGENTS[id].cost}</b>`;
      c.innerHTML = `<i style="background:${hex6(AGENTS[id].accent)}"></i>${AGENTS[id].name}${lock}`;
      c.addEventListener('click', () => buyOrPick(id));
      chips.appendChild(c);
    }
  }
  $('agentPrev') && $('agentPrev').addEventListener('click', () => cycle(-1));
  $('agentNext') && $('agentNext').addEventListener('click', () => cycle(1));
  renderAgent();

  // game mode selection (Deathmatch / Capture the Flag)
  { const sm = localStorage.getItem('blockade_mode'); menuMode = (sm === 'ctf' || sm === 'gg' || sm === 'dom' || sm === 'surv') ? sm : 'dm'; }
  const modes = document.querySelectorAll('#modeRow .mode');
  const syncModes = () => modes.forEach(el => el.classList.toggle('active', el.dataset.mode === menuMode));
  modes.forEach(el => el.addEventListener('click', () => { menuMode = el.dataset.mode; localStorage.setItem('blockade_mode', menuMode); syncModes(); }));
  syncModes();

  // options panel toggle
  const optBtn = $('optBtn');
  if (optBtn) optBtn.addEventListener('click', () => $('optPanel').classList.toggle('open'));

  // graphics / FOV / volume / crosshair — wired for both the menu and pause panels
  wireSettingsPanel('');
  wireSettingsPanel('p');
  refreshSettingInputs();
  const start = () => {
    const name = input.value.trim();
    if (name.length < 2) { err.textContent = 'Nickname must be at least 2 characters!'; return; }
    if (diffSel) { botDiff = diffSel.value; localStorage.setItem('blockade_diff', botDiff); }
    localStorage.setItem('blockade_name', name);
    btn.disabled = true; err.textContent = '';
    connect(name);
  };
  btn.addEventListener('click', start);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') start(); });


  // private room invite: generate a room code if none, copy the link
  const inv = $('inviteBtn');
  if (inv) inv.addEventListener('click', () => {
    if (!myRoom) {
      myRoom = Math.random().toString(36).slice(2, 8);
      const u = new URL(location.href); u.searchParams.set('room', myRoom);
      history.replaceState(null, '', u);
    }
    const link = location.href;
    if (navigator.clipboard) navigator.clipboard.writeText(link).then(() => {
      inv.textContent = 'LINK COPIED ✓'; setTimeout(() => inv.textContent = 'INVITE FRIENDS', 1600);
    }).catch(() => { inv.textContent = link; });
    else inv.textContent = link;
  });
  if (myRoom && inv) inv.textContent = 'ROOM: ' + myRoom + ' (copy link)';

  // let auth changes refresh the menu view (coins, chips, friends, auth state)
  menuRefresh = () => { renderAgent(); renderFriends(); renderAuth(); setCoinBal(); updateProfileCard(); renderCareer(); renderShop(); };

  // ---- account panel ----
  renderAuth();
  const abtn = $('authBtn');
  if (abtn) abtn.addEventListener('click', () => { $('authPanel').classList.toggle('open'); connectLobby(); });
  $('loginBtn') && $('loginBtn').addEventListener('click', () => doAuth('login'));
  $('registerBtn') && $('registerBtn').addEventListener('click', () => doAuth('register'));
  $('logoutBtn') && $('logoutBtn').addEventListener('click', () => logout());
  $('authPass') && $('authPass').addEventListener('keydown', e => { if (e.key === 'Enter') doAuth('login'); });

  // ---- friends panel ----
  connectLobby();
  renderFriends();
  const fb = $('friendsBtn');
  if (fb) fb.addEventListener('click', () => { $('friendsPanel').classList.toggle('open'); connectLobby(); requestPresence(); });
  const fin = $('friendCodeInput'), fadd = $('friendAddBtn');
  if (fadd && fin) fadd.addEventListener('click', () => { addFriend(fin.value); fin.value = ''; });
  if (fin) fin.addEventListener('keydown', e => { if (e.key === 'Enter') { addFriend(fin.value); fin.value = ''; } });
  const cc = $('copyCodeBtn');
  if (cc) cc.addEventListener('click', () => {
    if (navigator.clipboard) navigator.clipboard.writeText(presenceId()).then(() => { cc.textContent = 'COPIED ✓'; setTimeout(() => cc.textContent = 'COPY', 1400); }).catch(() => {});
  });
  renderRequests();

  // ---- daily reward ----
  const db = $('dailyBtn');
  if (db) db.addEventListener('click', () => {
    if (!account) { $('dailyMsg') && ($('dailyMsg').textContent = 'Log in to claim daily coins'); return; }
    authSend({ t: 'daily_claim', token: account.token });
  });

  // ---- leaderboard ----
  const lb = $('leaderBtn');
  if (lb) lb.addEventListener('click', () => { $('leaderPanel').classList.toggle('open'); connectLobby(); authSend({ t: 'leaderboard' }); });

  // ---- achievements panel ----
  const aw = $('awardsBtn');
  if (aw) aw.addEventListener('click', () => { $('awardsPanel').classList.toggle('open'); renderAchievements(); });
  renderAchievements();

  // ---- career (battle pass) + cosmetics shop ----
  const PANELS = ['authPanel', 'friendsPanel', 'leaderPanel', 'awardsPanel', 'optPanel', 'careerPanel', 'shopPanel'];
  const syncModal = () => { const on = PANELS.some(p => { const e = $(p); return e && e.classList.contains('open'); }); const bd = $('modalBackdrop'), cx = $('modalClose'); if (bd) bd.classList.toggle('on', on); if (cx) cx.classList.toggle('on', on); };
  const closeAllPanels = () => { PANELS.forEach(p => { const e = $(p); if (e) e.classList.remove('open'); }); stopPreview(); syncModal(); };
  const togglePanel = id => { const el = $(id); const was = el.classList.contains('open'); closeAllPanels(); if (!was) el.classList.add('open'); syncModal(); };
  // route every panel button through the exclusive modal toggler (fixes overlap)
  [['authBtn', 'authPanel', () => connectLobby()], ['friendsBtn', 'friendsPanel', () => { connectLobby(); requestPresence(); }],
   ['leaderBtn', 'leaderPanel', () => { connectLobby(); authSend({ t: 'leaderboard' }); }], ['awardsBtn', 'awardsPanel', () => renderAchievements()],
   ['optBtn', 'optPanel', () => {}]]
    .forEach(([b, p, fn]) => { const el = $(b); if (el) { const clone = el.cloneNode(true); el.replaceWith(clone); clone.addEventListener('click', () => { togglePanel(p); fn(); }); } });
  const bd = $('modalBackdrop'); if (bd) bd.addEventListener('click', closeAllPanels);
  const mcx = $('modalClose'); if (mcx) mcx.addEventListener('click', closeAllPanels);
  document.addEventListener('keydown', e => { if (e.code === 'Escape' && !inGame) closeAllPanels(); });
  const careerBtn = $('careerBtn'); if (careerBtn) careerBtn.addEventListener('click', () => { togglePanel('careerPanel'); renderCareer(); });
  const shopBtn = $('shopBtn'); if (shopBtn) shopBtn.addEventListener('click', () => { togglePanel('shopPanel'); renderShop(); });
  document.querySelectorAll('#shopTabs .shopcat').forEach(t => t.addEventListener('click', () => { shopCat = t.dataset.cat; renderShop(); }));
  // nav tabs: PLAY (close panels), CAREER, COSMETICS
  document.querySelectorAll('#navtabs .tab').forEach(tab => tab.addEventListener('click', () => {
    const to = tab.dataset.view;
    document.querySelectorAll('#navtabs .tab').forEach(t => t.classList.toggle('active', t === tab));
    if (to === 'career') { togglePanel('careerPanel'); renderCareer(); }
    else if (to === 'shop') { togglePanel('shopPanel'); renderShop(); }
    else closeAllPanels();
  }));
  updateProfileCard(); renderCareer(); renderShop();
}

// ============================================================
// Friends / presence (lightweight lobby socket used only in the menu)
// ============================================================
function wsBase() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const base = location.pathname.replace(/\/+$/, '');
  return `${proto}://${location.host}${base}/ws`;
}
function connectLobby() {
  if (lobbyWs && (lobbyWs.readyState === 0 || lobbyWs.readyState === 1)) { requestPresence(); return; }
  try { lobbyWs = new WebSocket(wsBase()); } catch { return; }
  lobbyWs.onopen = () => {
    if (authToken && !account) lobbyWs.send(JSON.stringify({ t: 'auth_token', token: authToken }));
    lobbyWs.send(JSON.stringify({ t: 'hello', pid: presenceId(), name: (account ? account.user : (localStorage.getItem('blockade_name') || 'Player')) }));
    requestPresence();
  };
  lobbyWs.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } handleAccountMsg(m); };
  lobbyWs.onclose = () => { lobbyWs = null; };
  if (!lobbyTimer) lobbyTimer = setInterval(requestPresence, 4000);
}
function requestPresence() {
  if (lobbyWs && lobbyWs.readyState === 1) lobbyWs.send(JSON.stringify({ t: 'presence_req', pids: friends.map(f => f.code) }));
}
function closeLobby() {
  if (lobbyTimer) { clearInterval(lobbyTimer); lobbyTimer = null; }
  if (lobbyWs) { try { lobbyWs.close(); } catch {} lobbyWs = null; }
}
function addFriend(code, name) {
  code = String(code || '').trim().toLowerCase().slice(0, 16);
  if (!code || code === presenceId().toLowerCase()) return;
  if (account) { // logged in → send a friend request (needs mutual accept)
    authSend({ t: 'friend_request', token: account.token, to: code });
    const fm = $('friendMsg'); if (fm) fm.textContent = 'Request sent to ' + code + '…';
    return;
  }
  if (friends.some(f => f.code === code)) return;
  friends.push({ code, name: String(name || '').trim().slice(0, 16) || code });
  saveFriends(); renderFriends(); requestPresence();
}
function removeFriend(code) {
  if (account) { authSend({ t: 'friend_remove', token: account.token, from: code }); return; }
  friends = friends.filter(f => f.code !== code); saveFriends(); renderFriends();
}
function renderRequests() {
  const box = $('friendRequests'); if (!box) return;
  box.innerHTML = '';
  if (!account || !pendingRequests.length) return;
  const h = document.createElement('div'); h.className = 'freqh'; h.textContent = 'FRIEND REQUESTS'; box.appendChild(h);
  for (const from of pendingRequests) {
    const row = document.createElement('div'); row.className = 'frow';
    const nm = document.createElement('span'); nm.className = 'fname'; nm.textContent = from; row.appendChild(nm);
    const btns = document.createElement('span'); btns.className = 'fbtns';
    const a = document.createElement('button'); a.textContent = '✓'; a.className = 'fjoin'; a.title = 'Accept';
    a.addEventListener('click', () => authSend({ t: 'friend_accept', token: account.token, from })); btns.appendChild(a);
    const d = document.createElement('button'); d.textContent = '✕'; d.className = 'fdel'; d.title = 'Decline';
    d.addEventListener('click', () => authSend({ t: 'friend_decline', token: account.token, from })); btns.appendChild(d);
    row.appendChild(btns); box.appendChild(row);
  }
}
function onDaily(m) {
  const el = $('dailyMsg');
  if (m.ok) { coins = m.coins; setCoinBal(); if (el) el.innerHTML = '+' + m.reward + ' ' + COIN + ' claimed!'; }
  else if (el) { el.textContent = m.error || 'not available'; if (m.next) { const h = Math.max(0, Math.ceil((m.next - Date.now()) / 3600000)); el.textContent += ' (~' + h + 'h)'; } }
}
function renderLeaderboard(list) {
  const box = $('leaderList'); if (!box) return;
  box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="fempty">No players yet.</div>'; return; }
  list.forEach((e, i) => {
    const row = document.createElement('div'); row.className = 'lrow';
    row.innerHTML = `<span class="lrank">${i + 1}</span><span class="lname">${e.user}</span><span class="ltier">${rankOf(e.wins, e.kills).tier}</span><span class="lwin">${e.wins}W</span><span class="lco">${e.coins} ${COIN}</span>`;
    box.appendChild(row);
  });
}
function renderAchievements() {
  const box = $('awardsList'); if (!box) return;
  box.innerHTML = '';
  for (const [id, a] of Object.entries(ACHIEVEMENTS)) {
    const have = achievements.has(id);
    const row = document.createElement('div'); row.className = 'arow' + (have ? ' have' : '');
    row.innerHTML = `<span class="amark">${have ? '★' : '·'}</span><span class="aname">${a.name}</span>` + (a.reward ? `<span class="arew">+${a.reward} ${COIN}</span>` : '');
    box.appendChild(row);
  }
}
// Account/social messages that can arrive on either socket.
function handleAccountMsg(m) {
  switch (m.t) {
    case 'auth': onAuth(m); return true;
    case 'presence': presenceCache = m.online || {}; renderFriends(); return true;
    case 'friend_request_res': { const fm = $('friendMsg'); if (fm) fm.textContent = m.ok ? ('Request sent to ' + m.to) : (m.error || 'failed'); return true; }
    case 'friend_req_in': if (!pendingRequests.includes(m.from)) pendingRequests.push(m.from); renderRequests(); { const fm = $('friendMsg'); if (fm) fm.textContent = 'New request from ' + m.from; } return true;
    case 'friend_added': if (!friends.some(f => f.code === m.user)) friends.push({ code: m.user, name: m.user }); renderFriends(); requestPresence(); return true;
    case 'friend_update':
      if (Array.isArray(m.friends)) friends = m.friends.map(u => ({ code: u, name: u }));
      if (Array.isArray(m.requests)) pendingRequests = m.requests;
      renderFriends(); renderRequests(); requestPresence(); return true;
    case 'daily': onDaily(m); return true;
    case 'leaderboard': renderLeaderboard(m.list || []); return true;
  }
  return false;
}
function joinFriend(room) {
  const nm = ($('nameInput').value || '').trim() || localStorage.getItem('blockade_name') || '';
  if (nm.length < 2) { $('menuErr').textContent = 'Enter a nickname first!'; return; }
  myRoom = room;
  const u = new URL(location.href); u.searchParams.set('room', room); history.replaceState(null, '', u);
  localStorage.setItem('blockade_name', nm);
  $('playBtn').disabled = true;
  connect(nm);
}
function renderFriends() {
  const codeEl = $('myCode'); if (codeEl) codeEl.textContent = presenceId();
  const list = $('friendsList'); if (!list) return;
  list.innerHTML = '';
  if (!friends.length) { list.innerHTML = '<div class="fempty">No friends yet — share your code and add theirs.</div>'; return; }
  for (const f of friends) {
    const p = presenceCache[f.code];
    const online = !!p;
    const room = online && p.room && p.room !== 'lobby' ? p.room : null;
    const row = document.createElement('div'); row.className = 'frow';
    const dot = document.createElement('span'); dot.className = 'fdot ' + (online ? 'on' : 'off'); row.appendChild(dot);
    const nm = document.createElement('span'); nm.className = 'fname'; nm.textContent = f.name || f.code; row.appendChild(nm);
    const st = document.createElement('span'); st.className = 'fstat'; st.textContent = online ? (room ? 'room ' + room : 'online') : 'offline'; row.appendChild(st);
    const btns = document.createElement('span'); btns.className = 'fbtns';
    if (room) { const j = document.createElement('button'); j.textContent = 'JOIN'; j.className = 'fjoin'; j.addEventListener('click', () => joinFriend(room)); btns.appendChild(j); }
    const d = document.createElement('button'); d.textContent = '✕'; d.className = 'fdel'; d.addEventListener('click', () => removeFriend(f.code)); btns.appendChild(d);
    row.appendChild(btns); list.appendChild(row);
  }
}
function onAuth(m) {
  const msg = $('authMsg');
  if (m.ok) {
    account = { user: m.user, token: m.token };
    authToken = m.token; localStorage.setItem('bf_token', m.token);
    const pr = m.profile || {};
    coins = pr.coins || 0;
    unlocked = new Set((pr.unlocked && pr.unlocked.length) ? pr.unlocked : ['soldier']); unlocked.add('soldier');
    friends = Array.isArray(pr.friends) ? pr.friends.map(u => ({ code: u, name: u })) : [];
    pendingRequests = Array.isArray(pr.requests) ? pr.requests : [];
    myWins = pr.wins || 0; myKills = pr.kills || 0;
    if (!isUnlocked(myAgent)) { myAgent = 'soldier'; localStorage.setItem('blockade_agent', 'soldier'); }
    if (msg) msg.textContent = '';
    if (lobbyWs && lobbyWs.readyState === 1) lobbyWs.send(JSON.stringify({ t: 'hello', pid: presenceId(), name: m.user }));
    renderAuth(); renderRequests(); if (menuRefresh) menuRefresh(); requestPresence();
  } else if (msg) { msg.textContent = m.error || 'Auth failed'; }
}
function doAuth(kind) {
  const u = ($('authUser')?.value || '').trim(), p = $('authPass')?.value || '';
  if (u.length < 3) { $('authMsg').textContent = 'Username min 3 characters'; return; }
  if (p.length < 4) { $('authMsg').textContent = 'Password min 4 characters'; return; }
  connectLobby();
  $('authMsg').textContent = '…';
  const send = (tries) => {
    if (lobbyWs && lobbyWs.readyState === 1) lobbyWs.send(JSON.stringify({ t: kind, user: u, pass: p }));
    else if (tries > 0) setTimeout(() => send(tries - 1), 200);
    else $('authMsg').textContent = 'Not connected — try again';
  };
  send(15);
}
function logout() {
  account = null; authToken = null; localStorage.removeItem('bf_token');
  coins = Math.max(0, parseInt(localStorage.getItem('bf_coins')) || 0);
  try { const u = JSON.parse(localStorage.getItem('bf_unlocked')); unlocked = new Set(Array.isArray(u) ? u : ['soldier']); } catch { unlocked = new Set(['soldier']); }
  unlocked.add('soldier');
  try { const f = JSON.parse(localStorage.getItem('bf_friends')); friends = Array.isArray(f) ? f : []; } catch { friends = []; }
  pendingRequests = []; myWins = 0; myKills = 0;
  if (!isUnlocked(myAgent)) { myAgent = 'soldier'; localStorage.setItem('blockade_agent', 'soldier'); }
  if (lobbyWs && lobbyWs.readyState === 1) lobbyWs.send(JSON.stringify({ t: 'hello', pid: presenceId(), name: (localStorage.getItem('blockade_name') || 'Player') }));
  renderAuth(); renderRequests(); if (menuRefresh) menuRefresh(); requestPresence();
}
function renderAuth() {
  const inEl = $('authLoggedOut'), outEl = $('authLoggedIn');
  if (!inEl || !outEl) return;
  if (account) {
    inEl.style.display = 'none'; outEl.style.display = 'flex'; $('authWho').textContent = account.user;
    const rk = rankOf(myWins, myKills), re = $('authRank');
    if (re) re.textContent = `${rk.tier} · Lv ${rk.level} · ${myWins}W / ${myKills}K`;
  } else { inEl.style.display = 'flex'; outEl.style.display = 'none'; }
}

// Leave the current match and go back to the main menu.
function leaveGame() {
  try { document.exitPointerLock(); } catch {}
  hideMatchOver();
  hideZone();
  clearTurrets();
  { const wh = $('waveHud'); if (wh) wh.style.display = 'none'; const st = $('scoreTop'); if (st) st.style.display = ''; }
  const ph = $('pauseHint'); if (ph) ph.style.display = 'none';
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) { try { ws.close(); } catch {} } // onclose returns to the menu
  else { inGame = false; $('hud').style.display = 'none'; $('menu').style.display = 'flex'; connectLobby(); }
}

// ============================================================
// Networking
// ============================================================
function connect(name) {
  myName = name;
  closeLobby(); // hand presence over to the game socket
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // Served under a subpath (/play/<game>/); engine exposes the game socket at <base>/ws.
  const base = location.pathname.replace(/\/+$/, '');
  ws = new WebSocket(`${proto}://${location.host}${base}/ws`);
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name, room: myRoom, diff: botDiff, agent: myAgent, mode: menuMode, map: menuMap, pid: presenceId(), acct: account ? account.user : null, color: (typeof myColor === 'number' ? myColor : undefined), title: titleText(equippedTitle), charSkin: equippedChar }));
  ws.onerror = () => { $('menuErr').textContent = 'Failed to connect to the server'; $('playBtn').disabled = false; };
  ws.onclose = () => {
    if (inGame) {
      inGame = false;
      closeChat();
      closeAllVoice();
      document.exitPointerLock();
      $('hud').style.display = 'none';
      $('menu').style.display = 'flex';
      $('menuErr').textContent = 'Connection lost. Join again!';
      $('playBtn').disabled = false;
      connectLobby(); // resume friend presence in the menu
    }
  };
  ws.onmessage = e => {
    dbgNet.inMsgs++; dbgNet.inBytes += e.data.length;
    dbgLastPayload = e.data.length;
    handleMsg(JSON.parse(e.data));
  };
}

function netSend(msg) {
  if (!ws || ws.readyState !== 1) return;
  const s = JSON.stringify(msg);
  dbgNet.outMsgs++; dbgNet.outBytes += s.length;
  ws.send(s);
}

function handleMsg(m) {
  switch (m.t) {
    case 'welcome': {
      myId = m.id; myTeam = m.team;
      me.pos.set(m.pos.x, m.pos.y, m.pos.z);
      me.ry = m.ry; me.rx = 0;
      Object.assign(scores, m.scores);
      gameMode = m.mode || 'dm';
      scoreLimit = m.limit || m.scoreLimit || 150;
      applyTheme(m.map || 'desert');
      buildWorld(m.map || 'desert'); // rebuild geometry for this room's (random) map
      buildPickups(m.pickups);
      updateCount(m.count);
      for (const p of m.players) addRemote(p);
      // destroyed map blocks first, then player-built blocks (a built block may occupy a destroyed spot)
      for (const d of m.destroyed || []) removeBlockLocal(d.x, d.y, d.z, true);
      for (const b of m.placed) placeBlockLocal(b.x, b.y, b.z, b.team);
      if (gameMode === 'ctf') { ensureFlags(); if (m.flags) updateFlagMeshes(m.flags); }
      if (gameMode === 'dom') { ensureZone(); if (m.zone) updateZoneState(m.zone); } else hideZone();
      clearTurrets(); if (m.turrets) for (const t of m.turrets) addTurret(t);
      if (gameMode === 'surv') { waveNum = m.wave || 0; }
      if (gameMode === 'gg') { myLevel = 0; }
      startGame();
      matchStart = performance.now();
      matchKills = 0; matchDeaths = 0; bestStreak = 0; lastKilledBy = null; for (const k in nemesisDeaths) delete nemesisDeaths[k]; me.shieldUntil = 0;
      setGunGameUI(gameMode === 'gg');
      if (gameMode === 'gg') applyGunGameWeapon();
      feed('MAP: ' + (THEMES[mapTheme]?.name || mapTheme), myTeam);
      initVoice();
      break;
    }
    case 'join': addRemote(m.p); if (!m.p.bot) feed(`${m.p.name} joined the game`, m.p.team); break;
    case 'leave': {
      const r = remotes.get(m.id);
      if (r) { if (!r.bot) feed(`${r.name} left`, r.team); scene.remove(r.group); remotes.delete(m.id); }
      closeVoicePeer(m.id);
      break;
    }
    case 'pong': dbgOnPong(m); break;
    case 'pickup': { const pm = pickupMeshes[m.i]; if (pm) pm.mesh.visible = m.active !== false; if (m.active === false) SND.spawn(); break; }
    case 'rank': {
      const rr = remotes.get(m.id);
      if (rr && rr.group.userData.nameSprite) {
        const ud = rr.group.userData;
        rr.group.remove(ud.nameSprite);
        const ns = makeNameSprite(ud.name, ud.team, m.tier, ud.title);
        rr.group.add(ns); ud.nameSprite = ns; ud.tier = m.tier;
      }
      break;
    }
    case 'supply': { me.nades = AGENTS[myAgent]?.nades ?? MAX_NADES; me.blocks = AGENTS[myAgent]?.blocks || 64; updateAmmoHud(); updateHotbar(); SND.spawn(); announce('SUPPLIES!', '#7dd3fc'); break; }
    case 'flag': {
      const tn = m.team === 'red' ? 'Red' : 'Blue';
      if (m.ev === 'pickup') { feed(`${m.name || 'Someone'} grabbed the ${tn} flag!`, m.team); SND.spawn(); }
      else if (m.ev === 'capture') { feed(`${m.name || 'Someone'} captured the ${tn} flag!`, m.team); SND.kill(); announce('FLAG CAPTURED!', '#ffd24a'); }
      else if (m.ev === 'returned') { feed(`The ${tn} flag was returned.`, m.team); }
      else if (m.ev === 'drop') { feed(`The ${tn} flag was dropped!`, m.team); }
      break;
    }
    case 'wave': {
      if (m.ev === 'start') {
        waveNum = m.wave;
        announce(`WAVE ${m.wave} — ${m.enemies} RAIDERS!`, '#ff7733'); SND.spawn();
        feed(`Wave ${m.wave} incoming — ${m.enemies} raiders!`, myTeam);
      } else if (m.ev === 'clear') {
        announce(`WAVE ${m.wave} CLEARED!  +${m.reward}`, '#ffd24a'); SND.kill();
        awardCoins(m.reward || 0);
        awardXp((m.wave || 1) * 15);
        feed(`Wave ${m.wave} cleared! Next wave soon…`, myTeam);
      }
      break;
    }
    case 'zone': {
      if (m.ev === 'capture') {
        const tn = m.team === 'red' ? 'RED' : 'BLUE';
        feed(`${tn} captured the zone!`, m.team);
        if (m.team === myTeam) { announce('ZONE CAPTURED!', '#ffd24a'); SND.kill(); }
        else announce('ENEMY TOOK THE ZONE', '#ff5555');
      }
      break;
    }
    case 'states':
      dbgOnStates(m);
      if (m.flags) updateFlagMeshes(m.flags);
      if (m.zone) updateZoneState(m.zone);
      for (const s of m.states) {
        if (s.id === myId) continue;
        const r = remotes.get(s.id);
        if (!r) continue;
        r.target.set(s.pos.x, s.pos.y, s.pos.z);
        r.try = s.ry; r.trx = s.rx; r.anim = s.anim || 0; r.hp = s.hp;
        if (!r.alive) { r.alive = true; r.group.visible = true; }
      }
      break;
    case 'shoot': {
      const r = remotes.get(m.id);
      const from = new THREE.Vector3(m.from.x, m.from.y, m.from.z);
      const dir = new THREE.Vector3(m.dir.x, m.dir.y, m.dir.z);
      const dist = camera ? from.distanceTo(me.pos) : 50;
      if (m.w === 'bazooka') {
        spawnRocket(from, dir, false);
        SND.rocket(Math.max(0.03, 0.3 * Math.min(1, 14 / (dist + 1))));
      } else {
        spawnTracer(from, dir, m.w, undefined, m.tc);
        SND.shot(m.w, Math.max(0.02, 0.25 * Math.min(1, 14 / (dist + 1))));
      }
      if (r) r.shootAnim = 0.12;
      const tm = m.turret && turretMeshes.get(m.id);
      if (tm) tm.userData.head.rotation.y = Math.atan2(-m.dir.x, -m.dir.z);
      break;
    }
    case 'turret': addTurret(m); break;
    case 'turretgone': removeTurret(m.id); break;
    case 'hp': {
      me.hp = m.hp;
      updateHearts();
      SND.hurt();
      const v = $('dmgVignette');
      v.style.opacity = 1; setTimeout(() => v.style.opacity = 0, 120);
      if (m.from) showDamageDir(m.from.x, m.from.z);
      break;
    }
    case 'heal': {
      if (!me.dead) { me.hp = m.hp; updateHearts(); } // passive regen — no hurt fx
      if (m.streak) { announce(`${m.streak} KILL STREAK — HEALED!`); SND.spawn(); }
      break;
    }
    case 'buff': {
      if (m.kind === 'overshield' && !me.dead) {
        me.shieldUntil = performance.now() + (m.ms || 10000);
        announce(`OVERSHIELD!  ${m.streak || ''} STREAK`, '#5ad1ff');
        SND.spawn();
        unlockAch('overshield');
      }
      break;
    }
    case 'hitconfirm': {
      const hm = $('hitmarker');
      hm.classList.toggle('head', m.head);
      hm.style.opacity = 1;
      clearTimeout(hm._t); hm._t = setTimeout(() => hm.style.opacity = 0, 120);
      m.head ? SND.headshot() : SND.hit();
      break;
    }
    case 'death': {
      const victim = m.victim === myId ? null : remotes.get(m.victim);
      const killer = m.killer === myId ? null : remotes.get(m.killer);
      const vName = victim ? victim.name : myName;
      const vTeam = victim ? victim.team : myTeam;
      const kName = killer ? killer.name : myName;
      const kTeam = killer ? killer.team : myTeam;
      const WLABEL = { rifle: 'RIFLE', smg: 'SMG', shotgun: 'SHOTGUN', sniper: 'SNIPER', lmg: 'LMG', pistol: 'PISTOL', bazooka: 'ROCKET', pickaxe: 'MELEE', turret: 'TURRET' };
      const wl = WLABEL[m.w] || 'RIFLE';
      feed(`${kName} [${wl}]${m.head ? ' HS' : ''} ► ${vName}`, kTeam, vTeam);
      // First blood: the first genuine kill of the match gets a shout-out.
      if (!firstBloodDone && m.killer !== m.victim) {
        firstBloodDone = true;
        if (m.killer === myId) { announce('FIRST BLOOD!', '#ff3b3b'); SND.kill(); }
        else feed(`FIRST BLOOD — ${kName}`, kTeam);
      }
      if (victim) {
        victim.alive = false; victim.deaths++;
        deathBurst(victim.group.position);
        victim.group.visible = false;
      }
      if (killer) killer.kills++;
      if (m.victim === myId) {
        me.hp = 0; me.dead = true; me.deaths++; matchDeaths++;
        killStreak = 0; multiKill = 0; me.shieldUntil = 0;
        updateHearts();
        SND.death();
        showDeathScreen(kName);
        // Track who's picking on you — 3 kills makes them your nemesis.
        if (m.killer !== myId) {
          lastKilledBy = m.killer;
          nemesisDeaths[m.killer] = (nemesisDeaths[m.killer] || 0) + 1;
          if (nemesisDeaths[m.killer] === 3) feed(`NEMESIS: ${kName} has killed you 3 times!`, vTeam);
        }
      }
      if (m.killer === myId && m.victim !== myId) {
        me.kills++; matchKills++; SND.kill(); onMyKill();
        // skin-tinted kill burst at the victim
        if (victim) { const kp = victim.group.position.clone(); kp.y += 1.0; burst(kp, myTracerColor(SLOTS[me.slot]), 26, 6); }
        if (lastKilledBy && m.victim === lastKilledBy) { // paid them back
          announce('REVENGE!', '#ffd24a'); awardCoins(15); unlockAch('revenge'); lastKilledBy = null;
        }
      }
      break;
    }
    case 'level': {
      if (m.id === myId) {
        myLevel = m.level;
        if (m.demote) { announce('HUMILIATED!  −1 LEVEL', '#ff5555'); SND.hurt(); }
        else if (m.up && myLevel < GG_LADDER.length) {
          announce('LEVEL UP!  ► ' + (WEAPONS[ggWeaponKey()]?.name || ''), '#7dd3fc'); SND.spawn();
        }
        me.reloading = false; $('reloadLbl').style.display = 'none';
        const k = ggWeaponKey(); if (WEAPONS[k]?.mag) me.ammo[k] = WEAPONS[k].mag;
        applyGunGameWeapon();
      } else if (m.up) {
        const r = remotes.get(m.id);
        if (r) { r.level = m.level; if (m.level >= GG_LADDER.length - 1) feed(`${m.name} reached the final weapon!`, r.team); }
      }
      break;
    }
    case 'respawn': {
      if (m.id === myId) {
        me.pos.set(m.pos.x, m.pos.y, m.pos.z);
        me.vel.set(0, 0, 0);
        me.hp = 100; me.dead = false; me.shieldUntil = 0;
        me.ammo = { rifle: 30, smg: 28, shotgun: 6, sniper: 5, lmg: 60, pistol: 12, bazooka: 1 };
        me.blocks = AGENTS[myAgent]?.blocks || 64; me.nades = AGENTS[myAgent]?.nades ?? MAX_NADES; me.reloading = false;
        me.ry = myTeam === 'red' ? -Math.PI / 2 : Math.PI / 2; me.rx = 0;
        updateHearts(); updateAmmoHud(); updateHotbar();
        if (gameMode === 'gg') applyGunGameWeapon();
        $('deathScreen').style.display = 'none';
        const f = $('respawnFlash');
        f.style.opacity = 0.8; f.style.transition = 'none';
        requestAnimationFrame(() => { f.style.transition = 'opacity .6s'; f.style.opacity = 0; });
        SND.spawn();
      } else {
        const r = remotes.get(m.id);
        if (r) {
          r.alive = true; r.hp = 100;
          r.group.position.set(m.pos.x, m.pos.y, m.pos.z);
          r.target.set(m.pos.x, m.pos.y, m.pos.z);
          r.group.visible = true;
        }
      }
      break;
    }
    case 'place':
      placeBlockLocal(m.x, m.y, m.z, m.team);
      break;
    case 'destroy':
      removeBlockLocal(m.x, m.y, m.z);
      break;
    case 'nade':
      spawnGrenade(new THREE.Vector3(m.from.x, m.from.y, m.from.z),
                   new THREE.Vector3(m.vel.x, m.vel.y, m.vel.z), false);
      break;
    case 'rtc':
      handleRtcSignal(m.from, m.data);
      break;
    case 'scores':
      Object.assign(scores, m.scores);
      $('scoreRed').textContent = scores.red;
      $('scoreBlue').textContent = scores.blue;
      break;
    case 'chat':
      addChatMessage(m.name, m.team, (m.whisper ? '🔒 ' : '') + m.text);
      break;
    case 'roster':
      updateCount(m.count);
      break;
    case 'matchover':
      showMatchOver(m.winner, m.scores, m.winnerName);
      break;
    case 'matchstart':
      Object.assign(scores, m.scores);
      $('scoreRed').textContent = scores.red;
      $('scoreBlue').textContent = scores.blue;
      killStreak = 0; multiKill = 0; firstBloodDone = false;
      matchKills = 0; matchDeaths = 0; bestStreak = 0; lastKilledBy = null; for (const k in nemesisDeaths) delete nemesisDeaths[k]; me.shieldUntil = 0;
      matchStart = performance.now();
      for (const pm of pickupMeshes) pm.mesh.visible = true; // packs come back next match
      hideMatchOver();
      resetWorld();
      if (gameMode === 'gg') { myLevel = 0; applyGunGameWeapon(); }
      waveNum = 0; clearTurrets();
      feed(gameMode === 'ctf' ? `New match — capture ${scoreLimit} flags to win!`
         : gameMode === 'gg' ? `New match — work through all ${scoreLimit} weapons to win!`
         : gameMode === 'dom' ? `New match — hold the zone to ${scoreLimit} points!`
         : gameMode === 'surv' ? `New run — survive all ${scoreLimit} waves!`
         : `New match — first to ${scoreLimit} kills wins!`, myTeam);
      break;
    default: handleAccountMsg(m); // account/social messages can arrive on the game socket too
  }
}

// ---- player count / match banners / kill streak (HUD helpers) ----
function updateCount(n) {
  if (typeof n !== 'number') return;
  const el = $('playerCount');
  if (el) el.textContent = '◉ ' + n;
}
// End-of-match MVP + personal medals (with one-time coin bonuses).
function renderMatchAwards() {
  const box = $('matchAwards'); if (!box) return;
  const all = [{ name: myName, kills: matchKills, me: true },
    ...[...remotes.values()].map(r => ({ name: r.name, kills: r.kills || 0 }))];
  let mvp = all[0]; for (const p of all) if (p.kills > mvp.kills) mvp = p;
  const iAmMvp = mvp.me && mvp.kills > 0;
  const kd = matchDeaths > 0 ? matchKills / matchDeaths : matchKills;
  const medals = [];
  if (iAmMvp) medals.push({ n: 'MVP', c: 50 });
  if (matchKills >= 3 && kd >= 2) medals.push({ n: 'SHARPSHOOTER', c: 25 });
  if (bestStreak >= 5) medals.push({ n: 'ON FIRE', c: 25 });
  if (bestStreak >= 10) medals.push({ n: 'UNSTOPPABLE', c: 40 });
  if (matchKills >= 10) medals.push({ n: 'SLAYER', c: 30 });
  let bonus = 0; for (const md of medals) bonus += md.c;
  if (bonus) awardCoins(bonus);
  const mvpLine = mvp.kills > 0 ? `<div class="mvp">MVP: <b>${mvp.name}${iAmMvp ? ' (you)' : ''}</b> — ${mvp.kills} kills</div>` : '';
  const medalHtml = medals.length
    ? '<div class="medals">' + medals.map(md => `<span class="medal">${md.n} <i>+${md.c}</i></span>`).join('') + '</div>'
    : '<div class="medals none">No medals this match — keep fighting!</div>';
  box.innerHTML = mvpLine + medalHtml;
}
function showMatchOver(winner, sc, winnerName) {
  if (sc) { Object.assign(scores, sc); $('scoreRed').textContent = scores.red; $('scoreBlue').textContent = scores.blue; }
  const st = $('matchStats'); if (st) st.textContent = `You — ${matchKills} kills · ${matchDeaths} deaths · best streak ${bestStreak}`;
  renderMatchAwards();
  const o = $('matchOver');
  if (gameMode === 'gg') {
    const win = (winnerName && winnerName === myName);
    awardCoins(win ? 120 : 40);
    awardXp(win ? 250 : 90);
    if (win) { unlockAch('win'); unlockAch('ggwin'); }
    $('matchOverTitle').textContent = (winnerName || 'SOMEONE') + ' WINS!';
    $('matchOverTitle').style.color = win ? '#ffd24a' : (TEAM_COL[winner] || '#fff');
    $('matchOverSub').textContent = (win ? 'You mastered every weapon! ' : 'Beaten to the last weapon. ') + 'Next match starting...';
    o.style.display = 'flex';
    return;
  }
  if (gameMode === 'surv') {
    awardCoins(150);
    awardXp(300);
    unlockAch('win');
    $('matchOverTitle').textContent = 'YOU SURVIVED!';
    $('matchOverTitle').style.color = '#ffd24a';
    $('matchOverSub').textContent = `Cleared all ${scoreLimit} waves! Next run starting...`;
    o.style.display = 'flex';
    return;
  }
  const win = (winner === myTeam);
  awardCoins(win ? 120 : 40);
  awardXp(win ? 220 : 80);
  if (win) unlockAch('win');
  $('matchOverTitle').textContent = (winner === 'red' ? 'RED' : 'BLUE') + ' TEAM WINS';
  $('matchOverTitle').style.color = TEAM_COL[winner] || '#fff';
  $('matchOverSub').textContent = (win ? 'Victory! ' : 'Defeat. ') + `${scores.red} : ${scores.blue}  —  next match starting...`;
  o.style.display = 'flex';
}
function hideMatchOver() { const o = $('matchOver'); if (o) o.style.display = 'none'; }
// Red arc pointing toward whoever just hit you (same rotation as the minimap).
function showDamageDir(fx, fz) {
  const el = $('dmgDir'); if (!el) return;
  const dx = fx - me.pos.x, dz = fz - me.pos.z;
  const ca = Math.cos(me.ry), sa = Math.sin(me.ry);
  const lx = dx * ca - dz * sa, ly = dx * sa + dz * ca;
  const ang = Math.atan2(lx, -ly); // 0 = directly in front
  el.style.transform = `rotate(${ang}rad)`;
  el.style.opacity = 1;
  clearTimeout(el._t); el._t = setTimeout(() => el.style.opacity = 0, 650);
}
function announce(text, color) {
  const el = $('announce');
  if (!el) return;
  el.textContent = text; el.style.color = color || '#ffdd55';
  el.style.animation = 'none'; void el.offsetWidth; el.style.animation = 'annce 1.3s ease-out';
}
// Rapid frags (kills within MULTI_WINDOW of each other) escalate the announce.
const MULTI_NAMES = { 2: 'DOUBLE KILL', 3: 'TRIPLE KILL', 4: 'MEGA KILL', 5: 'MONSTER KILL' };
// Sustained kills without dying (a spree) get their own milestones.
const SPREE_NAMES = { 5: 'KILLING SPREE', 10: 'RAMPAGE', 15: 'UNSTOPPABLE', 20: 'GODLIKE' };
const MULTI_WINDOW = 4000;
function onMyKill() {
  const now = performance.now();
  killStreak++;
  if (killStreak > bestStreak) bestStreak = killStreak;
  multiKill = (now - lastKillTime < MULTI_WINDOW) ? multiKill + 1 : 1;
  lastKillTime = now;
  let msg = null, col = '#ff7733';
  if (multiKill >= 2) { msg = MULTI_NAMES[Math.min(multiKill, 5)]; col = '#ff5533'; }
  if (SPREE_NAMES[killStreak]) { msg = SPREE_NAMES[killStreak]; col = '#ffd24a'; } // spree milestone wins
  if (msg) announce(msg, col);
  awardCoins(10); // coins toward unlocking classes
  awardXp(25);    // career progress
  unlockAch('firstkill');
  if (killStreak >= 5) unlockAch('spree5');
}

// ============================================================
// Chat
// ============================================================
function addChatMessage(name, team, text) {
  const box = $('chatMessages');
  const div = document.createElement('div');
  const nick = document.createElement('span');
  nick.className = `nick ${team === 'red' ? 'r' : 'b'}`;
  nick.textContent = name;
  div.appendChild(nick);
  div.appendChild(document.createTextNode(`: ${text}`));
  box.appendChild(div);
  while (box.children.length > 8) box.firstChild.remove();
  setTimeout(() => { div.style.opacity = 0; setTimeout(() => div.remove(), 600); }, 9000);
  SND.hit();
}

function openChat() {
  chatOpen = true;
  const input = $('chatInput');
  input.style.display = 'block';
  input.value = '';
  input.focus();
  Object.keys(keys).forEach(k => keys[k] = false);
  mouseDown = false;
}

function closeChat() {
  chatOpen = false;
  const input = $('chatInput');
  input.style.display = 'none';
  input.blur();
}

function sysChat(text) {
  const box = $('chatMessages');
  const div = document.createElement('div');
  div.className = 'sys';
  div.textContent = text;
  box.appendChild(div);
  while (box.children.length > 8) box.firstChild.remove();
  setTimeout(() => { div.style.opacity = 0; setTimeout(() => div.remove(), 600); }, 9000);
}

// ============================================================
// Voice chat (WebRTC mesh, push-to-talk on V)
// ============================================================
const voicePeers = new Map(); // id -> { pc, audio, pendingIce }
let micStream = null, micTrack = null, voiceFailed = false;

async function initVoice() {
  if (!micStream && !voiceFailed) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      micTrack = micStream.getAudioTracks()[0];
      micTrack.enabled = false; // push-to-talk
      sysChat('Voice chat on — hold V to talk');
    } catch {
      voiceFailed = true;
      sysChat('Microphone unavailable — you can hear others, but not talk');
    }
  }
  // newest player initiates connections to everyone already in game
  for (const id of remotes.keys()) makeVoicePeer(id, true);
}

function makeVoicePeer(id, initiator) {
  let p = voicePeers.get(id);
  if (p) return p;
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  const audio = new Audio();
  audio.autoplay = true;
  p = { pc, audio, pendingIce: [] };
  voicePeers.set(id, p);
  if (micStream) for (const tr of micStream.getTracks()) pc.addTrack(tr, micStream);
  else pc.addTransceiver('audio', { direction: 'recvonly' });
  pc.onicecandidate = e => { if (e.candidate) netSend({ t: 'rtc', to: id, data: { ice: e.candidate } }); };
  pc.ontrack = e => { audio.srcObject = e.streams[0]; audio.play().catch(() => {}); };
  if (initiator) {
    pc.createOffer()
      .then(o => pc.setLocalDescription(o))
      .then(() => netSend({ t: 'rtc', to: id, data: { sdp: pc.localDescription } }))
      .catch(() => {});
  }
  return p;
}

async function handleRtcSignal(from, data) {
  if (!data) return;
  try {
    const p = makeVoicePeer(from, false);
    const pc = p.pc;
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      for (const c of p.pendingIce) await pc.addIceCandidate(c).catch(() => {});
      p.pendingIce.length = 0;
      if (data.sdp.type === 'offer') {
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        netSend({ t: 'rtc', to: from, data: { sdp: pc.localDescription } });
      }
    } else if (data.ice) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.ice).catch(() => {});
      else p.pendingIce.push(data.ice);
    }
  } catch {}
}

function closeVoicePeer(id) {
  const p = voicePeers.get(id);
  if (!p) return;
  try { p.pc.close(); } catch {}
  p.audio.srcObject = null;
  voicePeers.delete(id);
}

function closeAllVoice() {
  for (const id of [...voicePeers.keys()]) closeVoicePeer(id);
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null; micTrack = null;
  }
  setTalking(false);
}

function setTalking(on) {
  if (!micTrack) on = false;
  if (micTrack) micTrack.enabled = on;
  $('voiceInd').style.display = on ? 'flex' : 'none';
}

// ============================================================
// World
// ============================================================
let worldMeshes = [];
function buildWorld(mapId = 'desert') {
  // clear any previously-built static map (map is chosen per room, so we rebuild
  // when the welcome message tells us which one this room uses)
  for (const mesh of worldMeshes) scene.remove(mesh);
  worldMeshes = [];
  mapBlockIndex.clear();
  collision.clear();
  for (const k of placedMeshes.keys()) collision.add(k); // keep any player-built blocks
  const blocks = buildMapBlocks(mapId);
  const byType = {};
  for (const b of blocks) {
    (byType[b.type] ||= []).push(b);
    collision.add(`${b.x},${b.y},${b.z}`);
  }
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const m4 = new THREE.Matrix4();
  for (const [type, list] of Object.entries(byType)) {
    if (!mats[type]) continue;
    const mesh = new THREE.InstancedMesh(geo, mats[type], list.length);
    list.forEach((b, i) => {
      m4.makeTranslation(b.x + 0.5, b.y + 0.5, b.z + 0.5);
      mesh.setMatrixAt(i, m4);
      mapBlockIndex.set(`${b.x},${b.y},${b.z}`, { mesh, i });
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    worldMeshes.push(mesh);
  }
}

// ---- health packs (pickups) ----
let pickupMeshes = [];
function makeHealthPack() {
  const c = document.createElement('canvas'); c.width = c.height = 16; const g = c.getContext('2d');
  g.fillStyle = '#eee'; g.fillRect(0, 0, 16, 16);
  g.fillStyle = '#222'; g.fillRect(0, 0, 16, 1); g.fillRect(0, 15, 16, 1); g.fillRect(0, 0, 1, 16); g.fillRect(15, 0, 1, 16);
  g.fillStyle = '#d21e1e'; g.fillRect(6, 3, 4, 10); g.fillRect(3, 6, 10, 4);
  const tex = new THREE.CanvasTexture(c); tex.magFilter = tex.minFilter = THREE.NearestFilter;
  return new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), new THREE.MeshBasicMaterial({ map: tex }));
}
function makeSupplyCrate() {
  const c = document.createElement('canvas'); c.width = c.height = 16; const g = c.getContext('2d');
  g.fillStyle = '#4a5a2a'; g.fillRect(0, 0, 16, 16);
  g.fillStyle = '#2e3a1a'; g.fillRect(0, 0, 16, 1); g.fillRect(0, 15, 16, 1); g.fillRect(0, 0, 1, 16); g.fillRect(15, 0, 1, 16);
  g.fillStyle = '#d9c56a'; g.fillRect(3, 6, 2, 7); g.fillRect(7, 6, 2, 7); g.fillRect(11, 6, 2, 7);
  const tex = new THREE.CanvasTexture(c); tex.magFilter = tex.minFilter = THREE.NearestFilter;
  return new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), new THREE.MeshBasicMaterial({ map: tex }));
}
function buildPickups(list) {
  for (const pm of pickupMeshes) scene.remove(pm.mesh);
  pickupMeshes = [];
  for (const pk of list || []) {
    const mesh = pk.type === 'supply' ? makeSupplyCrate() : makeHealthPack();
    mesh.position.set(pk.x, pk.y + 0.1, pk.z);
    mesh.visible = pk.active !== false;
    scene.add(mesh);
    pickupMeshes.push({ mesh, base: pk.y + 0.1, type: pk.type });
  }
}
function updatePickups(dt) {
  const t = performance.now() / 300;
  for (const pm of pickupMeshes) {
    if (!pm.mesh.visible) continue;
    pm.mesh.rotation.y += dt * 2;
    pm.mesh.position.y = pm.base + Math.sin(t) * 0.12;
  }
}

function placeBlockLocal(x, y, z, team) {
  const k = `${x},${y},${z}`;
  if (collision.has(k)) return;
  collision.add(k);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mats[team === 'red' ? 'redWool' : 'blueWool']);
  mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);
  placedMeshes.set(k, mesh);
  SND.place();
}

const ZERO_M4 = new THREE.Matrix4().makeScale(0, 0, 0);

function removeBlockLocal(x, y, z, silent) {
  const k = `${x},${y},${z}`;
  if (!collision.has(k)) return;
  const mesh = placedMeshes.get(k);
  if (mesh) {
    scene.remove(mesh);
    mesh.geometry.dispose();
    placedMeshes.delete(k);
  } else {
    const mi = mapBlockIndex.get(k);
    if (!mi) return; // unknown block (shouldn't happen) — keep collision intact
    mi.mesh.setMatrixAt(mi.i, ZERO_M4);
    mi.mesh.instanceMatrix.needsUpdate = true;
  }
  collision.delete(k);
  if (!silent) {
    debrisBurst(new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5));
    SND.brk();
  }
}

const solid = (x, y, z) => collision.has(`${x},${y},${z}`);

// Restore the arena to its pristine layout (called on match reset — the server
// clears all placed/destroyed blocks, so the client must rebuild to match).
function resetWorld() {
  for (const [k, mesh] of placedMeshes) { scene.remove(mesh); mesh.geometry.dispose(); collision.delete(k); }
  placedMeshes.clear();
  const m4 = new THREE.Matrix4();
  const dirty = new Set();
  for (const [k, mi] of mapBlockIndex) {
    const c = k.split(','); const x = +c[0], y = +c[1], z = +c[2];
    m4.makeTranslation(x + 0.5, y + 0.5, z + 0.5);
    mi.mesh.setMatrixAt(mi.i, m4);
    dirty.add(mi.mesh);
    collision.add(k);
  }
  for (const mesh of dirty) mesh.instanceMatrix.needsUpdate = true;
}

// ============================================================
// CTF flags
// ============================================================
const flagMeshes = {};
function makeFlagMesh(team) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.BoxGeometry(0.09, 2.2, 0.09), new THREE.MeshLambertMaterial({ color: 0x6b5230 }));
  pole.position.y = 1.1;
  const cloth = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.6, 0.06), new THREE.MeshLambertMaterial({ color: team === 'red' ? 0xd83a34 : 0x3a5bd8 }));
  cloth.position.set(0.52, 1.85, 0);
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.18, 0.6), new THREE.MeshLambertMaterial({ color: 0x2b2b2b }));
  base.position.y = 0.09;
  [pole, cloth, base].forEach(o => { o.castShadow = true; g.add(o); });
  g.userData.cloth = cloth;
  scene.add(g);
  return g;
}
function ensureFlags() {
  if (!flagMeshes.red) { flagMeshes.red = makeFlagMesh('red'); flagMeshes.blue = makeFlagMesh('blue'); }
}
function updateFlagMeshes(flags) {
  ensureFlags();
  const wobble = Math.sin(performance.now() * 0.004) * 0.35;
  for (const t of ['red', 'blue']) {
    const f = flags[t], g = flagMeshes[t];
    if (!f || !g) continue;
    g.position.set(f.x, f.y + 0.5, f.z); // ground surface is groundTop+1; sit the flag group on it
    g.userData.cloth.rotation.y = wobble;
    g.visible = true;
  }
}

// ============================================================
// Domination hill (central capture zone)
// ============================================================
let zoneMesh = null, zoneState = null;
const ZONE_RADIUS = 8;
function zoneColor(owner) { return owner === 'red' ? 0xff5555 : owner === 'blue' ? 0x7f9fff : 0x999999; }
function zoneCss(owner) { return owner === 'red' ? '#ff5555' : owner === 'blue' ? '#7f9fff' : '#aaaaaa'; }
function ensureZone() {
  if (zoneMesh) return;
  const g = new THREE.Group();
  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(ZONE_RADIUS, ZONE_RADIUS, 6, 40, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x999999, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false })
  );
  wall.position.y = 4; // spans ground surface (y=1) up to y=7
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(ZONE_RADIUS - 0.4, ZONE_RADIUS, 48),
    new THREE.MeshBasicMaterial({ color: 0x999999, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false })
  );
  ring.rotation.x = -Math.PI / 2; ring.position.y = 1.06; // just above the ground surface
  g.add(wall); g.add(ring);
  g.userData = { wall, ring };
  g.visible = false;
  scene.add(g);
  zoneMesh = g;
}
function updateZoneState(z) {
  ensureZone();
  zoneState = z;
  const baseCol = zoneColor(z.contested ? null : z.owner);
  const capCol = z.capTeam ? zoneColor(z.capTeam) : baseCol;
  zoneMesh.userData.wall.material.color.setHex(baseCol);
  zoneMesh.userData.ring.material.color.setHex(z.capTeam ? capCol : baseCol);
  zoneMesh.userData.wall.material.opacity = z.owner ? 0.22 : 0.13;
  zoneMesh.visible = true;
  updateZoneHud(z);
}
function updateZoneHud(z) {
  const txt = $('zoneTxt'), bar = $('zoneBar'), hud = $('zoneHud');
  if (!hud) return;
  hud.style.display = 'block';
  let t, col, frac;
  if (z.contested) { t = 'ZONE CONTESTED'; col = '#ffd24a'; frac = z.owner ? 1 : 0; }
  else if (z.capTeam) { t = (z.capTeam === myTeam ? 'CAPTURING ' : 'LOSING ZONE ') + Math.round(z.cap * 100) + '%'; col = zoneCss(z.capTeam); frac = z.cap; }
  else if (z.owner) { t = (z.owner === myTeam ? 'YOUR TEAM HOLDS THE ZONE' : (z.owner === 'red' ? 'RED' : 'BLUE') + ' HOLDS THE ZONE'); col = zoneCss(z.owner); frac = 1; }
  else { t = 'CAPTURE THE ZONE'; col = '#cfd6e6'; frac = 0; }
  if (txt) { txt.textContent = t; txt.style.color = col; }
  if (bar) { bar.style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%'; bar.style.background = col; }
}
function hideZone() { if (zoneMesh) zoneMesh.visible = false; zoneState = null; const h = $('zoneHud'); if (h) h.style.display = 'none'; }

// ============================================================
// Sentry turrets (deployable, coin-cost ability — key B)
// ============================================================
const turretMeshes = new Map();
const TURRET_COST = 75;
let turretCdUntil = 0;
function makeTurretMesh(team, ry) {
  const col = team === 'red' ? 0xd83a34 : 0x3a5bd8;
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.3, 0.7), new THREE.MeshLambertMaterial({ color: 0x2b2f38 }));
  base.position.y = 0.15;
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.5, 0.22), new THREE.MeshLambertMaterial({ color: 0x4a4f5a }));
  post.position.y = 0.55;
  const head = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.6), new THREE.MeshLambertMaterial({ color: col }));
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.7), new THREE.MeshLambertMaterial({ color: 0x1c1f26 }));
  barrel.position.set(0, 0, -0.55);
  const eye = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.05), new THREE.MeshBasicMaterial({ color: 0xffdd55 }));
  eye.position.set(0, 0.06, -0.31);
  head.add(body, barrel, eye); head.position.y = 0.98;
  [base, post].forEach(o => o.castShadow = true);
  g.add(base, post, head);
  g.userData = { head };
  g.rotation.y = ry || 0;
  scene.add(g);
  return g;
}
function addTurret(m) {
  if (turretMeshes.has(m.id)) return;
  const g = makeTurretMesh(m.team, m.ry);
  g.position.set(m.pos.x, m.pos.y - 0.1, m.pos.z); // owner feet ~ground+1.1; drop to the ground surface
  turretMeshes.set(m.id, g);
  feed(m.owner === myId ? 'Your sentry turret is online!' : 'An enemy turret deployed', m.team);
  SND.spawn();
}
function removeTurret(id) { const g = turretMeshes.get(id); if (g) { scene.remove(g); turretMeshes.delete(id); } }
function clearTurrets() { for (const id of [...turretMeshes.keys()]) removeTurret(id); }
function deployTurret() {
  if (!inGame || me.dead) return;
  const now = performance.now();
  if (now < turretCdUntil) { feed(`Turret recharging (${Math.ceil((turretCdUntil - now) / 1000)}s)`, myTeam); return; }
  if (coins < TURRET_COST) { feed(`Need ${TURRET_COST} coins to deploy a turret`, myTeam); return; }
  awardCoins(-TURRET_COST);
  turretCdUntil = now + 18000;
  netSend({ t: 'deploy', pos: { x: me.pos.x, y: me.pos.y, z: me.pos.z }, ry: me.ry });
  announce('TURRET DEPLOYED', '#7dd3fc');
}

// ============================================================
// Remote players (blocky characters)
// ============================================================
function makeFaceTexture() {
  const c = document.createElement('canvas'); c.width = 8; c.height = 8;
  const g = c.getContext('2d');
  g.fillStyle = '#d8a37a'; g.fillRect(0, 0, 8, 8);
  g.fillStyle = '#fff'; g.fillRect(1, 3, 2, 1); g.fillRect(5, 3, 2, 1);
  g.fillStyle = '#3b2db0'; g.fillRect(2, 3, 1, 1); g.fillRect(5, 3, 1, 1);
  g.fillStyle = '#8a5c3a'; g.fillRect(0, 0, 8, 2);
  g.fillStyle = '#a8674a'; g.fillRect(3, 5, 2, 1);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
let faceTex = null;

const RANK_COL = { BRONZE: '#cd7f32', SILVER: '#c0c0c0', GOLD: '#ffd24a', PLATINUM: '#5fe0d0', DIAMOND: '#7dd3fc', MASTER: '#ff5cc8' };
function makeNameSprite(name, team, tier, title) {
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  g.font = '28px monospace';
  const w = Math.max(64, g.measureText(name).width + 24, title ? g.measureText(title).width + 20 : 0);
  const topPad = (tier ? 22 : 0) + (title ? 20 : 0);
  const h = 44 + topPad;
  c.width = w; c.height = h;
  const g2 = c.getContext('2d');
  g2.fillStyle = 'rgba(0,0,0,0.45)'; g2.fillRect(0, 0, w, h);
  g2.textAlign = 'center'; g2.textBaseline = 'middle';
  let y = 14;
  if (title) { g2.font = 'bold 15px monospace'; g2.fillStyle = '#ffd24a'; g2.fillText(title, w / 2, y); y += 20; }
  if (tier) { g2.font = 'bold 18px monospace'; g2.fillStyle = RANK_COL[tier] || '#7dd3fc'; g2.fillText(tier, w / 2, y); y += 22; }
  g2.font = 'bold 28px monospace'; g2.fillStyle = TEAM_COL[team];
  g2.fillText(name, w / 2, h - 21);
  const t = new THREE.CanvasTexture(c);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t }));
  sp.scale.set(w / 70, h / 70, 1);
  sp.position.y = 2.45;
  return sp;
}

function makeCharacter(team, name, agentId, color, tier, title, charSkin) {
  const group = new THREE.Group();
  const cs = CHAR_SKINS[charSkin] || CHAR_SKINS.default;
  const accentCol = (cs.accent != null) ? cs.accent : ((typeof color === 'number' && color >= 0) ? color : (AGENTS[agentId]?.accent ?? 0x9aa4b2));
  const skin = new THREE.MeshLambertMaterial({ color: 0xd8a37a });
  const jersey = new THREE.MeshLambertMaterial({ color: team === 'red' ? 0xb03430 : 0x3a4fb4 });
  const pants = new THREE.MeshLambertMaterial({ color: cs.pants != null ? cs.pants : 0x33343c });
  const faceMat = new THREE.MeshLambertMaterial({ map: faceTex });

  // head (face on -Z)
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5),
    [skin, skin, skin, skin, faceMat, skin]);
  head.position.y = 1.65;
  // body
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.26), jersey);
  body.position.y = 1.05;
  // arms
  const armL = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.68, 0.24), jersey);
  const armR = armL.clone();
  armL.position.set(-0.37, 1.32, 0); armR.position.set(0.37, 1.32, 0);
  armL.geometry = armL.geometry.clone(); armR.geometry = armR.geometry.clone();
  armL.geometry.translate(0, -0.28, 0); armR.geometry.translate(0, -0.28, 0);
  armL.position.y = armR.position.y = 1.36;
  // gun in right arm
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.12, 0.6), new THREE.MeshLambertMaterial({ color: 0x222222 }));
  gun.position.set(0.37, 0.78, -0.42);
  // legs
  const legL = new THREE.Mesh(new THREE.BoxGeometry(0.23, 0.7, 0.25), pants);
  const legR = legL.clone();
  legL.geometry = legL.geometry.clone(); legR.geometry = legR.geometry.clone();
  legL.geometry.translate(0, -0.35, 0); legR.geometry.translate(0, -0.35, 0);
  legL.position.set(-0.13, 0.7, 0); legR.position.set(0.13, 0.7, 0);

  // agent accent: helmet on top of the head (character skins can make it glow)
  const helmetMat = new THREE.MeshLambertMaterial({ color: accentCol });
  if (cs.glow && helmetMat.emissive) { helmetMat.emissive.setHex(accentCol); helmetMat.emissiveIntensity = 0.6; }
  const helmet = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.18, 0.56), helmetMat);
  helmet.position.y = 1.92;

  [head, body, armL, armR, legL, legR, gun, helmet].forEach(o => { o.castShadow = true; group.add(o); });
  const nameSprite = makeNameSprite(name, team, tier, title);
  group.add(nameSprite);
  group.userData = { head, armL, armR, legL, legR, gun, nameSprite, name, team, title, tier };
  return group;
}

function addRemote(p) {
  if (remotes.has(p.id)) return;
  const group = makeCharacter(p.team, p.name, p.agent, p.color, p.rankTier, p.title, p.charSkin);
  group.position.set(p.pos.x, p.pos.y, p.pos.z);
  group.rotation.y = p.ry + Math.PI;
  group.visible = p.alive;
  scene.add(group);
  remotes.set(p.id, {
    id: p.id, name: p.name, team: p.team, group,
    target: new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z),
    try: p.ry, trx: p.rx || 0, anim: 0, phase: 0,
    alive: p.alive, hp: p.hp, kills: p.kills || 0, deaths: p.deaths || 0,
    shootAnim: 0, bot: !!p.bot,
  });
}

function updateRemotes(dt) {
  const k = Math.min(1, dt * 14);
  for (const r of remotes.values()) {
    // voice volume falls off with distance (teammates stay audible)
    const vp = voicePeers.get(r.id);
    if (vp) vp.audio.volume = Math.max(0.15, Math.min(1, 1.25 - r.group.position.distanceTo(me.pos) / 50));
    if (!r.alive) continue;
    r.group.position.lerp(r.target, k);
    // shortest-arc yaw lerp
    let dy = (r.try + Math.PI) - r.group.rotation.y;
    dy = ((dy + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    r.group.rotation.y += dy * k;
    const u = r.group.userData;
    u.head.rotation.x = -(r.trx || 0);
    // walk animation
    r.phase += dt * (4 + r.anim * 9);
    const swing = Math.sin(r.phase) * Math.min(0.7, r.anim * 0.9);
    u.legL.rotation.x = swing;
    u.legR.rotation.x = -swing;
    u.armL.rotation.x = -swing * 0.7;
    u.armR.rotation.x = r.shootAnim > 0 ? -1.35 : swing * 0.7 - 0.6;
    if (r.shootAnim > 0) r.shootAnim -= dt;
  }
}

// ============================================================
// Physics
// ============================================================
function collideAxis(pos, axis) {
  const minX = Math.floor(pos.x - P_HALF), maxX = Math.floor(pos.x + P_HALF);
  const minY = Math.floor(pos.y), maxY = Math.floor(pos.y + P_HEIGHT - 0.001);
  const minZ = Math.floor(pos.z - P_HALF), maxZ = Math.floor(pos.z + P_HALF);
  for (let x = minX; x <= maxX; x++)
    for (let y = minY; y <= maxY; y++)
      for (let z = minZ; z <= maxZ; z++)
        if (solid(x, y, z)) return true;
  return false;
}

function movePlayer(dt) {
  const sprint = keys['ShiftLeft'] || keys['ShiftRight'] || mobileSprint || sprintHeld;
  const speed = (sprint ? SPRINT : WALK) * (AGENTS[myAgent]?.speed || 1);
  let fx = 0, fz = 0;
  if (keys['KeyW']) fz -= 1;
  if (keys['KeyS']) fz += 1;
  if (keys['KeyA']) fx -= 1;
  if (keys['KeyD']) fx += 1;
  if (mobileMove.active) { fx = mobileMove.x; fz = mobileMove.z; } // virtual joystick (mobile)
  const len = Math.hypot(fx, fz);
  let wishX = 0, wishZ = 0;
  if (len > 0) {
    fx /= len; fz /= len;
    // forward = (-sin ry, 0, -cos ry); right = (cos ry, 0, -sin ry)
    wishX = (-Math.sin(me.ry)) * (-fz) * speed + Math.cos(me.ry) * fx * speed;
    wishZ = (-Math.cos(me.ry)) * (-fz) * speed + (-Math.sin(me.ry)) * fx * speed;
  }
  const accel = me.onGround ? 14 : 4;
  me.vel.x += (wishX - me.vel.x) * Math.min(1, accel * dt);
  me.vel.z += (wishZ - me.vel.z) * Math.min(1, accel * dt);
  me.vel.y -= GRAVITY * dt;

  // jump — classes with doubleJump get one extra mid-air jump per press
  if (me.onGround) me.jumps = 0;
  const maxJumps = AGENTS[myAgent]?.doubleJump ? 2 : 1;
  const spaceNow = !!keys['Space'];
  if (spaceNow && !jumpPrev && (me.onGround || me.jumps < maxJumps)) {
    me.vel.y = JUMP_V * (AGENTS[myAgent]?.jump || 1);
    me.onGround = false;
    me.jumps++;
  }
  jumpPrev = spaceNow;

  // axis-by-axis integration
  const p = me.pos;
  p.x += me.vel.x * dt;
  if (collideAxis(p)) { p.x -= me.vel.x * dt; me.vel.x = 0; }
  p.z += me.vel.z * dt;
  if (collideAxis(p)) { p.z -= me.vel.z * dt; me.vel.z = 0; }
  p.y += me.vel.y * dt;
  me.onGround = false;
  if (collideAxis(p)) {
    if (me.vel.y < 0) me.onGround = true;
    p.y -= me.vel.y * dt;
    // snap down/up
    me.vel.y = 0;
  }
  if (p.y < -10) { p.set(myTeam === 'red' ? -28 : 28, 1.05, 0); me.vel.set(0, 0, 0); }
  return len > 0 ? (sprint ? 1 : 0.6) : 0;
}

// ============================================================
// Raycasting
// ============================================================
function raycastVoxels(o, d, maxDist) {
  let x = Math.floor(o.x), y = Math.floor(o.y), z = Math.floor(o.z);
  const stepX = d.x >= 0 ? 1 : -1, stepY = d.y >= 0 ? 1 : -1, stepZ = d.z >= 0 ? 1 : -1;
  const tdx = Math.abs(1 / d.x), tdy = Math.abs(1 / d.y), tdz = Math.abs(1 / d.z);
  let tmx = d.x !== 0 ? ((stepX > 0 ? x + 1 - o.x : o.x - x) * tdx) : Infinity;
  let tmy = d.y !== 0 ? ((stepY > 0 ? y + 1 - o.y : o.y - y) * tdy) : Infinity;
  let tmz = d.z !== 0 ? ((stepZ > 0 ? z + 1 - o.z : o.z - z) * tdz) : Infinity;
  let t = 0, normal = [0, 0, 0];
  for (let i = 0; i < 400; i++) {
    if (tmx < tmy && tmx < tmz) { x += stepX; t = tmx; tmx += tdx; normal = [-stepX, 0, 0]; }
    else if (tmy < tmz) { y += stepY; t = tmy; tmy += tdy; normal = [0, -stepY, 0]; }
    else { z += stepZ; t = tmz; tmz += tdz; normal = [0, 0, -stepZ]; }
    if (t > maxDist) return null;
    if (solid(x, y, z)) return { x, y, z, dist: t, normal };
  }
  return null;
}

function rayAABB(o, d, min, max) {
  let tmin = 0, tmax = Infinity;
  for (const ax of ['x', 'y', 'z']) {
    if (Math.abs(d[ax]) < 1e-9) {
      if (o[ax] < min[ax] || o[ax] > max[ax]) return null;
    } else {
      let t1 = (min[ax] - o[ax]) / d[ax], t2 = (max[ax] - o[ax]) / d[ax];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}

// ============================================================
// Weapons
// ============================================================
function currentWeapon() { return WEAPONS[SLOTS[me.slot]]; }

function tryShoot(now) {
  const wkey = SLOTS[me.slot];
  const w = WEAPONS[wkey];
  if (me.dead || me.reloading) return;
  if (w.builder) { tryPlaceBlock(); return; }
  if (w.tool) { if (gameMode === 'gg') tryMelee(now); else tryBreakBlock(); return; }
  if (now - me.lastShot < w.rate) return;
  if (me.ammo[wkey] <= 0) { startReload(); return; }
  me.lastShot = now;
  me.ammo[wkey]--;
  updateAmmoHud();

  const origin = camera.getWorldPosition(new THREE.Vector3());
  const baseDir = new THREE.Vector3();
  camera.getWorldDirection(baseDir);

  if (w.rocket) {
    spawnRocket(origin, baseDir.clone(), true);
    SND.rocket();
    netSend({ t: 'shoot', from: { x: origin.x, y: origin.y, z: origin.z }, dir: { x: baseDir.x, y: baseDir.y, z: baseDir.z }, w: wkey });
    me.rx += 0.06;
    vm.recoil = 1;
    if (vm.muzzle) { vm.flash = 1.2; vm.muzzle.material.color.setHex(0xff8a3a); }
    startReload();
    return;
  }

  const spread = w.spread * (me.zoomed ? 0.25 : 1) * (me.onGround ? 1 : 1.8);
  const tcol = myTracerColor(wkey); // equipped tracer-skin colour (rainbow sampled once per shot)

  for (let p = 0; p < w.pellets; p++) {
    const dir = baseDir.clone();
    dir.x += (Math.random() - 0.5) * 2 * spread;
    dir.y += (Math.random() - 0.5) * 2 * spread;
    dir.z += (Math.random() - 0.5) * 2 * spread;
    dir.normalize();

    const blockHit = raycastVoxels(origin, dir, w.range);
    let bestPlayer = null, bestT = blockHit ? blockHit.dist : w.range;
    for (const r of remotes.values()) {
      if (!r.alive || r.team === myTeam) continue;
      const bp = r.group.position;
      const t = rayAABB(origin, dir, { x: bp.x - 0.35, y: bp.y, z: bp.z - 0.35 }, { x: bp.x + 0.35, y: bp.y + 1.9, z: bp.z + 0.35 });
      if (t !== null && t < bestT) { bestT = t; bestPlayer = r; }
    }
    if (bestPlayer) {
      const hitY = origin.y + dir.y * bestT;
      const head = hitY > bestPlayer.group.position.y + 1.45;
      let dmg = w.dmg * (head ? 2 : 1);
      netSend({ t: 'hit', target: bestPlayer.id, dmg: Math.round(dmg), w: wkey, head });
      const hp = new THREE.Vector3(origin.x + dir.x * bestT, hitY, origin.z + dir.z * bestT);
      bloodBurst(hp);
      spawnDamageNumber(hp, Math.round(dmg), head);
    } else if (blockHit) {
      debrisBurst(new THREE.Vector3(origin.x + dir.x * blockHit.dist, origin.y + dir.y * blockHit.dist, origin.z + dir.z * blockHit.dist));
    }
    spawnTracer(origin, dir, wkey, bestT, tcol);
  }

  SND.shot(wkey);
  netSend({ t: 'shoot', from: { x: origin.x, y: origin.y, z: origin.z }, dir: { x: baseDir.x, y: baseDir.y, z: baseDir.z }, w: wkey, tc: tcol });
  // recoil + skin-tinted muzzle flash
  me.rx += w.pellets > 1 ? 0.03 : (wkey === 'sniper' ? 0.04 : 0.012);
  vm.recoil = 1;
  if (vm.muzzle) { vm.flash = 1; vm.muzzle.material.color.setHex(tcol); }
  if (me.ammo[wkey] <= 0) startReload();
}

// Pickaxe melee (Gun Game finisher): a short-range one-hit swing that also
// demotes the victim a rung server-side. Never mines blocks in this mode.
function tryMelee(now) {
  if (me.dead || now - me.lastShot < 420) return;
  me.lastShot = now;
  const origin = camera.getWorldPosition(new THREE.Vector3());
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
  const RANGE = 3.4;
  let bestPlayer = null, bestT = RANGE;
  for (const r of remotes.values()) {
    if (!r.alive || r.team === myTeam) continue;
    const bp = r.group.position;
    const t = rayAABB(origin, dir, { x: bp.x - 0.55, y: bp.y, z: bp.z - 0.55 }, { x: bp.x + 0.55, y: bp.y + 1.95, z: bp.z + 0.55 });
    if (t !== null && t < bestT) { bestT = t; bestPlayer = r; }
  }
  if (bestPlayer) {
    netSend({ t: 'hit', target: bestPlayer.id, dmg: 200, w: 'pickaxe', head: false });
    const hp = new THREE.Vector3(origin.x + dir.x * bestT, origin.y + dir.y * bestT, origin.z + dir.z * bestT);
    bloodBurst(hp);
    spawnDamageNumber(hp, 200, true);
    SND.hit();
  } else {
    SND.swing();
  }
  me.rx += 0.02;
  vm.recoil = 1;
}

function startReload() {
  const wkey = SLOTS[me.slot];
  const w = WEAPONS[wkey];
  if (w.builder || w.tool || me.reloading || me.ammo[wkey] === w.mag) return;
  me.reloading = true;
  me.reloadEnd = performance.now() + w.reload;
  $('reloadLbl').style.display = 'block';
  SND.reload();
  setTimeout(() => {
    if (SLOTS[me.slot] === wkey) {
      me.ammo[wkey] = w.mag;
      updateAmmoHud();
    } else {
      me.ammo[wkey] = w.mag;
    }
    me.reloading = false;
    $('reloadLbl').style.display = 'none';
    updateAmmoHud();
  }, w.reload);
}

function tryPlaceBlock() {
  const now = performance.now();
  if (now - me.lastShot < 220 || me.blocks <= 0) return;
  me.lastShot = now;
  const origin = camera.getWorldPosition(new THREE.Vector3());
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
  const hit = raycastVoxels(origin, dir, 6);
  if (!hit) return;
  const nx = hit.x + hit.normal[0], ny = hit.y + hit.normal[1], nz = hit.z + hit.normal[2];
  if (ny < 1 || ny > 20 || Math.abs(nx) > HALF + 1 || Math.abs(nz) > HALF + 1) return;
  if (Math.abs(nx) >= SPAWN_NOBUILD_X) { feed('Cannot build in spawn zones', myTeam); return; } // anti-trap
  if (collision.has(`${nx},${ny},${nz}`)) return;
  // don't place inside yourself or others
  const bx = nx + 0.5, bz = nz + 0.5;
  const overlaps = (pos) =>
    Math.abs(pos.x - bx) < 0.5 + P_HALF && Math.abs(pos.z - bz) < 0.5 + P_HALF &&
    pos.y + P_HEIGHT > ny && pos.y < ny + 1;
  if (overlaps(me.pos)) return;
  for (const r of remotes.values()) if (r.alive && overlaps(r.group.position)) return;
  me.blocks--;
  placeBlockLocal(nx, ny, nz, myTeam);
  netSend({ t: 'place', x: nx, y: ny, z: nz });
  updateAmmoHud(); updateHotbar();
}

function tryBreakBlock() {
  const now = performance.now();
  if (now - me.lastShot < 280) return;
  me.lastShot = now;
  vm.recoil = 1;
  const origin = camera.getWorldPosition(new THREE.Vector3());
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
  const hit = raycastVoxels(origin, dir, 5);
  // ground and bedrock border can't be broken
  if (!hit || hit.y < 1 || hit.x < -HALF || hit.x > HALF - 1 || hit.z < -HALF || hit.z > HALF - 1) {
    SND.swing();
    return;
  }
  removeBlockLocal(hit.x, hit.y, hit.z);
  netSend({ t: 'destroy', x: hit.x, y: hit.y, z: hit.z });
  me.blocks = Math.min(64, me.blocks + 1); // salvage a block
  updateHotbar();
}

// ============================================================
// Rockets (bazooka)
// ============================================================
const ROCKET_SPEED = 26, BLAST_R = 4.5, BLAST_BLOCK_R = 2;

function spawnRocket(origin, dir, isLocal) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.5), new THREE.MeshLambertMaterial({ color: 0x3c4632 }));
  const tip = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.14), new THREE.MeshLambertMaterial({ color: 0xc23425 }));
  tip.position.z = -0.3;
  const flame = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.2), new THREE.MeshBasicMaterial({ color: 0xffaa33 }));
  flame.position.z = 0.32;
  g.add(body, tip, flame);
  const d = dir.clone().normalize();
  const pos = origin.clone().addScaledVector(d, 0.7);
  g.position.copy(pos);
  g.lookAt(pos.clone().sub(d)); // -Z towards flight direction
  scene.add(g);
  rockets.push({ obj: g, pos, dir: d, ttl: 5, smoke: 0, isLocal });
}

function updateRockets(dt) {
  for (let i = rockets.length - 1; i >= 0; i--) {
    const r = rockets[i];
    r.ttl -= dt;
    let exploded = r.ttl <= 0;
    const steps = 3, stepLen = ROCKET_SPEED * dt / steps;
    for (let s = 0; s < steps && !exploded; s++) {
      r.pos.addScaledVector(r.dir, stepLen);
      if (solid(Math.floor(r.pos.x), Math.floor(r.pos.y), Math.floor(r.pos.z))) { exploded = true; break; }
      for (const rem of remotes.values()) {
        if (!rem.alive) continue;
        const bp = rem.group.position;
        if (Math.abs(r.pos.x - bp.x) < 0.55 && Math.abs(r.pos.z - bp.z) < 0.55 && r.pos.y > bp.y - 0.2 && r.pos.y < bp.y + 2.1) {
          exploded = true; break;
        }
      }
    }
    if (exploded) {
      explode(r);
      scene.remove(r.obj);
      rockets.splice(i, 1);
      continue;
    }
    r.obj.position.copy(r.pos);
    r.smoke -= dt;
    if (r.smoke <= 0) {
      r.smoke = 0.025;
      const s = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.09), new THREE.MeshBasicMaterial({ color: 0xbbbbbb, transparent: true, opacity: 0.7 }));
      s.position.copy(r.pos);
      scene.add(s);
      particles.push({ obj: s, ttl: 0.5, vel: new THREE.Vector3((Math.random() - 0.5), 1.2 + Math.random(), (Math.random() - 0.5)) });
    }
  }
}

function explode(r) {
  const p = r.pos;
  burst(p, 0xff7722, 22, 9);
  burst(p, 0xffcc44, 14, 7);
  burst(p, 0x777777, 16, 5);
  const dist = camera ? p.distanceTo(me.pos) : 50;
  SND.boom(Math.max(0.08, 0.55 * Math.min(1, 16 / (dist + 1))));
  if (dist < BLAST_R * 2) me.rx += (Math.random() - 0.5) * 0.06; // shake

  if (!r.isLocal) return; // only the shooter applies damage and block destruction

  for (const rem of remotes.values()) {
    if (!rem.alive || rem.team === myTeam) continue;
    const c = rem.group.position.clone(); c.y += 0.95;
    const d = c.distanceTo(p);
    if (d > BLAST_R) continue;
    const dmg = Math.round(WEAPONS.bazooka.dmg * (1 - d / BLAST_R) + 20);
    netSend({ t: 'hit', target: rem.id, dmg, w: 'bazooka', head: false });
  }

  const cx = Math.floor(p.x), cy = Math.floor(p.y), cz = Math.floor(p.z);
  for (let dx = -BLAST_BLOCK_R; dx <= BLAST_BLOCK_R; dx++)
    for (let dy = -BLAST_BLOCK_R; dy <= BLAST_BLOCK_R; dy++)
      for (let dz = -BLAST_BLOCK_R; dz <= BLAST_BLOCK_R; dz++) {
        if (dx * dx + dy * dy + dz * dz > BLAST_BLOCK_R * BLAST_BLOCK_R + 1) continue;
        const x = cx + dx, y = cy + dy, z = cz + dz;
        if (y < 1 || x < -HALF || x > HALF - 1 || z < -HALF || z > HALF - 1) continue;
        if (!collision.has(`${x},${y},${z}`)) continue;
        removeBlockLocal(x, y, z, true);
        netSend({ t: 'destroy', x, y, z });
      }
}

// ============================================================
// Grenades (thrown, arc under gravity, timed fuse, area blast)
// ============================================================
const GR_FUSE = 1.5, GR_BLAST_R = 5, GR_BLOCK_R = 2, GR_DMG = 95;

function spawnGrenade(pos, vel, isLocal) {
  const obj = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.24, 0.24), new THREE.MeshLambertMaterial({ color: 0x2f7d32 }));
  obj.position.copy(pos); obj.castShadow = true;
  scene.add(obj);
  grenades.push({ obj, pos: pos.clone(), vel: vel.clone(), fuse: GR_FUSE, isLocal });
}

function throwGrenade() {
  const now = performance.now();
  if (me.dead || me.nades <= 0 || now - me.lastNade < 650) return;
  me.lastNade = now; me.nades--;
  const origin = camera.getWorldPosition(new THREE.Vector3());
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
  const vel = dir.clone().multiplyScalar(17); vel.y += 4.5; // lob it in an arc
  const from = origin.clone().addScaledVector(dir, 0.6);
  spawnGrenade(from, vel, true);
  netSend({ t: 'nade', from: { x: from.x, y: from.y, z: from.z }, vel: { x: vel.x, y: vel.y, z: vel.z } });
  SND.nade();
  updateAmmoHud();
}

function updateGrenades(dt) {
  for (let i = grenades.length - 1; i >= 0; i--) {
    const g = grenades[i];
    g.fuse -= dt;
    g.vel.y -= 22 * dt; // gravity
    const blk = (x, y, z) => solid(Math.floor(x), Math.floor(y), Math.floor(z));
    // per-axis voxel collision so the grenade bounces off walls/floor
    let nx = g.pos.x + g.vel.x * dt;
    if (blk(nx, g.pos.y, g.pos.z)) g.vel.x *= -0.4; else g.pos.x = nx;
    let nz = g.pos.z + g.vel.z * dt;
    if (blk(g.pos.x, g.pos.y, nz)) g.vel.z *= -0.4; else g.pos.z = nz;
    let ny = g.pos.y + g.vel.y * dt;
    if (blk(g.pos.x, ny, g.pos.z)) { if (g.vel.y < 0) { g.vel.x *= 0.7; g.vel.z *= 0.7; } g.vel.y *= -0.35; }
    else g.pos.y = ny;
    if (g.pos.y < 0.2) { g.pos.y = 0.2; g.vel.y *= -0.35; g.vel.x *= 0.7; g.vel.z *= 0.7; }
    g.obj.position.copy(g.pos);
    g.obj.rotation.x += dt * 6; g.obj.rotation.y += dt * 4;
    if (g.fuse <= 0) { explodeGrenade(g.pos, g.isLocal); scene.remove(g.obj); grenades.splice(i, 1); }
  }
}

function explodeGrenade(p, isLocal) {
  burst(p, 0xff7722, 22, 9); burst(p, 0xffcc44, 14, 7); burst(p, 0x777777, 16, 5);
  const dist = camera ? p.distanceTo(me.pos) : 50;
  SND.boom(Math.max(0.08, 0.6 * Math.min(1, 16 / (dist + 1))));
  if (dist < GR_BLAST_R * 2) me.rx += (Math.random() - 0.5) * 0.06;
  if (!isLocal) return; // only the thrower is authoritative for damage + blocks
  for (const rem of remotes.values()) {
    if (!rem.alive || rem.team === myTeam) continue;
    const c = rem.group.position.clone(); c.y += 0.95;
    const d = c.distanceTo(p);
    if (d > GR_BLAST_R) continue;
    const dmg = Math.round(GR_DMG * (1 - d / GR_BLAST_R) + 12);
    netSend({ t: 'hit', target: rem.id, dmg, w: 'grenade', head: false });
  }
  const cx = Math.floor(p.x), cy = Math.floor(p.y), cz = Math.floor(p.z);
  for (let dx = -GR_BLOCK_R; dx <= GR_BLOCK_R; dx++)
    for (let dy = -GR_BLOCK_R; dy <= GR_BLOCK_R; dy++)
      for (let dz = -GR_BLOCK_R; dz <= GR_BLOCK_R; dz++) {
        if (dx * dx + dy * dy + dz * dz > GR_BLOCK_R * GR_BLOCK_R + 1) continue;
        const x = cx + dx, y = cy + dy, z = cz + dz;
        if (y < 1 || x < -HALF || x > HALF - 1 || z < -HALF || z > HALF - 1) continue;
        if (!collision.has(`${x},${y},${z}`)) continue;
        removeBlockLocal(x, y, z, true);
        netSend({ t: 'destroy', x, y, z });
      }
}

// ============================================================
// FX
// ============================================================
function spawnTracer(origin, dir, wkey, dist, color) {
  const len = dist !== undefined ? dist : (raycastVoxels(origin, dir, 100)?.dist ?? 100);
  const end = origin.clone().addScaledVector(dir, len);
  const start = origin.clone().addScaledVector(dir, 0.8).add(new THREE.Vector3(0, -0.12, 0));
  const g = new THREE.BufferGeometry().setFromPoints([start, end]);
  const col = (color !== undefined && color !== null) ? color : (wkey === 'sniper' ? 0xaadfff : 0xffd080);
  const m = new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.9 });
  const line = new THREE.Line(g, m);
  scene.add(line);
  tracers.push({ obj: line, ttl: 0.1 });
}

const MAX_PARTICLES = 260; // hard cap so heavy firefights can't flood the scene and stutter
function burst(pos, color, n, spd) {
  // drop the oldest particles if we're about to exceed the cap
  let over = particles.length + n - MAX_PARTICLES;
  while (over-- > 0 && particles.length) {
    const p = particles.shift();
    scene.remove(p.obj); p.obj.geometry.dispose(); p.obj.material.dispose();
  }
  for (let i = 0; i < n; i++) {
    const s = 0.05 + Math.random() * 0.06;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), new THREE.MeshBasicMaterial({ color }));
    mesh.position.copy(pos);
    scene.add(mesh);
    particles.push({
      obj: mesh, ttl: 0.45 + Math.random() * 0.3,
      vel: new THREE.Vector3((Math.random() - 0.5) * spd, Math.random() * spd * 0.8, (Math.random() - 0.5) * spd),
    });
  }
}
const bloodBurst = p => burst(p, 0xaa1111, 7, 4);
const debrisBurst = p => burst(p, 0x8a8a8a, 5, 3);
const deathBurst = p => { burst(p.clone().add(new THREE.Vector3(0, 1, 0)), 0xaa1111, 16, 5); };

function updateFx(dt) {
  for (let i = tracers.length - 1; i >= 0; i--) {
    const t = tracers[i];
    t.ttl -= dt;
    t.obj.material.opacity = Math.max(0, t.ttl / 0.09) * 0.85;
    if (t.ttl <= 0) { scene.remove(t.obj); t.obj.geometry.dispose(); t.obj.material.dispose(); tracers.splice(i, 1); }
  }
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.ttl -= dt;
    p.vel.y -= 12 * dt;
    p.obj.position.addScaledVector(p.vel, dt);
    if (p.ttl <= 0) { scene.remove(p.obj); p.obj.geometry.dispose(); p.obj.material.dispose(); particles.splice(i, 1); }
  }
  for (let i = dmgTexts.length - 1; i >= 0; i--) {
    const d = dmgTexts[i];
    d.ttl -= dt;
    d.obj.position.y += dt * 1.3;
    d.obj.material.opacity = Math.max(0, d.ttl / 0.8);
    if (d.ttl <= 0) { scene.remove(d.obj); d.obj.material.map.dispose(); d.obj.material.dispose(); dmgTexts.splice(i, 1); }
  }
}

// ============================================================
// View model (gun in hands)
// ============================================================
const vm = { group: null, models: {}, recoil: 0, bob: 0 };

function buildViewModels() {
  vm.group = new THREE.Group();
  camera.add(vm.group);
  vm.group.position.set(0.32, -0.3, -0.55);

  const dark = new THREE.MeshLambertMaterial({ color: 0x26262b });
  const dark2 = new THREE.MeshLambertMaterial({ color: 0x3a3a40 });
  const wood = new THREE.MeshLambertMaterial({ color: 0x6e4f2a });
  const hand = new THREE.MeshLambertMaterial({ color: 0xd8a37a });
  vm.mats = { dark, dark2, wood }; // recoloured by the equipped weapon skin

  function gunBase() {
    const g = new THREE.Group();
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.1), hand);
    h.position.set(0, -0.07, 0.08);
    g.add(h);
    return g;
  }

  // rifle
  {
    const g = gunBase();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.1, 0.5), dark);
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.045, 0.3), dark2);
    barrel.position.set(0, 0.01, -0.38);
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, 0.08), dark2);
    mag.position.set(0, -0.11, -0.02);
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.16), wood);
    stock.position.set(0, -0.01, 0.3);
    g.add(body, barrel, mag, stock);
    vm.models.rifle = g;
  }
  // shotgun
  {
    const g = gunBase();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.09, 0.45), wood);
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.35), dark);
    barrel.position.set(0, 0.03, -0.35);
    const pump = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.06, 0.14), dark2);
    pump.position.set(0, -0.04, -0.22);
    g.add(body, barrel, pump);
    vm.models.shotgun = g;
  }
  // sniper
  {
    const g = gunBase();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.09, 0.55), dark);
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.035, 0.45), dark2);
    barrel.position.set(0, 0.02, -0.48);
    const scope = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.16), dark2);
    scope.position.set(0, 0.09, -0.05);
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.09, 0.18), wood);
    stock.position.set(0, -0.01, 0.33);
    g.add(body, barrel, scope, stock);
    vm.models.sniper = g;
  }
  // smg
  {
    const g = gunBase();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.065, 0.09, 0.34), dark);
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.16), dark2);
    barrel.position.set(0, 0.01, -0.26);
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.16, 0.06), dark2);
    mag.position.set(0, -0.13, 0.02);
    g.add(body, barrel, mag);
    vm.models.smg = g;
  }
  // lmg
  {
    const g = gunBase();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.12, 0.55), dark);
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.34), dark2);
    barrel.position.set(0, 0.02, -0.42);
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.13, 0.16), dark2);
    box.position.set(0, -0.12, 0.05);
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 0.16), dark);
    stock.position.set(0, -0.01, 0.33);
    g.add(body, barrel, box, stock);
    vm.models.lmg = g;
  }
  // pistol
  {
    const g = gunBase();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.075, 0.2), dark);
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.035, 0.08), dark2);
    barrel.position.set(0, 0.02, -0.14);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 0.06), dark2);
    grip.position.set(0, -0.1, 0.05);
    g.add(body, barrel, grip);
    vm.models.pistol = g;
  }
  // block in hand
  {
    const g = new THREE.Group();
    const cube = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, 0.26), mats[myTeam === 'red' ? 'redWool' : 'blueWool']);
    cube.rotation.y = 0.5;
    g.add(cube);
    vm.models.blocks = g;
  }
  // pickaxe in hand
  {
    const g = gunBase();
    const stone = new THREE.MeshLambertMaterial({ color: 0x7a7a7a });
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.55), wood);
    handle.rotation.x = -0.5;
    handle.position.set(0, 0.05, -0.15);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.34, 0.09), stone);
    head.rotation.x = -0.5;
    head.position.set(0, 0.21, -0.38);
    const tipT = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 0.08), stone);
    tipT.rotation.x = -0.5;
    tipT.position.set(0, 0.33, -0.32);
    const tipB = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 0.08), stone);
    tipB.rotation.x = -0.5;
    tipB.position.set(0, 0.1, -0.45);
    g.add(handle, head, tipT, tipB);
    vm.models.pickaxe = g;
  }
  // bazooka in hand
  {
    const g = gunBase();
    const tube = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.13, 0.85), new THREE.MeshLambertMaterial({ color: 0x3c4632 }));
    tube.position.set(0, 0.04, -0.1);
    const muzzle = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.17, 0.1), new THREE.MeshLambertMaterial({ color: 0xc23425 }));
    muzzle.position.set(0, 0.04, -0.55);
    const rear = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.08), dark2);
    rear.position.set(0, 0.04, 0.33);
    const sight = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.07, 0.12), dark);
    sight.position.set(0, 0.15, -0.2);
    g.add(tube, muzzle, rear, sight);
    vm.models.bazooka = g;
  }
  for (const m of Object.values(vm.models)) { vm.group.add(m); m.visible = false; }
  vm.models[SLOTS[me.slot]].visible = true;
  // muzzle flash (tinted by the equipped skin's tracer colour on each shot)
  const muzzle = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3),
    new THREE.MeshBasicMaterial({ color: 0xffd080, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
  muzzle.position.set(0, 0.0, -0.62);
  vm.group.add(muzzle); vm.muzzle = muzzle; vm.flash = 0;
  applyWeaponSkin(equippedSkin); // paint the guns with the player's equipped skin
}

function updateViewModel(dt, moving) {
  if (!vm.group) return;
  vm.recoil = Math.max(0, vm.recoil - dt * 7);
  vm.bob += dt * (moving ? 9 : 2);
  const bobAmt = moving ? 0.012 : 0.004;
  const targetX = me.zoomed && SLOTS[me.slot] === 'sniper' ? 0 : 0.32;
  vm.group.position.x += (targetX - vm.group.position.x) * Math.min(1, dt * 12);
  vm.group.position.y = -0.3 + Math.sin(vm.bob) * bobAmt;
  vm.group.position.z = -0.55 + vm.recoil * 0.09;
  vm.group.rotation.x = vm.recoil * 0.14;
  vm.group.visible = !me.dead && !(me.zoomed && SLOTS[me.slot] === 'sniper');
  // muzzle flash fade
  if (vm.muzzle) {
    vm.flash = Math.max(0, vm.flash - dt * 11);
    vm.muzzle.material.opacity = vm.flash * 0.9;
    const sc = 0.5 + vm.flash * 1.1; vm.muzzle.scale.set(sc, sc, sc);
    vm.muzzle.rotation.z += dt * 10;
    vm.muzzle.visible = vm.flash > 0.01;
  }
  // animated glow pulse for premium skins
  if (vm.mats && GLOW_SKINS.has(equippedSkin)) {
    const gi = 0.7 + Math.sin(performance.now() * 0.006) * 0.5;
    vm.mats.dark.emissiveIntensity = gi; vm.mats.dark2.emissiveIntensity = gi; vm.mats.wood.emissiveIntensity = gi;
  }
  // weapon inspect animation (Y / F): lift and spin the gun to show off the skin
  if (vm.inspectT > 0) {
    vm.inspectT = Math.max(0, vm.inspectT - dt);
    const p = 1 - vm.inspectT / INSPECT_DUR;      // 0 -> 1
    const e = Math.sin(p * Math.PI);              // 0 -> 1 -> 0 envelope
    vm.group.position.x += -0.14 * e;
    vm.group.position.y += 0.07 * e;
    vm.group.position.z += 0.12 * e;
    vm.group.rotation.y += 1.7 * Math.sin(p * Math.PI * 2); // turn to the side and back
    vm.group.rotation.z += 0.55 * e;
    vm.group.rotation.x += -0.35 * e;
  }
}
const INSPECT_DUR = 1.6;
function startInspect() {
  if (!vm || !vm.group || !inGame || me.dead || (typeof chatOpen !== 'undefined' && chatOpen)) return;
  vm.inspectT = INSPECT_DUR;
  const s = SKINS[equippedSkin], lbl = $('inspectLbl');
  if (lbl && s) { lbl.textContent = s.name; lbl.style.opacity = '1'; clearTimeout(lbl._t); lbl._t = setTimeout(() => lbl.style.opacity = '0', 1600); }
  try { tone(300, 0.05, 0.06, 'sine'); tone(460, 0.05, 0.05, 'sine'); } catch {}
}

function selectSlot(i) {
  if (i < 0 || i >= SLOTS.length || i === me.slot) return;
  // Gun Game: only the current rung weapon and blocks are selectable.
  if (gameMode === 'gg' && SLOTS[i] !== ggWeaponKey() && SLOTS[i] !== 'blocks') return;
  me.slot = i;
  me.zoomed = false;
  for (const [k, m] of Object.entries(vm.models)) m.visible = (k === SLOTS[i]);
  updateHotbar(); updateAmmoHud();
  tone(420, 0.04, 0.08, 'square');
}

// ---- Gun Game helpers ----
function ggWeaponKey() { return GG_LADDER[Math.min(myLevel, GG_LADDER.length - 1)]; }
function applyGunGameWeapon() {
  if (gameMode !== 'gg') return;
  const i = SLOTS.indexOf(ggWeaponKey());
  if (i >= 0) {
    me.slot = i;
    me.zoomed = false;
    if (vm && vm.models) for (const [k, mo] of Object.entries(vm.models)) mo.visible = (k === SLOTS[i]);
  }
  updateHotbar(); updateAmmoHud(); updateGGHud();
}
function setGunGameUI(on) {
  const st = $('scoreTop'); if (st) st.style.display = on ? 'none' : '';
  const gg = $('ggHud'); if (gg) gg.style.display = on ? 'block' : 'none';
  if (on) updateGGHud();
}
function updateGGHud() {
  const el = $('ggHud'); if (!el || gameMode !== 'gg') return;
  const total = GG_LADDER.length;
  const cur = Math.min(myLevel, total - 1);
  const pips = GG_LADDER.map((_, i) => `<i class="${i < myLevel ? 'done' : i === cur ? 'now' : ''}"></i>`).join('');
  el.innerHTML = `<div class="lvl">GUN GAME · WEAPON ${Math.min(myLevel + 1, total)}/${total}</div>`
    + `<div class="pips">${pips}</div>`
    + `<div class="wpn">${WEAPONS[ggWeaponKey()]?.name || ''}</div>`;
}

// ============================================================
// HUD
// ============================================================
let heartFull, heartHalf, heartEmpty;
function makeHeart(fill) {
  const rows = ['.XX.XX.', 'XXXXXXX', 'XXXXXXX', '.XXXXX.', '..XXX..', '...X...'];
  const c = document.createElement('canvas'); c.width = 9; c.height = 8;
  const g = c.getContext('2d');
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch !== 'X') return;
      g.fillStyle = '#000'; g.fillRect(x, y + 1, 1, 1);
    });
  });
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch !== 'X') return;
      let col = '#3b0a0a';
      if (fill === 'full' || (fill === 'half' && x < 4)) col = (y < 2 && (x === 1 || x === 4)) ? '#ff6a6a' : '#e2210b';
      g.fillStyle = col; g.fillRect(x + 0.5, y + 0.5, 1, 1);
    });
  });
  return c.toDataURL();
}

function updateHearts() {
  const wrap = $('hearts');
  if (!heartFull) { heartFull = makeHeart('full'); heartHalf = makeHeart('half'); heartEmpty = makeHeart('empty'); }
  wrap.innerHTML = '';
  const hp = Math.max(0, me.hp);
  for (let i = 0; i < 10; i++) {
    const img = document.createElement('img');
    const lo = i * 10;
    img.src = hp >= lo + 10 ? heartFull : hp >= lo + 5 ? heartHalf : heartEmpty;
    wrap.appendChild(img);
  }
}

function drawIcon(kind) {
  const c = document.createElement('canvas'); c.width = 32; c.height = 32;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  if (kind === 'blocks') {
    const cols = myTeam === 'red'
      ? ['#b03430', '#a32e2a', '#bd3d38'] : ['#3a4fb4', '#3448a6', '#4458c2'];
    for (let y = 6; y < 26; y++) for (let x = 6; x < 26; x++) {
      g.fillStyle = cols[Math.floor(Math.random() * cols.length)];
      g.fillRect(x, y, 1, 1);
    }
    g.strokeStyle = '#000'; g.strokeRect(6, 6, 20, 20);
    return c.toDataURL();
  }
  if (kind === 'pickaxe') {
    // diagonal wooden handle
    g.fillStyle = '#6e4f2a';
    for (let i = 0; i < 16; i++) g.fillRect(6 + i, 24 - i, 3, 3);
    // stone head (arc across the top)
    g.fillStyle = '#7a7a7a';
    g.fillRect(4, 6, 6, 4); g.fillRect(8, 4, 8, 4); g.fillRect(16, 4, 6, 4); g.fillRect(21, 6, 5, 4); g.fillRect(24, 9, 4, 5);
    g.fillStyle = '#9a9a9a';
    g.fillRect(8, 5, 12, 2);
    return c.toDataURL();
  }
  if (kind === 'bazooka') {
    g.fillStyle = '#3c4632'; g.fillRect(2, 13, 26, 7);   // tube
    g.fillStyle = '#2b331f'; g.fillRect(2, 13, 26, 2);
    g.fillStyle = '#c23425'; g.fillRect(0, 11, 4, 11);   // muzzle ring
    g.fillStyle = '#555';    g.fillRect(26, 11, 4, 11);  // rear ring
    g.fillStyle = '#222';    g.fillRect(12, 20, 4, 6);   // grip
    g.fillStyle = '#777';    g.fillRect(16, 9, 8, 4);    // sight
    return c.toDataURL();
  }
  g.fillStyle = '#222';
  if (kind === 'rifle') {
    g.fillRect(2, 14, 24, 5);
    g.fillRect(24, 15, 6, 3);
    g.fillStyle = '#444'; g.fillRect(10, 19, 4, 7);
    g.fillStyle = '#6e4f2a'; g.fillRect(2, 13, 6, 8);
    g.fillStyle = '#444'; g.fillRect(16, 11, 6, 3);
  } else if (kind === 'shotgun') {
    g.fillStyle = '#6e4f2a'; g.fillRect(2, 14, 10, 7);
    g.fillStyle = '#222'; g.fillRect(10, 14, 20, 4);
    g.fillStyle = '#555'; g.fillRect(14, 18, 7, 4);
  } else if (kind === 'sniper') {
    g.fillRect(2, 16, 28, 3);
    g.fillStyle = '#444'; g.fillRect(8, 11, 8, 4);
    g.fillStyle = '#6e4f2a'; g.fillRect(2, 15, 5, 7);
    g.fillStyle = '#555'; g.fillRect(12, 19, 3, 5);
  } else if (kind === 'smg') {
    g.fillRect(4, 14, 16, 5);
    g.fillStyle = '#444'; g.fillRect(18, 15, 6, 3);
    g.fillStyle = '#444'; g.fillRect(9, 19, 4, 8);
    g.fillStyle = '#555'; g.fillRect(5, 12, 5, 3);
  } else if (kind === 'lmg') {
    g.fillRect(2, 13, 26, 6);
    g.fillStyle = '#444'; g.fillRect(11, 19, 6, 9);
    g.fillStyle = '#555'; g.fillRect(24, 11, 6, 4);
    g.fillStyle = '#777'; g.fillRect(6, 19, 3, 8); g.fillRect(19, 19, 3, 8);
  } else if (kind === 'pistol') {
    g.fillRect(8, 12, 16, 4);
    g.fillStyle = '#444'; g.fillRect(9, 15, 6, 9);
    g.fillStyle = '#555'; g.fillRect(22, 13, 3, 3);
  }
  return c.toDataURL();
}

function updateHotbar() {
  const bar = $('hotbar');
  bar.innerHTML = '';
  // Gun Game shows only your current rung weapon + blocks; everything else is hidden.
  const visible = gameMode === 'gg' ? [ggWeaponKey(), 'blocks'] : SLOTS;
  visible.forEach((s, pos) => {
    const i = SLOTS.indexOf(s);
    const div = document.createElement('div');
    div.className = 'slot' + (i === me.slot ? ' sel' : '');
    div.dataset.slot = i;
    const img = document.createElement('img');
    img.src = drawIcon(s);
    div.appendChild(img);
    const key = document.createElement('span');
    key.className = 'key'; key.textContent = pos + 1;
    div.appendChild(key);
    if (s === 'blocks') {
      const cnt = document.createElement('span');
      cnt.className = 'cnt'; cnt.textContent = me.blocks;
      div.appendChild(cnt);
    }
    div.addEventListener('click', () => selectSlot(i));
    bar.appendChild(div);
  });
}

function updateAmmoHud() {
  const wkey = SLOTS[me.slot];
  const w = WEAPONS[wkey];
  $('weaponName').textContent = w.name;
  $('ammoNum').textContent = w.builder ? `${me.blocks}` : w.tool ? '—' : `${me.ammo[wkey]} / ${w.mag}`;
  const nh = $('nadeHud'); if (nh) nh.innerHTML = `NADE x${me.nades} <span style="color:#888">[G]</span>`;
}

function feed(text, teamA, teamB) {
  const kf = $('killfeed');
  const div = document.createElement('div');
  div.textContent = text;
  div.className = teamA === 'red' ? 'r' : 'b';
  kf.prepend(div);
  while (kf.children.length > 6) kf.lastChild.remove();
  setTimeout(() => div.remove(), 5000);
}

function showDeathScreen(killerName) {
  $('deathScreen').style.display = 'flex';
  $('deathBy').textContent = `Killed by: ${killerName}`;
  let left = 3.5;
  const cd = $('deathCd');
  const iv = setInterval(() => {
    left -= 0.1;
    if (left <= 0 || !me.dead) { clearInterval(iv); cd.textContent = ''; return; }
    cd.textContent = `Respawning in ${left.toFixed(1)}s`;
  }, 100);
}

function updateScoreboard() {
  const sb = $('scoreboard');
  if (!tabHeld) { sb.style.display = 'none'; return; }
  const all = [
    { name: myName + ' (you)', team: myTeam, kills: me.kills, deaths: me.deaths, me: true },
    ...[...remotes.values()].map(r => ({ name: r.name, team: r.team, kills: r.kills, deaths: r.deaths })),
  ];
  const row = p => `<tr><td class="${p.me ? 'me' : ''}">${p.name}</td><td>${p.kills}</td><td>${p.deaths}</td></tr>`;
  const table = list => `<table><tr><th>PLAYER</th><th>KILLS</th><th>DEATHS</th></tr>${list.sort((a, b) => b.kills - a.kills).map(row).join('')}</table>`;
  sb.innerHTML =
    `<h3 class="red">RED — ${scores.red}</h3>` + table(all.filter(p => p.team === 'red')) +
    `<h3 class="blue">BLUE — ${scores.blue}</h3>` + table(all.filter(p => p.team === 'blue'));
  sb.style.display = 'block';
}

// ============================================================
// Input
// ============================================================
function setupInput() {
  const canvas = renderer.domElement;
  document.addEventListener('keydown', e => {
    if (!inGame) return;
    if (chatOpen) {
      if (e.code === 'Escape') closeChat();
      if (e.code === 'Enter') {
        const text = $('chatInput').value.trim();
        if (text) {
          const w = text.match(/^\/w(?:hisper)?\s+(\S+)\s+([\s\S]+)$/i); // /w <name> <message>
          if (w) netSend({ t: 'whisper', to: w[1], text: w[2] });
          else netSend({ t: 'chat', text });
        }
        closeChat();
      }
      return;
    }
    if (e.code === 'KeyT' || e.code === 'Enter') { e.preventDefault(); openChat(); return; }
    if (e.code === 'KeyV' && !e.repeat) setTalking(true);
    keys[e.code] = true;
    if (e.code === 'Tab') { e.preventDefault(); tabHeld = true; updateScoreboard(); }
    if (e.code === 'KeyR') startReload();
    if (e.code === 'KeyG' && !e.repeat) throwGrenade();
    if (e.code === 'KeyB' && !e.repeat) deployTurret();
    if ((e.code === 'KeyY' || e.code === 'KeyF') && !e.repeat) startInspect();
    if (/^Digit[1-9]$/.test(e.code)) {
      const n = parseInt(e.code[5]) - 1;
      if (gameMode === 'gg') { const v = [ggWeaponKey(), 'blocks']; if (n < v.length) selectSlot(SLOTS.indexOf(v[n])); }
      else selectSlot(n);
    }
  });
  document.addEventListener('keyup', e => {
    if (e.code === 'KeyV') setTalking(false);
    if (chatOpen) return;
    keys[e.code] = false;
    if (e.code === 'Tab') { tabHeld = false; updateScoreboard(); }
  });
  document.addEventListener('mousemove', e => {
    if (!locked || me.dead) return;
    me.ry -= e.movementX * SENS * lookMul;
    me.rx -= e.movementY * SENS * lookMul * (me.zoomed ? 0.5 : 1);
    me.rx = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, me.rx));
  });
  document.addEventListener('mousedown', e => {
    if (!inGame || chatOpen) return;
    if (!locked) { canvas.requestPointerLock(); return; }
    if (e.button === 0) {
      mouseDown = true;
      tryShoot(performance.now());
    } else if (e.button === 2) {
      me.zoomed = !me.zoomed;
    }
  });
  document.addEventListener('mouseup', e => { if (e.button === 0) mouseDown = false; });
  document.addEventListener('contextmenu', e => e.preventDefault());
  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
    if (inGame) {
      $('pauseHint').style.display = locked ? 'none' : 'flex';
      if (!locked) refreshSettingInputs();
      $('teamBanner').style.display = 'none';
    }
    if (!locked) { mouseDown = false; Object.keys(keys).forEach(k => keys[k] = false); }
  });
  $('resumeBtn').addEventListener('click', () => canvas.requestPointerLock());
  $('menuBtnPause') && $('menuBtnPause').addEventListener('click', leaveGame);
  $('menuBtnOver') && $('menuBtnOver').addEventListener('click', leaveGame);
  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
}

// ============================================================
// Touch controls (phones / tablets): virtual joystick + drag-look + buttons
// ============================================================
const TOUCH_SENS = 0.006;
function setupTouch() {
  const coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
  if (!coarse && !('ontouchstart' in window && innerWidth < 1024)) return;
  mobile = true;
  $('touch').style.display = 'block';
  $('rotateHint').classList.add('armed'); // CSS shows it only in portrait

  const joyWrap = $('joyWrap'), knob = $('joyKnob');
  const R = 52;
  let joyId = null, jcx = 0, jcy = 0;
  let lookId = null, lx = 0, ly = 0;

  const onControl = t => t.target.closest && t.target.closest('.mbtn, #joyWrap, #hotbar, #chat');

  function moveJoy(dx, dy) {
    const d = Math.hypot(dx, dy) || 1;
    const cl = Math.min(1, R / d);
    knob.style.transform = `translate(${dx * cl}px, ${dy * cl}px)`;
    const nx = Math.max(-1, Math.min(1, dx / R));
    const nz = Math.max(-1, Math.min(1, dy / R)); // up = forward = negative
    const mag = Math.min(1, Math.hypot(nx, nz));
    mobileMove.active = mag > 0.12;
    mobileMove.x = nx; mobileMove.z = nz;
    mobileSprint = mag > 0.9;
  }
  function resetJoy() {
    knob.style.transform = 'translate(0,0)';
    mobileMove.active = false; mobileMove.x = 0; mobileMove.z = 0; mobileSprint = false;
  }

  addEventListener('touchstart', e => {
    for (const t of e.changedTouches) {
      if (t.target.closest && t.target.closest('#joyWrap')) {
        joyId = t.identifier;
        const r = joyWrap.getBoundingClientRect();
        jcx = r.left + r.width / 2; jcy = r.top + r.height / 2;
        moveJoy(t.clientX - jcx, t.clientY - jcy);
      } else if (!onControl(t) && lookId === null && inGame && !chatOpen) {
        lookId = t.identifier; lx = t.clientX; ly = t.clientY;
      }
    }
  }, { passive: false });

  addEventListener('touchmove', e => {
    for (const t of e.changedTouches) {
      if (t.identifier === joyId) { moveJoy(t.clientX - jcx, t.clientY - jcy); e.preventDefault(); }
      else if (t.identifier === lookId && !me.dead) {
        me.ry -= (t.clientX - lx) * TOUCH_SENS * lookMul;
        me.rx -= (t.clientY - ly) * TOUCH_SENS * lookMul * (me.zoomed ? 0.5 : 1);
        me.rx = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, me.rx));
        lx = t.clientX; ly = t.clientY; e.preventDefault();
      }
    }
  }, { passive: false });

  const end = e => {
    for (const t of e.changedTouches) {
      if (t.identifier === joyId) { joyId = null; resetJoy(); }
      if (t.identifier === lookId) lookId = null;
    }
  };
  addEventListener('touchend', end);
  addEventListener('touchcancel', end);

  const press = (id, on, off) => {
    const el = $(id);
    el.addEventListener('touchstart', e => { e.preventDefault(); e.stopPropagation(); on(); }, { passive: false });
    if (off) el.addEventListener('touchend', e => { e.preventDefault(); e.stopPropagation(); off(); });
  };
  press('btnFire', () => { mouseDown = true; if (!me.dead) tryShoot(performance.now()); }, () => { mouseDown = false; });
  press('btnJump', () => { keys['Space'] = true; }, () => { keys['Space'] = false; });
  press('btnReload', () => startReload());
  press('btnNade', () => throwGrenade());
  press('btnAim', () => { me.zoomed = !me.zoomed; });
  press('btnSprint', () => { sprintHeld = true; }, () => { sprintHeld = false; });

  // voice: tap to toggle mic on/off (mobile has no push-to-talk V key)
  const bv = $('btnVoice');
  bv.addEventListener('touchstart', e => {
    e.preventDefault(); e.stopPropagation();
    const on = !bv.classList.contains('on');
    setTalking(on);
    bv.classList.toggle('on', on);
  }, { passive: false });

  // tap the hotbar to switch weapons
  $('hotbar').addEventListener('touchstart', e => {
    const slot = e.target.closest('.slot');
    if (!slot) return;
    const i = +slot.dataset.slot;
    if (i >= 0) selectSlot(i);
    e.preventDefault();
  }, { passive: false });
}

// ============================================================
// Scene / game start
// ============================================================
function initScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb);
  scene.fog = new THREE.Fog(0x87ceeb, 60, 140);

  camera = new THREE.PerspectiveCamera(fov, innerWidth / innerHeight, 0.08, 300);
  scene.add(camera);

  renderer = new THREE.WebGLRenderer({ canvas: $('game'), antialias: false });
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.type = THREE.PCFShadowMap;
  applyGfx(); // pixel ratio + shadows from the saved quality setting

  ambLight = new THREE.AmbientLight(0xffffff, 0.75);
  scene.add(ambLight);
  const sun = new THREE.DirectionalLight(0xfff4d6, 1.6);
  sunLight = sun;
  sun.position.set(40, 70, 25);
  sun.castShadow = gfxQuality !== 'low';
  sun.shadow.mapSize.set(1024, 1024); // 1024 instead of 2048 — 4x cheaper shadow pass, big win on the occasional stutter
  sun.shadow.camera.left = -50; sun.shadow.camera.right = 50;
  sun.shadow.camera.top = 50; sun.shadow.camera.bottom = -50;
  sun.shadow.camera.far = 200;
  sun.shadow.bias = -0.0004;
  scene.add(sun);

  // clouds
  const cloudMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
  for (let i = 0; i < 10; i++) {
    const c = new THREE.Mesh(new THREE.BoxGeometry(6 + Math.random() * 10, 0.8, 4 + Math.random() * 6), cloudMat);
    c.position.set(Math.random() * 180 - 90, 36 + Math.random() * 8, Math.random() * 180 - 90);
    c.userData.cloud = true;
    scene.add(c);
  }

  tex = buildTextures();
  mats = buildMaterials(tex);
  faceTex = makeFaceTexture();
  buildWorld();
}

function startGame() {
  inGame = true;
  me.blocks = AGENTS[myAgent]?.blocks || 64;
  me.nades = AGENTS[myAgent]?.nades ?? MAX_NADES;
  $('menu').style.display = 'none';
  $('hud').style.display = 'block';
  $('scoreRed').textContent = scores.red;
  $('scoreBlue').textContent = scores.blue;
  const banner = $('teamBanner');
  banner.style.display = 'flex';
  const t = $('teamBannerText');
  t.textContent = `YOU ARE ON TEAM ${TEAM_RU[myTeam]}`;
  t.style.color = TEAM_COL[myTeam];
  buildViewModels();
  updateHearts(); updateHotbar(); updateAmmoHud();
  SND.spawn();
  if (mobile) setTimeout(() => { $('teamBanner').style.display = 'none'; }, 1600);
  else renderer.domElement.requestPointerLock();
}

// ============================================================
// Minimap (top-down radar, rotated so the player faces up)
// ============================================================
let miniCtx = null, lastMini = 0, lastLowHp = 0;
let matchStart = 0;
function updateMatchTimer() {
  const el = $('matchTimer'); if (!el) return;
  const s = Math.max(0, Math.floor((performance.now() - matchStart) / 1000));
  el.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
// Live streak + overshield badges under the minimap.
function updateBuffHud(now) {
  const sh = $('streakHud');
  if (sh) {
    if (killStreak >= 2 && !me.dead) { sh.style.display = 'block'; sh.textContent = 'STREAK ×' + killStreak; }
    else sh.style.display = 'none';
  }
  const bh = $('shieldHud');
  if (bh) {
    const rem = me.shieldUntil - now;
    if (rem > 0 && !me.dead) { bh.style.display = 'block'; bh.textContent = 'SHIELD ' + Math.ceil(rem / 1000) + 's'; }
    else bh.style.display = 'none';
  }
  const th = $('turretHud');
  if (th) {
    const rem = turretCdUntil - now;
    th.style.display = 'block';
    if (rem > 0) { th.innerHTML = `TURRET <span style="color:#888">${Math.ceil(rem / 1000)}s</span>`; th.style.opacity = '0.6'; }
    else { th.innerHTML = `TURRET <span style="color:#888">[B]</span> ${TURRET_COST}${COIN}`; th.style.opacity = coins >= TURRET_COST ? '1' : '0.5'; }
  }
}
// Survival: show the wave counter + raiders remaining (in place of team score).
function updateWaveHud() {
  const el = $('waveHud'); if (!el) return;
  if (gameMode !== 'surv') { el.style.display = 'none'; return; }
  const st = $('scoreTop'); if (st) st.style.display = 'none';
  const alive = [...remotes.values()].filter(r => r.team !== myTeam && r.alive).length;
  el.style.display = 'block';
  const sub = waveNum < 1 ? 'get ready…' : alive > 0 ? `${alive} raider${alive === 1 ? '' : 's'} left` : 'brace for the next wave…';
  el.innerHTML = `WAVE <b>${Math.max(waveNum, 0)}</b> / ${scoreLimit}<span class="sub">${sub}</span>`;
}
function drawMinimap() {
  const cv = $('minimap'); if (!cv) return;
  if (!miniCtx) miniCtx = cv.getContext('2d');
  const g = miniCtx, W = cv.width, R = W / 2, scale = R / 42;
  const ca = Math.cos(me.ry), sa = Math.sin(me.ry);
  g.clearRect(0, 0, W, W);
  g.fillStyle = 'rgba(0,0,0,0.5)'; g.beginPath(); g.arc(R, R, R - 1, 0, Math.PI * 2); g.fill();
  const plot = (wx, wz) => {
    const dx = wx - me.pos.x, dz = wz - me.pos.z;
    return [R + (dx * ca - dz * sa) * scale, R + (dx * sa + dz * ca) * scale];
  };
  // pickups (health = green, supply = olive) — only while active
  for (const pm of pickupMeshes) {
    if (!pm.mesh.visible) continue;
    const [px, py] = plot(pm.mesh.position.x, pm.mesh.position.z);
    if (Math.hypot(px - R, py - R) > R - 2) continue;
    g.fillStyle = pm.type === 'supply' ? '#c8b84a' : '#49c26a';
    g.fillRect(px - 2, py - 2, 4, 4);
  }
  // Domination zone (circle marker at origin, coloured by owner)
  if (gameMode === 'dom') {
    const [zx, zy] = plot(0, 0);
    g.strokeStyle = zoneState ? (zoneState.contested ? '#ffd24a' : zoneCss(zoneState.owner)) : '#aaaaaa';
    g.lineWidth = 1.6;
    g.beginPath(); g.arc(zx, zy, Math.min(ZONE_RADIUS * scale, R - 2), 0, Math.PI * 2); g.stroke();
  }
  // CTF flags (diamond markers)
  if (gameMode === 'ctf' && flagMeshes.red) {
    for (const t of ['red', 'blue']) {
      const fm = flagMeshes[t]; if (!fm || !fm.visible) continue;
      const [px, py] = plot(fm.position.x, fm.position.z);
      if (Math.hypot(px - R, py - R) > R - 2) continue;
      g.fillStyle = t === 'red' ? '#ff5555' : '#7f9fff';
      g.beginPath(); g.moveTo(px, py - 4); g.lineTo(px + 4, py); g.lineTo(px, py + 4); g.lineTo(px - 4, py); g.closePath(); g.fill();
      g.strokeStyle = '#000'; g.lineWidth = 1; g.stroke();
    }
  }
  for (const r of remotes.values()) {
    if (!r.alive) continue;
    const [px, py] = plot(r.group.position.x, r.group.position.z);
    if (Math.hypot(px - R, py - R) > R - 2) continue;
    g.fillStyle = r.team === myTeam ? '#66ccff' : '#ff5555';
    g.beginPath(); g.arc(px, py, 2.6, 0, Math.PI * 2); g.fill();
  }
  g.fillStyle = '#fff';
  g.beginPath(); g.moveTo(R, R - 5); g.lineTo(R - 4, R + 4); g.lineTo(R + 4, R + 4); g.closePath(); g.fill();
}

// ============================================================
// Main loop
// ============================================================
let lastNetSend = 0, lastAnim = 0;

function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, clock.getDelta());
  const now = performance.now();

  if (inGame) {
    let moving = 0;
    if (!me.dead && (locked || mobile)) {
      moving = movePlayer(dt);
      lastAnim = moving;
      const w = currentWeapon();
      if (mouseDown && w.auto) tryShoot(now);
    } else if (!me.dead) {
      me.vel.x = me.vel.z = 0;
    }

    camera.rotation.order = 'YXZ';
    camera.rotation.y = me.ry;
    camera.rotation.x = me.rx;
    camera.position.set(me.pos.x, me.pos.y + EYE, me.pos.z);

    // fov: zoom / sprint
    const targetFov = me.zoomed ? (SLOTS[me.slot] === 'sniper' ? 22 : 55)
      : ((keys['ShiftLeft'] || keys['ShiftRight']) && moving ? 76 : 70);
    camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 10);
    camera.updateProjectionMatrix();

    updateRemotes(dt);
    updateRockets(dt);
    updateGrenades(dt);
    updatePickups(dt);
    updateFx(dt);
    updateViewModel(dt, moving > 0);
    if (tabHeld) updateScoreboard();
    if (now - lastMini > 90) { lastMini = now; drawMinimap(); updateMatchTimer(); updateBuffHud(now); updateWaveHud(); }
    if (!me.dead && me.hp > 0 && me.hp < 30 && now - lastLowHp > 850) { lastLowHp = now; SND.lowhp(); }

    // clouds drift
    scene.traverse(o => {
      if (o.userData.cloud) {
        o.position.x += dt * 0.9;
        if (o.position.x > 100) o.position.x = -100;
      }
    });

    if (now - lastNetSend > 50 && !me.dead) {
      lastNetSend = now;
      netSend({
        t: 'state',
        pos: { x: +me.pos.x.toFixed(3), y: +me.pos.y.toFixed(3), z: +me.pos.z.toFixed(3) },
        ry: +me.ry.toFixed(3), rx: +me.rx.toFixed(3), anim: +lastAnim.toFixed(2),
      });
    }
  }

  renderer.render(scene, camera);
}

// ============================================================
setupMenu();
initScene();
setupInput();
setupTouch();
clock = new THREE.Clock();
loop();

// ---------------------------------------------------------------------------
// Debug overlay (F3) — network + server tick diagnostics.
// Client-observed tick health (inter-snapshot gaps) + server self-report via
// ping/pong: tick drift (the DO utilization proxy), msg/byte rates, world size.
const dbgNet = { inMsgs: 0, inBytes: 0, outMsgs: 0, outBytes: 0 };
let dbgPrev = { ...dbgNet, at: performance.now() };
let dbgLastPayload = 0, dbgStatePayload = 0;
const dbgGaps = [];
let dbgLastStateAt = 0, dbgEntities = 0;
const dbgRtt = { last: 0, ema: 0 };
let dbgSrv = null, dbgOn = false;

function dbgOnStates(m) {
  const now = performance.now();
  if (dbgLastStateAt) {
    dbgGaps.push(now - dbgLastStateAt);
    if (dbgGaps.length > 60) dbgGaps.shift();
  }
  dbgLastStateAt = now;
  dbgEntities = m.states.length;
  dbgStatePayload = dbgLastPayload;
}

function dbgOnPong(m) {
  const rtt = performance.now() - m.ts;
  dbgRtt.last = rtt;
  dbgRtt.ema = dbgRtt.ema ? dbgRtt.ema * 0.8 + rtt * 0.2 : rtt;
  dbgSrv = m.srv || null;
}

setInterval(() => {
  netSend({ t: 'ping', ts: performance.now(), rtt: dbgRtt.last ? Math.round(dbgRtt.last) : undefined });
}, 1000);

document.addEventListener('keydown', e => {
  if (e.code === 'F3') {
    e.preventDefault();
    dbgOn = !dbgOn;
    const el = document.getElementById('dbg');
    if (el) el.style.display = dbgOn ? 'block' : 'none';
  }
});

setInterval(() => {
  if (!dbgOn) return;
  const el = document.getElementById('dbg');
  if (!el) return;
  const now = performance.now();
  const dt = Math.max(0.001, (now - dbgPrev.at) / 1000);
  const rate = (cur, prev) => (cur - prev) / dt;
  const kb = n => (n / 1024).toFixed(1);
  const sorted = [...dbgGaps].sort((a, b) => a - b);
  const avg = sorted.length ? sorted.reduce((s, v) => s + v, 0) / sorted.length : 0;
  const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
  const staleFor = dbgLastStateAt ? now - dbgLastStateAt : 0;
  const lines = [
    `NET  rtt ${dbgRtt.last.toFixed(0)}ms (avg ${dbgRtt.ema.toFixed(0)}ms)`,
    ` in  ${rate(dbgNet.inMsgs, dbgPrev.inMsgs).toFixed(0)} msg/s  ${kb(rate(dbgNet.inBytes, dbgPrev.inBytes))} KB/s`,
    ` out ${rate(dbgNet.outMsgs, dbgPrev.outMsgs).toFixed(0)} msg/s  ${kb(rate(dbgNet.outBytes, dbgPrev.outBytes))} KB/s`,
    `TICK (client-observed)`,
    ` ${avg ? (1000 / avg).toFixed(1) : '—'} Hz  gap avg ${avg.toFixed(1)}ms  p95 ${p95.toFixed(1)}ms`,
    ` snapshot ${dbgEntities} entities, ${dbgStatePayload} B` + (staleFor > 500 ? `  STALE ${(staleFor / 1000).toFixed(1)}s` : ''),
  ];
  if (dbgSrv) {
    const t = dbgSrv.tick;
    lines.push(
      `SRV  players ${dbgSrv.players}  up ${dbgSrv.uptimeSec}s  tick ${t.running ? '' : 'STOPPED '}${t.ema}ms/${t.target}ms (max ${t.max}ms)`,
      ` load(lag) ${t.lagPct}%  in ${dbgSrv.rates.inMsgs}/s ${dbgSrv.rates.inKb}KB/s  out ${dbgSrv.rates.outMsgs}/s ${dbgSrv.rates.outKb}KB/s`,
      ` world: placed ${dbgSrv.world.placed}  destroyed ${dbgSrv.world.destroyed}`,
    );
    if (dbgSrv.roster && dbgSrv.roster.length) {
      const byRtt = [...dbgSrv.roster].sort((a, b) => (b.rtt ?? -1) - (a.rtt ?? -1));
      const colos = {};
      for (const r of dbgSrv.roster) colos[r.colo] = (colos[r.colo] || 0) + 1;
      lines.push(`GEO  edges: ${Object.entries(colos).map(([c, n]) => c + 'x' + n).join(' ')}`);
      for (const r of byRtt.slice(0, 8)) {
        lines.push(` ${(r.rtt != null ? r.rtt + 'ms' : '—').padStart(6)}  ${r.colo}/${r.cc}  ${r.n}`);
      }
      if (byRtt.length > 8) lines.push(`  …and ${byRtt.length - 8} more`);
    }
  }
  el.textContent = lines.join('\n');
  dbgPrev = { ...dbgNet, at: now };
}, 500);
