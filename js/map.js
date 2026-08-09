// Deterministic arena layouts shared by all clients AND the server.
// A block at integer (x,y,z) occupies [x,x+1]x[y,y+1]x[z,z+1].
//
// buildMapBlocks(mapId) returns a DIFFERENT layout per map id (distinct central
// structures, cover and block palettes) — not just a recolor. The ground, border
// walls and team spawn zones are shared across all maps for fair, consistent
// spawns/flags. Client and server call this with the same id so geometry matches.

export const HALF = 32; // playable area: x,z in [-32, 31]

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

// Per-map ground base + which block palette the structures favour.
const MAP_STYLE = {
  desert:  { ground: 'sand',  speckle: ['gravel', 'dirt'],  pillar: 'cobble', wall: 'bricks', roof: 'planks' },
  arctic:  { ground: 'sand',  speckle: ['stone', 'cobble'], pillar: 'stone',  wall: 'stone',  roof: 'planks' },
  volcano: { ground: 'gravel', speckle: ['stone', 'cobble'], pillar: 'cobble', wall: 'cobble', roof: 'gravel' },
  night:   { ground: 'stone', speckle: ['cobble', 'gravel'], pillar: 'bricks', wall: 'bricks', roof: 'planks' },
  metro:   { ground: 'stone', speckle: ['cobble', 'gravel'], pillar: 'stone',  wall: 'cobble', roof: 'planks' },
  toxic:   { ground: 'grass', speckle: ['dirt', 'leaves'],  pillar: 'log',    wall: 'stone',  roof: 'leaves' },
};

export function buildMapBlocks(mapId = 'desert') {
  const style = MAP_STYLE[mapId] || MAP_STYLE.desert;
  const m = new Map();
  const set = (x, y, z, type) => m.set(`${x},${y},${z}`, { x, y, z, type });
  const del = (x, y, z) => m.delete(`${x},${y},${z}`);
  const box = (x0, y0, z0, x1, y1, z1, type) => {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) set(x, y, z, type);
  };
  const carve = (x0, y0, z0, x1, y1, z1) => {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) del(x, y, z);
  };
  const r = seededRng(mapSeed(mapId));

  // --- ground (per-map base with a few speckles) ---
  for (let x = -HALF; x < HALF; x++) for (let z = -HALF; z < HALF; z++) {
    let t = style.ground; const v = r();
    if (v < 0.05) t = style.speckle[0]; else if (v < 0.07) t = style.speckle[1];
    set(x, 0, z, t);
  }

  // --- border walls (bedrock, 5 high) — shared ---
  for (let i = -HALF - 1; i <= HALF; i++) for (let y = 0; y <= 5; y++) {
    set(i, y, -HALF - 1, 'bedrock'); set(i, y, HALF, 'bedrock');
    set(-HALF - 1, y, i, 'bedrock'); set(HALF, y, i, 'bedrock');
  }

  // --- the distinctive centre + cover, per map ---
  buildCentre(mapId, style, r, { set, del, box, carve });

  // --- team spawn zones (identical on every map for fairness) ---
  for (let z = -12; z <= 12; z++) for (let x = 26; x <= 30; x++) { set(-x, 0, z, 'redWool'); set(x, 0, z, 'blueWool'); }
  for (let z = -9; z <= 9; z++) { if ((z + 9) % 4 === 3) continue; box(-24, 1, z, -24, 2, z, 'redWool'); box(23, 1, z, 23, 2, z, 'blueWool'); }
  [[-28, 'redWool'], [27, 'blueWool']].forEach(([bx, wool]) => { box(bx - 2, 1, -16, bx + 2, 3, -16, wool); box(bx - 2, 1, 16, bx + 2, 3, 16, wool); });

  return [...m.values()];
}

// Scatter mirrored cover walls across mid-field (shared helper, seeded per map).
function scatterCover(r, style, box, count, maxH) {
  for (let i = 0; i < count; i++) {
    const cx = 6 + Math.floor(r() * 14);
    const cz = Math.floor(r() * 52) - 26;
    const len = 2 + Math.floor(r() * 3);
    const alongX = r() < 0.5;
    if (cx <= 9 && Math.abs(cz) <= 9) continue;
    if (Math.abs(cz) >= 13 && Math.abs(cz) <= 16) continue;
    for (let j = 0; j < len; j++) {
      const h = 1 + Math.floor(r() * maxH);
      const bx = alongX ? cx + j : cx, bz = alongX ? cz : cz + j;
      if (Math.abs(bx) > 24 || Math.abs(bz) > 29) continue;
      box(bx, 1, bz, bx, h, bz, style.wall);
      box(-bx - 1, 1, bz, -bx - 1, h, bz, style.wall);
    }
  }
}

function buildCentre(mapId, style, r, h) {
  const { set, box, carve } = h;
  if (mapId === 'desert') {
    // step pyramid with inner chamber + corridors + drop shaft
    for (let y = 1; y <= 5; y++) { const B = 8 - y; for (let x = -B; x <= B; x++) for (let z = -B; z <= B; z++) set(x, y, z, y === 1 ? 'cobble' : (r() < 0.22 ? 'cobble' : 'sand')); }
    carve(-3, 1, -3, 3, 3, 3); carve(-7, 1, -1, 7, 2, 1); carve(-1, 1, -7, 1, 2, 7); carve(0, 1, 0, 0, 5, 0);
    [[-3, -3], [-3, 3], [3, -3], [3, 3], [0, 3], [0, -3], [3, 0], [-3, 0]].forEach(([x, z]) => { if (x || z) set(x, 6, z, 'cobble'); });
    set(-2, 1, 2, 'redWool'); set(2, 1, -2, 'blueWool');
    [[11, 4, 4], [8, 9, 4], [4, 11, 3]].forEach(([px, pz, ph]) => [[px, pz], [-px - 1, pz]].forEach(([x, z]) => { box(x, 1, z, x, ph, z, style.pillar); set(x, ph + 1, z, 'leaves'); }));
    scatterCover(r, style, box, 8, 3);
  } else if (mapId === 'arctic') {
    // central hollow keep with 4 corner towers + battlements
    box(-7, 1, -7, 7, 4, 7, style.wall); carve(-6, 1, -6, 6, 4, 6);
    carve(-7, 1, -1, 7, 2, 1); carve(-1, 1, -7, 1, 2, 7); // gates
    [[-7, -7], [7, -7], [-7, 7], [7, 7]].forEach(([x, z]) => box(x < 0 ? x - 1 : x, 1, z < 0 ? z - 1 : z, x < 0 ? x : x + 1, 6, z < 0 ? z : z + 1, style.pillar));
    for (let x = -7; x <= 7; x += 2) { set(x, 5, -7, style.roof); set(x, 5, 7, style.roof); }
    for (let z = -7; z <= 7; z += 2) { set(-7, 5, z, style.roof); set(7, 5, z, style.roof); }
    set(0, 1, 0, 'redWool'); set(1, 1, 0, 'blueWool');
    scatterCover(r, style, box, 10, 3);
  } else if (mapId === 'volcano') {
    // stepped cone with a glowing core + rock spires
    for (let y = 1; y <= 6; y++) { const B = 9 - y; for (let x = -B; x <= B; x++) for (let z = -B; z <= B; z++) if (Math.hypot(x, z) <= B + 0.3) set(x, y, z, r() < 0.3 ? 'gravel' : 'cobble'); }
    carve(-1, 4, -1, 1, 6, 1); box(-1, 4, -1, 1, 4, 1, 'redWool'); set(0, 5, 0, 'redWool');
    [[12, 6], [7, 12], [14, -8], [-9, 10]].forEach(([px, pz]) => { const ph = 2 + Math.floor(r() * 4); box(px, 1, pz, px, ph, pz, style.pillar); box(-px - 1, 1, pz, -px - 1, ph, pz, style.pillar); });
    scatterCover(r, style, box, 9, 2);
  } else if (mapId === 'night') {
    // a ruined city block: several buildings of different heights with alleys
    const bld = (x, z, w, d, ht) => { box(x, 1, z, x + w, ht, z + d, style.wall); carve(x + 1, 1, z + 1, x + w - 1, ht - 1, z + d - 1); box(x, ht + 1, z, x + w, ht + 1, z + d, style.roof); };
    [[-9, -9, 6, 6, 6], [3, -10, 5, 5, 8], [-10, 3, 5, 6, 5], [4, 4, 6, 6, 7]].forEach(([x, z, w, d, ht]) => bld(x, z, w, d, ht));
    scatterCover(r, style, box, 12, 3);
  } else if (mapId === 'metro') {
    // urban grid of containers forming lanes + a central overpass
    for (let gx = -12; gx <= 8; gx += 8) for (let gz = -12; gz <= 8; gz += 8) {
      if (Math.abs(gx + 2) <= 3 && Math.abs(gz + 2) <= 3) continue;
      const ht = 2 + Math.floor(r() * 2);
      box(gx, 1, gz, gx + 4, ht, gz + 3, r() < 0.5 ? style.wall : style.pillar);
    }
    box(-9, 4, -1, 9, 4, 1, style.roof); box(-9, 1, -1, -9, 4, 1, style.pillar); box(9, 1, -1, 9, 4, 1, style.pillar); // overpass
    scatterCover(r, style, box, 10, 3);
  } else { // toxic (and any fallback)
    // organic mounds + a central hill with dead trees
    for (let y = 1; y <= 4; y++) { const B = 6 - y; for (let x = -B; x <= B; x++) for (let z = -B; z <= B; z++) if (Math.hypot(x, z) <= B + 0.4 && r() < 0.9) set(x, y, z, y >= 3 ? 'leaves' : 'dirt'); }
    const tree = (px, pz, ht) => { box(px, 1, pz, px, ht, pz, 'log'); set(px, ht + 1, pz, 'leaves'); };
    [[10, 8], [8, -11], [-12, 9], [13, -6], [-8, -12]].forEach(([px, pz]) => { tree(px, pz, 2 + Math.floor(r() * 3)); tree(-px - 1, pz, 2 + Math.floor(r() * 3)); });
    for (let i = 0; i < 10; i++) { const cx = 6 + Math.floor(r() * 16), cz = Math.floor(r() * 50) - 25; if (Math.hypot(cx, cz) < 8) continue; box(cx, 1, cz, cx + 1, 1, cz + 1, 'dirt'); box(-cx - 2, 1, cz, -cx - 1, 1, cz + 1, 'dirt'); }
    scatterCover(r, style, box, 7, 2);
  }
}
