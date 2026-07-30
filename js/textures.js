import * as THREE from 'three';

// Seeded RNG so every client renders identical textures
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(draw) {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 16;
  draw(c.getContext('2d'));
  return c;
}

function toTexture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// fill 16x16 with noisy variations of base palette
function noisy(g, palette, seed) {
  const r = rng(seed);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      g.fillStyle = palette[Math.floor(r() * palette.length)];
      g.fillRect(x, y, 1, 1);
    }
  }
}

const GRASS = ['#5d9c3a', '#549135', '#67a83f', '#4f8a31'];
const DIRT = ['#79553a', '#6e4c33', '#82603f', '#65462f'];
const STONE = ['#7f7f7f', '#747474', '#8a8a8a', '#6f6f6f'];

export function buildTextures() {
  const tex = {};

  tex.grassTop = toTexture(makeCanvas(g => noisy(g, GRASS, 1)));
  tex.dirt = toTexture(makeCanvas(g => noisy(g, DIRT, 2)));
  tex.grassSide = toTexture(makeCanvas(g => {
    noisy(g, DIRT, 3);
    const r = rng(4);
    for (let x = 0; x < 16; x++) {
      const h = 2 + Math.floor(r() * 3);
      for (let y = 0; y < h; y++) {
        g.fillStyle = GRASS[Math.floor(r() * GRASS.length)];
        g.fillRect(x, y, 1, 1);
      }
    }
  }));
  tex.stone = toTexture(makeCanvas(g => noisy(g, STONE, 5)));
  tex.cobble = toTexture(makeCanvas(g => {
    noisy(g, ['#828282', '#6b6b6b', '#909090', '#5e5e5e'], 6);
    g.fillStyle = '#4a4a4a';
    [[0, 5], [5, 0], [10, 6], [3, 11], [12, 12], [8, 9]].forEach(([x, y]) => {
      g.fillRect(x, y, 5, 1); g.fillRect(x, y, 1, 5);
    });
  }));
  tex.planks = toTexture(makeCanvas(g => {
    noisy(g, ['#a8824e', '#9c7845', '#b08a55', '#93713f'], 7);
    g.fillStyle = '#6e5530';
    for (let y = 3; y < 16; y += 4) g.fillRect(0, y, 16, 1);
    g.fillRect(4, 0, 1, 4); g.fillRect(11, 4, 1, 4); g.fillRect(2, 8, 1, 4); g.fillRect(13, 12, 1, 4);
  }));
  tex.bricks = toTexture(makeCanvas(g => {
    noisy(g, ['#9c5a4b', '#925043', '#a8645a', '#8a4a3d'], 8);
    g.fillStyle = '#d3c5b5';
    for (let y = 0; y < 16; y += 4) g.fillRect(0, y + 3, 16, 1);
    for (let row = 0; row < 4; row++)
      for (let x = (row % 2 ? 0 : 4); x < 16; x += 8)
        g.fillRect(x, row * 4, 1, 3);
  }));
  tex.sand = toTexture(makeCanvas(g => noisy(g, ['#d9cf9e', '#d1c694', '#e0d6a8', '#c9bd88'], 9)));
  tex.bedrock = toTexture(makeCanvas(g => noisy(g, ['#4c4c4c', '#3a3a3a', '#5c5c5c', '#2e2e2e'], 10)));
  tex.log = toTexture(makeCanvas(g => {
    noisy(g, ['#6b522e', '#5e4827', '#766036'], 11);
    g.fillStyle = '#473418';
    g.fillRect(2, 0, 1, 16); g.fillRect(6, 0, 1, 16); g.fillRect(10, 0, 1, 16); g.fillRect(14, 0, 1, 16);
  }));
  tex.leaves = toTexture(makeCanvas(g => noisy(g, ['#3f7e26', '#356c1f', '#48902c', '#2d5e1a'], 12)));
  tex.redWool = toTexture(makeCanvas(g => noisy(g, ['#b03430', '#a32e2a', '#bd3d38', '#962824'], 13)));
  tex.blueWool = toTexture(makeCanvas(g => noisy(g, ['#3a4fb4', '#3448a6', '#4458c2', '#2e4096'], 14)));
  tex.gravel = toTexture(makeCanvas(g => noisy(g, ['#857f7a', '#76716c', '#948d87', '#6a655f'], 15)));

  return tex;
}

function mat(t) { return new THREE.MeshLambertMaterial({ map: t }); }

// material (or material array) for each logical block type
export function buildMaterials(tex) {
  const grass = [
    mat(tex.grassSide), mat(tex.grassSide),
    mat(tex.grassTop), mat(tex.dirt),
    mat(tex.grassSide), mat(tex.grassSide),
  ];
  return {
    grass,
    dirt: mat(tex.dirt),
    stone: mat(tex.stone),
    cobble: mat(tex.cobble),
    planks: mat(tex.planks),
    bricks: mat(tex.bricks),
    sand: mat(tex.sand),
    bedrock: mat(tex.bedrock),
    log: mat(tex.log),
    leaves: mat(tex.leaves),
    redWool: mat(tex.redWool),
    blueWool: mat(tex.blueWool),
    gravel: mat(tex.gravel),
  };
}
