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
};
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
let gameMode = 'dm';   // 'dm' (deathmatch) | 'ctf' (capture the flag) | 'gg' (gun game)
let menuMode = 'dm';   // mode chosen on the menu, sent at join
let myLevel = 0;       // gun-game rung (index into GG_LADDER)
let sunLight = null, ambLight = null;
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
};
const MAP_IDS = ['desert', 'arctic', 'volcano', 'night', 'metro'];
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
function saveCoins() { localStorage.setItem('bf_coins', String(coins)); }
function saveUnlocked() { localStorage.setItem('bf_unlocked', JSON.stringify([...unlocked])); }
function awardCoins(n) { coins += n; saveCoins(); const el = $('coinBal'); if (el) el.textContent = '🪙 ' + coins; }
let myAgent = (AGENTS[localStorage.getItem('blockade_agent')] && isUnlocked(localStorage.getItem('blockade_agent'))) ? localStorage.getItem('blockade_agent') : 'soldier';
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
let lookMul = parseFloat(localStorage.getItem('bf_sens') || '1') || 1;

const tracers = [], particles = [], flashes = [], rockets = [], grenades = [];

// ============================================================
// Audio (tiny synth)
// ============================================================
let AC = null;
function ac() { if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)(); return AC; }
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
    src.connect(f); f.connect(g); g.connect(ctx.destination);
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
    o.connect(g); g.connect(ctx.destination);
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
    $('agentArt').innerHTML = agentArtSVG(hex6(a.accent));
    $('agentName').textContent = a.name;
    $('agentRole').textContent = a.role;
    const cf = document.querySelector('.cardframe');
    if (cf) cf.style.borderColor = hex6(a.accent);
    const cb = $('coinBal'); if (cb) cb.textContent = '🪙 ' + coins;
    refreshChips();
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
    } else {
      if (err) err.textContent = `${AGENTS[id].name} is locked — need ${cost - coins} more 🪙 (you have ${coins})`;
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
  { const sm = localStorage.getItem('blockade_mode'); menuMode = (sm === 'ctf' || sm === 'gg') ? sm : 'dm'; }
  const modes = document.querySelectorAll('#modeRow .mode');
  const syncModes = () => modes.forEach(el => el.classList.toggle('active', el.dataset.mode === menuMode));
  modes.forEach(el => el.addEventListener('click', () => { menuMode = el.dataset.mode; localStorage.setItem('blockade_mode', menuMode); syncModes(); }));
  syncModes();

  // options panel toggle
  const optBtn = $('optBtn');
  if (optBtn) optBtn.addEventListener('click', () => $('optPanel').classList.toggle('open'));
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

  // sensitivity slider (persisted)
  const sr = $('sensRange'), lbl = $('sensVal');
  if (sr) {
    sr.value = lookMul; if (lbl) lbl.textContent = lookMul.toFixed(2) + 'x';
    sr.addEventListener('input', () => {
      lookMul = parseFloat(sr.value) || 1;
      localStorage.setItem('bf_sens', String(lookMul));
      if (lbl) lbl.textContent = lookMul.toFixed(2) + 'x';
    });
  }

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
}

// ============================================================
// Networking
// ============================================================
function connect(name) {
  myName = name;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // Served under a subpath (/play/<game>/); engine exposes the game socket at <base>/ws.
  const base = location.pathname.replace(/\/+$/, '');
  ws = new WebSocket(`${proto}://${location.host}${base}/ws`);
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name, room: myRoom, diff: botDiff, agent: myAgent, mode: menuMode, map: menuMap }));
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
      updateCount(m.count);
      for (const p of m.players) addRemote(p);
      // destroyed map blocks first, then player-built blocks (a built block may occupy a destroyed spot)
      for (const d of m.destroyed || []) removeBlockLocal(d.x, d.y, d.z, true);
      for (const b of m.placed) placeBlockLocal(b.x, b.y, b.z, b.team);
      if (gameMode === 'ctf') { ensureFlags(); if (m.flags) updateFlagMeshes(m.flags); }
      if (gameMode === 'gg') { myLevel = 0; }
      startGame();
      setGunGameUI(gameMode === 'gg');
      if (gameMode === 'gg') applyGunGameWeapon();
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
    case 'flag': {
      const tn = m.team === 'red' ? 'Red' : 'Blue';
      if (m.ev === 'pickup') { feed(`${m.name || 'Someone'} grabbed the ${tn} flag!`, m.team); SND.spawn(); }
      else if (m.ev === 'capture') { feed(`${m.name || 'Someone'} captured the ${tn} flag! 🚩`, m.team); SND.kill(); announce('FLAG CAPTURED!', '#ffd24a'); }
      else if (m.ev === 'returned') { feed(`The ${tn} flag was returned.`, m.team); }
      else if (m.ev === 'drop') { feed(`The ${tn} flag was dropped!`, m.team); }
      break;
    }
    case 'states':
      dbgOnStates(m);
      if (m.flags) updateFlagMeshes(m.flags);
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
        spawnTracer(from, dir, m.w);
        SND.shot(m.w, Math.max(0.02, 0.25 * Math.min(1, 14 / (dist + 1))));
      }
      if (r) r.shootAnim = 0.12;
      break;
    }
    case 'hp': {
      me.hp = m.hp;
      updateHearts();
      SND.hurt();
      const v = $('dmgVignette');
      v.style.opacity = 1; setTimeout(() => v.style.opacity = 0, 120);
      break;
    }
    case 'heal': {
      if (!me.dead) { me.hp = m.hp; updateHearts(); } // passive regen — no hurt fx
      if (m.streak) { announce(`${m.streak} KILL STREAK — HEALED!`); SND.spawn(); }
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
      feed(`${kName} ${m.head ? '[headshot] ' : ''}► ${vName}`, kTeam, vTeam);
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
        me.hp = 0; me.dead = true; me.deaths++;
        killStreak = 0; multiKill = 0;
        updateHearts();
        SND.death();
        showDeathScreen(kName);
      }
      if (m.killer === myId && m.victim !== myId) { me.kills++; SND.kill(); onMyKill(); }
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
        me.hp = 100; me.dead = false;
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
      addChatMessage(m.name, m.team, m.text);
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
      hideMatchOver();
      resetWorld();
      if (gameMode === 'gg') { myLevel = 0; applyGunGameWeapon(); }
      feed(gameMode === 'ctf' ? `New match — capture ${scoreLimit} flags to win!`
         : gameMode === 'gg' ? `New match — work through all ${scoreLimit} weapons to win!`
         : `New match — first to ${scoreLimit} kills wins!`, myTeam);
      break;
  }
}

// ---- player count / match banners / kill streak (HUD helpers) ----
function updateCount(n) {
  if (typeof n !== 'number') return;
  const el = $('playerCount');
  if (el) el.textContent = '◉ ' + n;
}
function showMatchOver(winner, sc, winnerName) {
  if (sc) { Object.assign(scores, sc); $('scoreRed').textContent = scores.red; $('scoreBlue').textContent = scores.blue; }
  const o = $('matchOver');
  if (gameMode === 'gg') {
    const win = (winnerName && winnerName === myName);
    awardCoins(win ? 120 : 40);
    $('matchOverTitle').textContent = (winnerName || 'SOMEONE') + ' WINS!';
    $('matchOverTitle').style.color = win ? '#ffd24a' : (TEAM_COL[winner] || '#fff');
    $('matchOverSub').textContent = (win ? 'You mastered every weapon! ' : 'Beaten to the last weapon. ') + 'Next match starting...';
    o.style.display = 'flex';
    return;
  }
  const win = (winner === myTeam);
  awardCoins(win ? 120 : 40);
  $('matchOverTitle').textContent = (winner === 'red' ? 'RED' : 'BLUE') + ' TEAM WINS';
  $('matchOverTitle').style.color = TEAM_COL[winner] || '#fff';
  $('matchOverSub').textContent = (win ? 'Victory! ' : 'Defeat. ') + `${scores.red} : ${scores.blue}  —  next match starting...`;
  o.style.display = 'flex';
}
function hideMatchOver() { const o = $('matchOver'); if (o) o.style.display = 'none'; }
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
  multiKill = (now - lastKillTime < MULTI_WINDOW) ? multiKill + 1 : 1;
  lastKillTime = now;
  let msg = null, col = '#ff7733';
  if (multiKill >= 2) { msg = MULTI_NAMES[Math.min(multiKill, 5)]; col = '#ff5533'; }
  if (SPREE_NAMES[killStreak]) { msg = SPREE_NAMES[killStreak]; col = '#ffd24a'; } // spree milestone wins
  if (msg) announce(msg, col);
  awardCoins(10); // coins toward unlocking classes
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
function buildWorld() {
  const blocks = buildMapBlocks();
  const byType = {};
  for (const b of blocks) {
    (byType[b.type] ||= []).push(b);
    collision.add(`${b.x},${b.y},${b.z}`);
  }
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const m4 = new THREE.Matrix4();
  for (const [type, list] of Object.entries(byType)) {
    const mesh = new THREE.InstancedMesh(geo, mats[type], list.length);
    list.forEach((b, i) => {
      m4.makeTranslation(b.x + 0.5, b.y + 0.5, b.z + 0.5);
      mesh.setMatrixAt(i, m4);
      mapBlockIndex.set(`${b.x},${b.y},${b.z}`, { mesh, i });
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
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
    g.position.set(f.x, f.y - 0.5, f.z); // server y is base + 0.5; sit the group on the ground
    g.userData.cloth.rotation.y = wobble;
    g.visible = true;
  }
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

function makeNameSprite(name, team) {
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  g.font = '28px monospace';
  const w = Math.max(64, g.measureText(name).width + 24);
  c.width = w; c.height = 44;
  const g2 = c.getContext('2d');
  g2.fillStyle = 'rgba(0,0,0,0.45)'; g2.fillRect(0, 0, w, 44);
  g2.font = 'bold 28px monospace';
  g2.fillStyle = TEAM_COL[team];
  g2.textAlign = 'center'; g2.textBaseline = 'middle';
  g2.fillText(name, w / 2, 23);
  const t = new THREE.CanvasTexture(c);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t }));
  sp.scale.set(w / 70, 0.62, 1);
  sp.position.y = 2.45;
  return sp;
}

function makeCharacter(team, name, agentId) {
  const group = new THREE.Group();
  const accentCol = AGENTS[agentId]?.accent ?? 0x9aa4b2;
  const skin = new THREE.MeshLambertMaterial({ color: 0xd8a37a });
  const jersey = new THREE.MeshLambertMaterial({ color: team === 'red' ? 0xb03430 : 0x3a4fb4 });
  const pants = new THREE.MeshLambertMaterial({ color: 0x33343c });
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

  // agent accent: helmet on top of the head
  const helmet = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.18, 0.56), new THREE.MeshLambertMaterial({ color: accentCol }));
  helmet.position.y = 1.92;

  [head, body, armL, armR, legL, legR, gun, helmet].forEach(o => { o.castShadow = true; group.add(o); });
  group.add(makeNameSprite(name, team));
  group.userData = { head, armL, armR, legL, legR, gun };
  return group;
}

function addRemote(p) {
  if (remotes.has(p.id)) return;
  const group = makeCharacter(p.team, p.name, p.agent);
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
    startReload();
    return;
  }

  const spread = w.spread * (me.zoomed ? 0.25 : 1) * (me.onGround ? 1 : 1.8);

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
      bloodBurst(new THREE.Vector3(origin.x + dir.x * bestT, hitY, origin.z + dir.z * bestT));
    } else if (blockHit) {
      debrisBurst(new THREE.Vector3(origin.x + dir.x * blockHit.dist, origin.y + dir.y * blockHit.dist, origin.z + dir.z * blockHit.dist));
    }
    spawnTracer(origin, dir, wkey, bestT);
  }

  SND.shot(wkey);
  netSend({ t: 'shoot', from: { x: origin.x, y: origin.y, z: origin.z }, dir: { x: baseDir.x, y: baseDir.y, z: baseDir.z }, w: wkey });
  // recoil
  me.rx += w.pellets > 1 ? 0.03 : (wkey === 'sniper' ? 0.04 : 0.012);
  vm.recoil = 1;
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
    bloodBurst(new THREE.Vector3(origin.x + dir.x * bestT, origin.y + dir.y * bestT, origin.z + dir.z * bestT));
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
function spawnTracer(origin, dir, wkey, dist) {
  const len = dist !== undefined ? dist : (raycastVoxels(origin, dir, 100)?.dist ?? 100);
  const end = origin.clone().addScaledVector(dir, len);
  const start = origin.clone().addScaledVector(dir, 0.8).add(new THREE.Vector3(0, -0.12, 0));
  const g = new THREE.BufferGeometry().setFromPoints([start, end]);
  const m = new THREE.LineBasicMaterial({
    color: wkey === 'sniper' ? 0xaadfff : 0xffd080,
    transparent: true, opacity: 0.85,
  });
  const line = new THREE.Line(g, m);
  scene.add(line);
  tracers.push({ obj: line, ttl: 0.09 });
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
  const nh = $('nadeHud'); if (nh) nh.innerHTML = `🧨 x${me.nades} <span style="color:#888">[G]</span>`;
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
        if (text) netSend({ t: 'chat', text });
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
      $('teamBanner').style.display = 'none';
    }
    if (!locked) { mouseDown = false; Object.keys(keys).forEach(k => keys[k] = false); }
  });
  $('resumeBtn').addEventListener('click', () => canvas.requestPointerLock());
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

  camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.08, 300);
  scene.add(camera);

  renderer = new THREE.WebGLRenderer({ canvas: $('game'), antialias: false });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  ambLight = new THREE.AmbientLight(0xffffff, 0.75);
  scene.add(ambLight);
  const sun = new THREE.DirectionalLight(0xfff4d6, 1.6);
  sunLight = sun;
  sun.position.set(40, 70, 25);
  sun.castShadow = true;
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
    updateFx(dt);
    updateViewModel(dt, moving > 0);
    if (tabHeld) updateScoreboard();
    if (now - lastMini > 90) { lastMini = now; drawMinimap(); }
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
