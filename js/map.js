// Deterministic arena layout shared by all clients.
// A block at integer (x,y,z) occupies [x,x+1]x[y,y+1]x[z,z+1].
//
// MAP: "DESERT TEMPLE" — desert temple arena.
// Center: hollow step-pyramid with a drop shaft and ground-level corridors.
// Around it: stone ring road, ruined colonnade, N/S watchtowers,
// palm oases in the corners, scattered ruins and dunes.

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

export function buildMapBlocks() {
  const m = new Map(); // "x,y,z" -> {x,y,z,type}; later writes win
  const set = (x, y, z, type) => m.set(`${x},${y},${z}`, { x, y, z, type });
  const del = (x, y, z) => m.delete(`${x},${y},${z}`);
  const box = (x0, y0, z0, x1, y1, z1, type) => {
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        for (let z = z0; z <= z1; z++) set(x, y, z, type);
  };
  const carve = (x0, y0, z0, x1, y1, z1) => {
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        for (let z = z0; z <= z1; z++) del(x, y, z);
  };

  const r = seededRng(4242);

  // --- ground: desert sand with speckles ---
  for (let x = -HALF; x < HALF; x++) {
    for (let z = -HALF; z < HALF; z++) {
      let t = 'sand';
      const v = r();
      if (v < 0.05) t = 'gravel';
      else if (v < 0.07) t = 'dirt';
      set(x, 0, z, t);
    }
  }

  // --- stone ring road around the temple + gravel lanes to spawns ---
  for (let x = -HALF; x < HALF; x++) {
    for (let z = -HALF; z < HALF; z++) {
      const d = Math.hypot(x + 0.5, z + 0.5);
      if (d >= 11 && d <= 12.8) set(x, 0, z, 'stone');
    }
  }
  for (let x = 13; x <= 25; x++) for (let z = -1; z <= 1; z++) {
    set(x, 0, z, 'gravel'); set(-x - 1, 0, z, 'gravel');
  }
  for (let z = 13; z <= 27; z++) for (let x = -1; x <= 1; x++) {
    set(x, 0, z, 'gravel'); set(x, 0, -z - 1, 'gravel');
  }

  // --- border walls (bedrock, 5 high) ---
  for (let i = -HALF - 1; i <= HALF; i++) {
    for (let y = 0; y <= 5; y++) {
      set(i, y, -HALF - 1, 'bedrock');
      set(i, y, HALF, 'bedrock');
      set(-HALF - 1, y, i, 'bedrock');
      set(HALF, y, i, 'bedrock');
    }
  }

  // --- central step pyramid (climbable from all sides) ---
  for (let y = 1; y <= 5; y++) {
    const B = 8 - y; // 15x15 at the base, 7x7 on top
    for (let x = -B; x <= B; x++)
      for (let z = -B; z <= B; z++)
        set(x, y, z, y === 1 ? 'cobble' : (r() < 0.22 ? 'cobble' : 'sand'));
  }
  // inner treasure chamber
  carve(-3, 1, -3, 3, 3, 3);
  // ground-level corridors through the pyramid (E-W and N-S)
  carve(-7, 1, -1, 7, 2, 1);
  carve(-1, 1, -7, 1, 2, 7);
  // drop shaft from the roof straight into the chamber (one-way!)
  carve(0, 1, 0, 0, 5, 0);
  // roof merlons
  [[-3, -3], [-3, 3], [3, -3], [3, 3], [0, 3], [0, -3], [3, 0], [-3, 0]]
    .forEach(([x, z]) => { if (x || z) set(x, 6, z, 'cobble'); });
  // gold-ish "treasure" in the chamber (planks crates + glow of red/blue wool)
  set(-2, 1, -2, 'planks'); set(2, 1, 2, 'planks'); set(2, 2, 2, 'planks');
  set(-2, 1, 2, 'redWool'); set(2, 1, -2, 'blueWool');

  // --- ruined colonnade along the ring road ---
  const pillars = [ // [x, z, height], x>0 mirrored to -x-1
    [11, 4, 4], [11, -5, 3], [8, 9, 4], [8, -10, 2], [4, 11, 3], [4, -12, 4],
  ];
  pillars.forEach(([px, pz, h]) => {
    [[px, pz], [-px - 1, pz]].forEach(([x, z]) => {
      box(x, 1, z, x, h, z, 'cobble');
      if (h >= 4) set(x, h + 1, z, 'leaves'); // overgrown top
    });
  });

  // --- watchtowers north & south (neutral, equidistant) ---
  [[0, 18], [0, -19]].forEach(([tx, tz]) => {
    const sz = tz > 0 ? 1 : -1;
    box(tx - 1, 1, tz - 1, tx + 1, 4, tz + 1, 'bricks');
    box(tx - 2, 5, tz - 2, tx + 2, 5, tz + 2, 'planks');
    // climbing steps on the far side
    box(tx, 1, tz + 3 * sz, tx, 1, tz + 3 * sz, 'cobble');
    box(tx, 1, tz + 2 * sz, tx, 2, tz + 2 * sz, 'cobble');
    box(tx - 1, 1, tz + 2 * sz, tx - 1, 3, tz + 2 * sz, 'cobble');
    box(tx - 1, 1, tz + 1 * sz, tx - 1, 4, tz + 1 * sz, 'cobble');
  });

  // --- palm oases in the four corners ---
  [[19, 20], [19, -21], [-20, 20], [-20, -21]].forEach(([ox, oz]) => {
    for (let dx = -3; dx <= 3; dx++)
      for (let dz = -3; dz <= 3; dz++)
        if (dx * dx + dz * dz <= 9 && r() < 0.85) set(ox + dx, 0, oz + dz, 'grass');
    const palm = (px, pz, h) => {
      box(px, 1, pz, px, h, pz, 'log');
      set(px + 1, h + 1, pz, 'leaves'); set(px - 1, h + 1, pz, 'leaves');
      set(px, h + 1, pz + 1, 'leaves'); set(px, h + 1, pz - 1, 'leaves');
      set(px, h + 2, pz, 'leaves');
    };
    palm(ox, oz, 4);
    palm(ox + 2, oz - 2, 3);
    set(ox - 2, 1, oz + 1, 'leaves'); // bush
    set(ox + 1, 1, oz + 2, 'leaves');
  });

  // --- broken ruin walls mid-field (mirrored across x for fairness) ---
  for (let i = 0; i < 9; i++) {
    const cx = 6 + Math.floor(r() * 14);
    const cz = Math.floor(r() * 52) - 26;
    const len = 3 + Math.floor(r() * 3);
    const alongX = r() < 0.5;
    if (cx <= 9 && Math.abs(cz) <= 9) continue;        // keep pyramid clear
    if (Math.abs(cz) >= 13 && Math.abs(cz) <= 16) continue; // keep spawn shelters clear
    const heights = Array.from({ length: len }, () => 1 + Math.floor(r() * 3));
    heights.forEach((h, j) => {
      const bx = alongX ? cx + j : cx;
      const bz = alongX ? cz : cz + j;
      if (Math.abs(bx) > 24 || Math.abs(bz) > 29) return;
      box(bx, 1, bz, bx, h, bz, 'bricks');
      box(-bx - 1, 1, bz, -bx - 1, h, bz, 'bricks');
    });
  }

  // --- low dunes for cover (mirrored) ---
  for (let i = 0; i < 12; i++) {
    const cx = 5 + Math.floor(r() * 18);
    const cz = Math.floor(r() * 54) - 27;
    if (Math.hypot(cx, cz) < 11) continue;
    box(cx, 1, cz, cx + 1, 1, cz + 1, 'sand');
    box(-cx - 2, 1, cz, -cx - 1, 1, cz + 1, 'sand');
  }

  // --- team spawn zones ---
  // wool pads (ground recolor)
  for (let z = -12; z <= 12; z++) {
    for (let x = 26; x <= 30; x++) {
      set(-x, 0, z, 'redWool');
      set(x, 0, z, 'blueWool');
    }
  }
  // defensive wall in front of each spawn with firing gaps
  for (let z = -9; z <= 9; z++) {
    if ((z + 9) % 4 === 3) continue; // gap
    box(-24, 1, z, -24, 2, z, 'redWool');
    box(23, 1, z, 23, 2, z, 'blueWool');
  }
  // side shelters
  [[-28, 'redWool'], [27, 'blueWool']].forEach(([bx, wool]) => {
    box(bx - 2, 1, -16, bx + 2, 3, -16, wool);
    box(bx - 2, 1, 16, bx + 2, 3, 16, wool);
  });

  return [...m.values()];
}
