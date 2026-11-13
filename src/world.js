import * as THREE from 'three';

/**
 * Procedural sunset-coast diorama environment (world.js).
 *
 * Everything is generated at runtime from Three.js primitives, custom
 * BufferGeometry and canvas textures. No external assets, no addons.
 *
 * Public API (see createEnvironment): group, sunDirection, sunLight, envMap,
 * skyMesh, terrain, terrainMaterial, sandHeight(x,z), ocean, lighthouse,
 * raycastTargets, update(time,delta,state), applySunset(v), applyBrightness(v),
 * setLighthouse(b), setDustEnabled(b), setSprayEnabled(b), setWind(v),
 * addProp(kind,worldPoint), undoProp(), resetProps(), getSandHeight(x,z),
 * dispose().
 *
 * Conventions: Y up. Beach foreground at +Z, ocean at -Z. Bottle near
 * (-0.15, 1.15, 0.10) with axis ~X (base -X), tilt -12.5deg toward the mouth,
 * yaw +7.5deg. Terrain material is a plain MeshStandardMaterial so the Lead
 * can inject a fragment cavity clip through onBeforeCompile.
 */

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

const WATER_Y = -0.15;
const SHORE_Z = -5.2;

const BOTTLE = {
  x: -0.15,
  z: 0.10,
  yaw: 7.5 * DEG,
  cosY: Math.cos(7.5 * DEG),
  sinY: Math.sin(7.5 * DEG),
};

// Sun dominates screen-right of centre as specified by the Lead: world direction
// x = +0.16, y = +0.10 (about 5.7 deg above the horizon), z = -0.98.
const SUN_DIRECTION = new THREE.Vector3(0.16, 0.10, -0.98).normalize();

const FOG_DENSITY = 0.0068;
const SKY_RADIUS = 320;

const QUALITY_PRESETS = {
  fine: {
    terrainSegX: 184,
    oceanSeg: 200,
    skySeg: 44,
    sandTex: 512,
    envTex: 256,
    shadowMap: 2048,
    dust: 420,
    spray: 320,
    pebbles: 300,
  },
  standard: {
    terrainSegX: 160,
    oceanSeg: 160,
    skySeg: 32,
    sandTex: 256,
    envTex: 192,
    shadowMap: 2048,
    dust: 300,
    spray: 220,
    pebbles: 220,
  },
  retro: {
    terrainSegX: 144,
    oceanSeg: 128,
    skySeg: 24,
    sandTex: 128,
    envTex: 128,
    shadowMap: 1024,
    dust: 180,
    spray: 140,
    pebbles: 140,
  },
};

/* ------------------------------------------------------------------ */
/* math / noise / rng helpers                                          */
/* ------------------------------------------------------------------ */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

function hashInt2(x, y) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  return (h >>> 0) / 4294967295;
}

function hashInt3(x, y, z) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (z | 0) * 2147483647;
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  return (h >>> 0) / 4294967295;
}

function valueNoise2(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hashInt2(xi, yi);
  const b = hashInt2(xi + 1, yi);
  const c = hashInt2(xi, yi + 1);
  const d = hashInt2(xi + 1, yi + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

function fbm2(x, y, octaves = 4) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(x * freq, y * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function linearToSrgbByte(v) {
  const c = clamp(v, 0, 1);
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

/* ------------------------------------------------------------------ */
/* geometry helpers                                                    */
/* ------------------------------------------------------------------ */

function asNonIndexed(geo) {
  return geo.index ? geo.toNonIndexed() : geo;
}

/** Merge position/normal(/color) attributes of several non-indexed geometries. */
function mergeGeometries(geos) {
  let total = 0;
  const converted = [];
  let hasColor = false;
  for (let i = 0; i < geos.length; i++) {
    const g = asNonIndexed(geos[i]);
    converted.push(g);
    total += g.attributes.position.count;
    if (g.attributes.color) hasColor = true;
  }
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const col = hasColor ? new Float32Array(total * 3) : null;
  let off = 0;
  for (let i = 0; i < converted.length; i++) {
    const g = converted[i];
    const count = g.attributes.position.count;
    pos.set(g.attributes.position.array, off * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array, off * 3);
    if (hasColor) {
      if (g.attributes.color) {
        col.set(g.attributes.color.array, off * 3);
      } else {
        for (let k = 0; k < count * 3; k++) col[off * 3 + k] = 1;
      }
    }
    off += count;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (hasColor) merged.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return merged;
}

function makeRockGeometry(rng, sx, sy, sz, detail, roughness) {
  const geo = new THREE.IcosahedronGeometry(1, detail);
  const pos = geo.attributes.position;
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const len = Math.hypot(x, y, z) || 1;
    const nx = x / len;
    const ny = y / len;
    const nz = z / len;
    const seed = hashInt3(Math.round(nx * 91), Math.round(ny * 91), Math.round(nz * 91));
    const r = 1 + (seed - 0.5) * roughness;
    p.set(nx * r, ny * r, nz * r);
    if (p.y < -0.18) p.y = -0.18 + (p.y + 0.18) * 0.35;
    pos.setXYZ(i, p.x * sx, p.y * sy, p.z * sz);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

function makeMesaGeometry(rTop, rBottom, h, segs, rng, jitter) {
  const geo = new THREE.CylinderGeometry(rTop, rBottom, h, segs, 2);
  const ni = asNonIndexed(geo);
  const pos = ni.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const seed = hashInt3(Math.round(x * 53), Math.round(y * 53), Math.round(z * 53));
    const flatTop = y > h * 0.499;
    const k = flatTop ? 1 : 1 + (seed - 0.5) * jitter;
    pos.setXYZ(i, x * k, flatTop ? h * 0.5 : y + (seed - 0.5) * jitter * 0.35 * h, z * k);
  }
  pos.needsUpdate = true;
  ni.translate(0, h * 0.5, 0);
  ni.computeVertexNormals();
  return ni;
}

function makeGableRoof(w, d, h) {
  const hw = w * 0.5;
  const hd = d * 0.5;
  const verts = [
    -hw, 0, -hd, 0, h, 0, -hw, 0, hd,
    -hw, 0, hd, 0, h, 0, 0, h, 0,
    hw, 0, hd, 0, h, 0, hw, 0, -hd,
    hw, 0, -hd, 0, h, 0, 0, h, 0,
    -hw, 0, -hd, hw, 0, -hd, 0, h, 0,
    -hw, 0, hd, 0, h, 0, hw, 0, hd,
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.computeVertexNormals();
  return geo;
}

function makeShellGeometry(seed) {
  const rng = mulberry32(seed);
  const segs = 11;
  const positions = [];
  const center = [0, 0.2, 0];
  const midRing = [];
  const outerRing = [];
  for (let i = 0; i <= segs; i++) {
    const a = -1.1 + (2.2 * i) / segs;
    const ridge = 0.5 + 0.5 * Math.cos(i * 2.3);
    const outerR = 1.0 + (rng() - 0.5) * 0.07;
    outerRing.push([Math.sin(a) * outerR, 0.015 + 0.05 * ridge, Math.cos(a) * outerR]);
    midRing.push([Math.sin(a) * 0.56, 0.13 + 0.09 * ridge, Math.cos(a) * 0.56]);
  }
  for (let i = 0; i < segs; i++) {
    const m0 = midRing[i];
    const m1 = midRing[i + 1];
    const o0 = outerRing[i];
    const o1 = outerRing[i + 1];
    positions.push(center[0], center[1], center[2], m0[0], m0[1], m0[2], m1[0], m1[1], m1[2]);
    positions.push(m0[0], m0[1], m0[2], o0[0], o0[1], o0[2], m1[0], m1[1], m1[2]);
    positions.push(m1[0], m1[1], m1[2], o0[0], o0[1], o0[2], o1[0], o1[1], o1[2]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

function makeSeaweedGeometry(seed) {
  const rng = mulberry32(seed);
  const positions = [];
  const blades = 4;
  for (let b = 0; b < blades; b++) {
    const a = rng() * TAU;
    const bx = Math.cos(a) * rng() * 0.12;
    const bz = Math.sin(a) * rng() * 0.12;
    const h = 0.55 + rng() * 0.55;
    const leanX = Math.cos(a) * (0.25 + rng() * 0.4);
    const leanZ = Math.sin(a) * (0.25 + rng() * 0.4);
    const w = 0.06 + rng() * 0.05;
    const mid = [bx + leanX * 0.35, h * 0.55, bz + leanZ * 0.35];
    const tip = [bx + leanX, h, bz + leanZ];
    positions.push(bx - w, 0, bz, mid[0] + w * 0.55, mid[1], mid[2] + w * 0.4, mid[0] - w * 0.55, mid[1], mid[2] - w * 0.4);
    positions.push(mid[0] + w * 0.55, mid[1], mid[2] + w * 0.4, tip[0], tip[1], tip[2], mid[0] - w * 0.55, mid[1], mid[2] - w * 0.4);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

function makeDriftwoodGeometry(rng) {
  const geos = [];
  const log = new THREE.CylinderGeometry(0.055, 0.075, 1.25, 5, 3);
  log.rotateZ(Math.PI * 0.5);
  log.translate(0.1, 0.07, 0);
  geos.push(log);
  const branch = new THREE.CylinderGeometry(0.022, 0.04, 0.55, 4, 2);
  branch.rotateZ(Math.PI * 0.34);
  branch.translate(0.28, 0.14, 0.08);
  geos.push(branch);
  const branch2 = new THREE.CylinderGeometry(0.018, 0.032, 0.4, 4, 2);
  branch2.rotateZ(-Math.PI * 0.4);
  branch2.rotateY(0.9);
  branch2.translate(-0.33, 0.12, -0.05);
  geos.push(branch2);
  const merged = mergeGeometries(geos);
  const count = merged.attributes.position.count;
  const col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const v = 0.55 + hashInt3(i, 7, 3) * 0.25;
    col[i * 3] = v * 1.08;
    col[i * 3 + 1] = v * 0.92;
    col[i * 3 + 2] = v * 0.78;
  }
  merged.setAttribute('color', new THREE.BufferAttribute(col, 3));
  merged.computeVertexNormals();
  return merged;
}

/* ------------------------------------------------------------------ */
/* canvas texture builders                                             */
/* ------------------------------------------------------------------ */

function buildSandTextures(size) {
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      let h = 0;
      h += 0.55 * Math.sin((u * 3 + v * 5) * TAU + 1.2);
      h += 0.35 * Math.sin((u * 7 - v * 4) * TAU + 2.4);
      h += 0.22 * Math.sin((u * 13 + v * 11) * TAU + 0.7);
      h += 0.14 * Math.sin((u * 2 - v * 9) * TAU + 3.1);
      h += 0.10 * Math.sin((u * 29 + v * 17) * TAU + 1.9);
      h += 0.45 * Math.sin((u * 1 + v * 9) * TAU + 0.8 * Math.sin((u * 3 + v * 2) * TAU));
      height[y * size + x] = h;
    }
  }

  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = colorCanvas.height = size;
  const cctx = colorCanvas.getContext('2d');
  const colorImg = cctx.createImageData(size, size);
  const cd = colorImg.data;

  const normalCanvas = document.createElement('canvas');
  normalCanvas.width = normalCanvas.height = size;
  const nctx = normalCanvas.getContext('2d');
  const normalImg = nctx.createImageData(size, size);
  const nd = normalImg.data;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const h = height[i];
      const grain = valueNoise2(x * 0.61 + 11.3, y * 0.61 + 4.7);
      const speck = hashInt2(x, y);
      const brightness = 0.995 + 0.02 * h + 0.025 * (grain - 0.5);
      let r = 255 * brightness;
      let g = 249 * brightness;
      let b = 238 * brightness;
      if (speck > 0.99) {
        r *= 0.58;
        g *= 0.57;
        b *= 0.55;
      } else if (speck > 0.978) {
        r *= 0.78;
        g *= 0.8;
        b *= 0.84;
      }
      cd[i * 4] = clamp(r, 0, 255);
      cd[i * 4 + 1] = clamp(g, 0, 255);
      cd[i * 4 + 2] = clamp(b, 0, 255);
      cd[i * 4 + 3] = 255;

      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const ym = (y - 1 + size) % size;
      const yp = (y + 1) % size;
      const dx = (height[y * size + xp] - height[y * size + xm]) * 0.55;
      const dy = (height[yp * size + x] - height[ym * size + x]) * 0.55;
      let nx = -dx * 1.9;
      let ny = dy * 1.9;
      let nz = 1.0;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv;
      ny *= inv;
      nz *= inv;
      nd[i * 4] = Math.round((nx * 0.5 + 0.5) * 255);
      nd[i * 4 + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      nd[i * 4 + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      nd[i * 4 + 3] = 255;
    }
  }
  cctx.putImageData(colorImg, 0, 0);
  nctx.putImageData(normalImg, 0, 0);
  return { colorCanvas, normalCanvas };
}

function buildRadialCanvas(size, inner, outer, softness) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size * 0.5, size * 0.5, size * 0.02, size * 0.5, size * 0.5, size * 0.5);
  g.addColorStop(0, inner);
  g.addColorStop(clamp(softness, 0.05, 0.95), outer);
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

function buildSkyEquirectCanvas(palette, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  const data = img.data;
  const sunX = SUN_DIRECTION.x;
  const sunY = SUN_DIRECTION.y;
  const sunZ = SUN_DIRECTION.z;
  const sunH = Math.hypot(sunX, sunZ) || 1;
  const zen = palette.zenith;
  const mid = palette.mid;
  const hor = palette.horizon;
  const haze = palette.haze;
  const sun = palette.sun;
  const cloudDark = palette.cloudDark;
  const cloudLit = palette.cloudLit;

  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    const lat = (0.5 - v) * Math.PI;
    const cosLat = Math.cos(lat);
    const sinLat = Math.sin(lat);
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1);
      const lon = (u - 0.5) * TAU;
      const dx = cosLat * Math.cos(lon);
      const dy = sinLat;
      const dz = cosLat * Math.sin(lon);
      const hgt = Math.max(0, dy);

      let lr = lerp(hor.r, mid.r, smoothstep(0.0, 0.18, hgt));
      let lg = lerp(hor.g, mid.g, smoothstep(0.0, 0.18, hgt));
      let lb = lerp(hor.b, mid.b, smoothstep(0.0, 0.18, hgt));
      lr = lerp(lr, zen.r, smoothstep(0.14, 0.68, hgt));
      lg = lerp(lg, zen.g, smoothstep(0.14, 0.68, hgt));
      lb = lerp(lb, zen.b, smoothstep(0.14, 0.68, hgt));

      const azN = Math.max(0, (dx * sunX + dz * sunZ) / sunH);
      const glow = Math.pow(azN, 10) * Math.exp(-hgt * 6.0) * 0.9;
      const sd = Math.max(0, dx * sunX + dy * sunY + dz * sunZ);
      const sunGlow = Math.pow(sd, 22) * 0.5 + Math.pow(sd, 130) * 0.9;
      lr += sun.r * (glow + sunGlow);
      lg += sun.g * (glow + sunGlow);
      lb += sun.b * (glow + sunGlow);

      const band = Math.sin(hgt * 22 + Math.sin(lon * 2.0) * 1.6 + 0.6) * 0.5 + 0.5;
      const cl = smoothstep(0.55, 0.9, band) * smoothstep(0.015, 0.12, hgt) * (1 - smoothstep(0.5, 0.9, hgt));
      const lit = clamp(azN * 1.6, 0, 1);
      lr = lerp(lr, lerp(cloudDark.r, cloudLit.r, lit), cl * 0.35);
      lg = lerp(lg, lerp(cloudDark.g, cloudLit.g, lit), cl * 0.35);
      lb = lerp(lb, lerp(cloudDark.b, cloudLit.b, lit), cl * 0.35);

      const hz = Math.exp(-Math.abs(dy) * 14.0);
      lr = lerp(lr, haze.r, hz * 0.4);
      lg = lerp(lg, haze.g, hz * 0.4);
      lb = lerp(lb, haze.b, hz * 0.4);

      const idx = (y * w + x) * 4;
      data[idx] = linearToSrgbByte(lr);
      data[idx + 1] = linearToSrgbByte(lg);
      data[idx + 2] = linearToSrgbByte(lb);
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/* ------------------------------------------------------------------ */
/* sunset palette                                                      */
/* ------------------------------------------------------------------ */

// Keys whose values are scalar intensities; every other stop key is a colour.
const SCALAR_PALETTE_KEYS = {
  sunIntensity: true,
  hemiIntensity: true,
  fillIntensity: true,
  envIntensity: true,
};

function makeStop(t, values) {
  const out = { t };
  for (const key in values) {
    const v = values[key];
    if (SCALAR_PALETTE_KEYS[key] === true) {
      out[key] = v;
    } else {
      out[key] = new THREE.Color(v);
    }
  }
  return out;
}

const SUNSET_STOPS = [
  makeStop(0.0, {
    zenith: 0x6a7ba6,
    mid: 0x9aa0b8,
    horizon: 0xf6cd97,
    haze: 0xfbdcb2,
    sun: 0xfff1ce,
    cloudDark: 0x7d87a6,
    cloudLit: 0xffddb0,
    sunLightCol: 0xffe9c2,
    hemiSky: 0xa8b0c0,
    hemiGround: 0xd4ab7e,
    fog: 0xecc9a8,
    deep: 0x103048,
    oceanMid: 0x1f5462,
    oceanTeal: 0x2f7d78,
    oceanShallow: 0x4a978c,
    foam: 0xf5f5ea,
    reflectSky: 0x6f7f9a,
    ridge: 0x8088a8,
    sunIntensity: 3.0,
    hemiIntensity: 1.15,
    fillIntensity: 0.45,
    envIntensity: 0.66,
  }),
  makeStop(0.45, {
    zenith: 0x32304c,
    mid: 0x7c4f66,
    horizon: 0xff8a3e,
    haze: 0xffb06a,
    sun: 0xffd99a,
    cloudDark: 0x3d2f46,
    cloudLit: 0xffa257,
    sunLightCol: 0xffb569,
    hemiSky: 0x9c8f9a,
    hemiGround: 0xd8a678,
    fog: 0xd08a62,
    deep: 0x04101f,
    oceanMid: 0x0d3140,
    oceanTeal: 0x135553,
    oceanShallow: 0x24695f,
    foam: 0xffe4c6,
    reflectSky: 0x4a2e42,
    ridge: 0x5c4862,
    sunIntensity: 2.5,
    hemiIntensity: 1.15,
    fillIntensity: 0.5,
    envIntensity: 0.62,
  }),
  makeStop(1.0, {
    zenith: 0x241d3e,
    mid: 0x5c2f52,
    horizon: 0xff5f2e,
    haze: 0xd15a50,
    sun: 0xff8a40,
    cloudDark: 0x35233c,
    cloudLit: 0xdd6c44,
    sunLightCol: 0xff7d3a,
    hemiSky: 0x6e5c6e,
    hemiGround: 0x9a6a48,
    fog: 0x9a4f4e,
    deep: 0x050b18,
    oceanMid: 0x0c2836,
    oceanTeal: 0x154b50,
    oceanShallow: 0x2b6b62,
    foam: 0xf2c8b4,
    reflectSky: 0x4a2a40,
    ridge: 0x3a2745,
    sunIntensity: 1.9,
    hemiIntensity: 0.8,
    fillIntensity: 0.5,
    envIntensity: 0.45,
  }),
];

function makePalette() {
  return {
    zenith: new THREE.Color(),
    mid: new THREE.Color(),
    horizon: new THREE.Color(),
    haze: new THREE.Color(),
    sun: new THREE.Color(),
    cloudDark: new THREE.Color(),
    cloudLit: new THREE.Color(),
    sunLightCol: new THREE.Color(),
    hemiSky: new THREE.Color(),
    hemiGround: new THREE.Color(),
    fog: new THREE.Color(),
    deep: new THREE.Color(),
    oceanMid: new THREE.Color(),
    oceanTeal: new THREE.Color(),
    oceanShallow: new THREE.Color(),
    foam: new THREE.Color(),
    reflectSky: new THREE.Color(),
    ridge: new THREE.Color(),
    sunIntensity: 2.6,
    hemiIntensity: 0.9,
    fillIntensity: 0.36,
    envIntensity: 0.5,
  };
}

function samplePalette(t, palette) {
  t = clamp(t, 0, 1);
  let a = SUNSET_STOPS[0];
  let b = SUNSET_STOPS[SUNSET_STOPS.length - 1];
  for (let i = 0; i < SUNSET_STOPS.length - 1; i++) {
    if (t >= SUNSET_STOPS[i].t && t <= SUNSET_STOPS[i + 1].t) {
      a = SUNSET_STOPS[i];
      b = SUNSET_STOPS[i + 1];
      break;
    }
  }
  const local = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
  for (const key in palette) {
    const av = a[key];
    if (av === undefined) continue;
    if (typeof av === 'number') palette[key] = lerp(av, b[key], local);
    else palette[key].copy(av).lerp(b[key], local);
  }
  return palette;
}

/* ------------------------------------------------------------------ */
/* shared GLSL                                                         */
/* ------------------------------------------------------------------ */

const GLSL_NOISE = /* glsl */ `
float wHash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float wNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = wHash21(i);
  float b = wHash21(i + vec2(1.0, 0.0));
  float c = wHash21(i + vec2(0.0, 1.0));
  float d = wHash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float wFbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * wNoise(p);
    p = p * 2.03 + vec2(11.7, 5.3);
    a *= 0.5;
  }
  return s / 0.9375;
}
float wFbm5(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * wNoise(p);
    p = mat2(0.8, 0.6, -0.6, 0.8) * p * 2.02 + vec2(7.3, 13.1);
    a *= 0.5;
  }
  return s / 0.96875;
}
`;

const GLSL_WAVES = /* glsl */ `
float waveH(vec2 p, float t) {
  float h = 0.0;
  h += 0.150 * sin(dot(p, vec2(0.115, 0.420)) + t * 0.62);
  h += 0.090 * sin(dot(p, vec2(-0.300, 0.160)) + t * 0.93 + 1.3);
  h += 0.055 * sin(dot(p, vec2(0.440, -0.140)) + t * 1.37 + 2.7);
  h += 0.030 * sin(dot(p, vec2(-0.090, 0.620)) + t * 1.83 + 0.4);
  h += 0.020 * sin(dot(p, vec2(0.660, -0.330)) + t * 2.41 + 4.2);
  return h;
}
vec2 waveG(vec2 p, float t) {
  vec2 g = vec2(0.0);
  g += 0.150 * vec2(0.115, 0.420) * cos(dot(p, vec2(0.115, 0.420)) + t * 0.62);
  g += 0.090 * vec2(-0.300, 0.160) * cos(dot(p, vec2(-0.300, 0.160)) + t * 0.93 + 1.3);
  g += 0.055 * vec2(0.440, -0.140) * cos(dot(p, vec2(0.440, -0.140)) + t * 1.37 + 2.7);
  g += 0.030 * vec2(-0.090, 0.620) * cos(dot(p, vec2(-0.090, 0.620)) + t * 1.83 + 0.4);
  g += 0.020 * vec2(0.660, -0.330) * cos(dot(p, vec2(0.660, -0.330)) + t * 2.41 + 4.2);
  return g;
}
`;

/* ------------------------------------------------------------------ */
/* main factory                                                        */
/* ------------------------------------------------------------------ */

export function createEnvironment({ scene, renderer, state, quality } = {}) {
  const qualityKey = QUALITY_PRESETS[quality] ? quality : 'standard';
  const Q = QUALITY_PRESETS[qualityKey];

  const group = new THREE.Group();
  group.name = 'sunsetCoastEnvironment';
  if (scene) scene.add(group);

  const st = {
    sunset: 0.45,
    brightness: 1,
    wind: 0.25,
    dust: true,
    spray: true,
    lighthouse: true,
  };
  if (state) {
    if (typeof state.sunset === 'number') st.sunset = clamp(state.sunset, 0, 1);
    if (typeof state.brightness === 'number') st.brightness = clamp(state.brightness, 0.2, 2.5);
    if (typeof state.wind === 'number') st.wind = clamp(state.wind, 0, 1);
    if (typeof state.dust === 'boolean') st.dust = state.dust;
    if (typeof state.spray === 'boolean') st.spray = state.spray;
    if (typeof state.lighthouse === 'boolean') st.lighthouse = state.lighthouse;
  }

  const palette = makePalette();
  samplePalette(st.sunset, palette);

  const env = {
    quality: qualityKey,
    state: st,
    waterY: WATER_Y,
    shoreZ: SHORE_Z,
    group,
  };

  const scratchColor = new THREE.Color();
  const sizeScratch = new THREE.Vector2();
  const maxAnisotropy =
    renderer && renderer.capabilities ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 4;

  if (renderer) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }

  /* ---------------------------------------------------------------- */
  /* terrain height function                                          */
  /* ---------------------------------------------------------------- */

  function sandHeight(x, z) {
    let h = WATER_Y + 0.092 * (z - SHORE_Z);

    const sub = SHORE_Z - 0.55 - z;
    if (sub > 0) h -= sub * 0.11;

    const dry = smoothstep(-1.8, 1.2, z);

    h += dry * 0.20 * (fbm2(x * 0.15 + 8.2, z * 0.15 - 3.7, 3) * 2 - 1);

    const back = smoothstep(3.2, 11.0, z);
    h += back * (0.5 + 0.85 * fbm2(x * 0.11 + 2.0, z * 0.11 + 1.0, 2));

    const ax = Math.abs(x);
    const side = smoothstep(10.5, 22.0, ax);
    h += side * (0.85 + 1.35 * fbm2(x * 0.12 + 4.0, z * 0.12 + 2.0, 3));

    h += 0.09 * (fbm2(x * 0.42 - 3.1, z * 0.42 + 5.3, 2) * 2 - 1) * (0.3 + dry * 0.7);

    h += dry * 0.012 * Math.sin(x * 1.7 + z * 0.9 + fbm2(x * 0.5, z * 0.5, 2) * 7.0);

    h += 0.022 * (fbm2(x * 1.1 + 1.3, z * 1.1 - 2.2, 2) * 2 - 1) * (0.35 + dry * 0.65);

    // ---- bottle bed (bottle-local coords, u toward the mouth) ----
    const dx = x - BOTTLE.x;
    const dz = z - BOTTLE.z;
    const u = dx * BOTTLE.cosY - dz * BOTTLE.sinY;
    const v = dx * BOTTLE.sinY + dz * BOTTLE.cosY;
    const eu = u / 3.55;
    const ev = v / 2.05;
    const q = eu * eu + ev * ev;
    const bedMask = 1.0 - smoothstep(0.55, 1.25, q);
    if (bedMask > 0.0005) {
      const p = clamp(u / 2.65, -1, 1);
      const t = (p + 1) * 0.5;
      let bed = 0.235 + 0.46 * Math.pow(1.0 - t, 1.55);
      bed += 0.075 * Math.exp(-((u + 2.25) * (u + 2.25) / 0.55 + (v * v) / 0.9));
      bed -= 0.045 * (1.0 - smoothstep(0.25, 1.35, Math.abs(v)));
      bed += 0.03 * smoothstep(1.0, 1.9, Math.abs(v));
      bed += 0.022 * (fbm2(x * 0.6 + 7.7, z * 0.6 - 2.4, 2) * 2 - 1);
      h = h * (1.0 - bedMask) + bed * bedMask;
      if (q < 1.65) h = Math.min(h, 0.85);
    }

    // ---- small wind drift in front of the bottle mouth (bed detail) ----
    const mdx = x - 2.05;
    const mdz = z - 0.85;
    const mq = (mdx * mdx) / 2.3 + (mdz * mdz) / 0.75;
    if (mq < 3.5) {
      h += 0.055 * Math.exp(-mq * 1.2) * (0.78 + 0.22 * Math.sin(x * 2.4 + z * 1.7));
      h += 0.014 * Math.sin(x * 3.3 + z * 2.6 + 1.2) * Math.exp(-mq * 0.7);
    }

    // ---- hide the rectangular terrain boundary ----
    let edge = smoothstep(25.0, 31.0, ax);
    edge = Math.max(edge, smoothstep(16.5, 20.0, z));
    edge = Math.max(edge, 1.0 - smoothstep(-22.0, -17.0, z));
    if (edge > 0.0005) h = h * (1.0 - edge) - 2.6 * edge;

    return h;
  }

  function sandNormal(x, z, out) {
    const e = 0.32;
    const hl = sandHeight(x - e, z);
    const hr = sandHeight(x + e, z);
    const hd = sandHeight(x, z - e);
    const hu = sandHeight(x, z + e);
    out.set(hl - hr, 2 * e, hd - hu).normalize();
    return out;
  }

  env.sandHeight = sandHeight;
  env.getSandHeight = sandHeight;
  env.sandNormal = sandNormal;

  /* ---------------------------------------------------------------- */
  /* lights                                                           */
  /* ---------------------------------------------------------------- */

  const sunLight = new THREE.DirectionalLight(0xffb469, 2.7);
  sunLight.name = 'sunLight';
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(Q.shadowMap, Q.shadowMap);
  sunLight.shadow.bias = -0.0007;
  sunLight.shadow.normalBias = 0.055;
  sunLight.shadow.radius = 2.4;
  // The exterior diorama is static, so the 2048 sun shadow map is baked once
  // instead of re-rendering every frame. Call env.refreshShadows() once after
  // adding shadow casters (e.g. the bottle) that were not present on frame 1.
  sunLight.shadow.autoUpdate = false;
  sunLight.shadow.needsUpdate = true;
  const shadowCam = sunLight.shadow.camera;
  shadowCam.left = -15;
  shadowCam.right = 18;
  shadowCam.top = 16;
  shadowCam.bottom = -13;
  shadowCam.near = 8;
  shadowCam.far = 160;
  shadowCam.updateProjectionMatrix();
  sunLight.target.position.set(0, 0.8, -1.5);
  group.add(sunLight.target);
  group.add(sunLight);

  const hemiLight = new THREE.HemisphereLight(0x7c6f9e, 0x9a6d4e, 0.8);
  hemiLight.name = 'hemisphereLight';
  group.add(hemiLight);

  const fillLight = new THREE.DirectionalLight(0x8f9fd0, 0.34);
  fillLight.name = 'fillLight';
  fillLight.position.set(-26, 19, 34);
  fillLight.target.position.set(0, 1.2, -4);
  group.add(fillLight.target);
  group.add(fillLight);

  // warm sky/beach bounce from behind the camera so shaded rock faces and the
  // foreground sand keep warm detail instead of going to black at sunset
  const bounceLight = new THREE.DirectionalLight(0xffdfb8, 0.85);
  bounceLight.name = 'warmBounce';
  bounceLight.position.set(4, 7, 24);
  bounceLight.target.position.set(0, 1.0, -8);
  group.add(bounceLight.target);
  group.add(bounceLight);

  sunLight.position.copy(sunLight.target.position).addScaledVector(SUN_DIRECTION, 74);

  env.sunLight = sunLight;
  env.hemiLight = hemiLight;
  env.fillLight = fillLight;
  env.bounceLight = bounceLight;
  env.sunDirection = SUN_DIRECTION.clone();

  /* ---------------------------------------------------------------- */
  /* fog                                                              */
  /* ---------------------------------------------------------------- */

  const fog = new THREE.FogExp2(palette.fog.getHex(), FOG_DENSITY);
  if (scene) scene.fog = fog;
  env.fog = fog;

  /* ---------------------------------------------------------------- */
  /* sky                                                              */
  /* ---------------------------------------------------------------- */

  const skyUniforms = {
    uTime: { value: 0 },
    uWind: { value: st.wind },
    uSunDir: { value: SUN_DIRECTION.clone() },
    uZenith: { value: palette.zenith.clone() },
    uMid: { value: palette.mid.clone() },
    uHorizon: { value: palette.horizon.clone() },
    uHaze: { value: palette.haze.clone() },
    uSunColor: { value: palette.sun.clone() },
    uCloudDark: { value: palette.cloudDark.clone() },
    uCloudLit: { value: palette.cloudLit.clone() },
    uBrightness: { value: 1 },
    uSunset: { value: st.sunset },
  };

  const skyVertexShader = /* glsl */ `
    varying vec3 vDir;
    void main() {
      vDir = normalize(position);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;

  const skyFragmentShader = /* glsl */ `
    precision highp float;
    uniform float uTime;
    uniform float uWind;
    uniform float uBrightness;
    uniform float uSunset;
    uniform vec3 uSunDir;
    uniform vec3 uZenith;
    uniform vec3 uMid;
    uniform vec3 uHorizon;
    uniform vec3 uHaze;
    uniform vec3 uSunColor;
    uniform vec3 uCloudDark;
    uniform vec3 uCloudLit;
    varying vec3 vDir;

    ${GLSL_NOISE}

    void main() {
      vec3 dir = normalize(vDir);
      float h = clamp(dir.y, 0.0, 1.0);

      vec3 sky = mix(uHorizon, uMid, smoothstep(0.0, 0.085, h));
      sky = mix(sky, uZenith, smoothstep(0.05, 0.42, h));

      vec3 sunDir = normalize(uSunDir);
      float sd = clamp(dot(dir, sunDir), 0.0, 1.0);
      vec3 flatDir = normalize(vec3(dir.x, 0.0, dir.z) + vec3(1e-5));
      vec3 flatSun = normalize(vec3(sunDir.x, 0.0, sunDir.z) + vec3(1e-5));
      float az = clamp(dot(flatDir, flatSun), 0.0, 1.0);

      sky += uSunColor * pow(az, 9.0) * exp(-h * 9.0) * 0.34;
      sky += uSunColor * (pow(sd, 80.0) * 0.07 + pow(sd, 400.0) * 0.3);

      // layered pixel-ish clouds: stretched high streaks + a chunky sunset bank
      if (dir.y > 0.008) {
        vec2 cuv = dir.xz / (dir.y + 0.14);
        float speed = 0.0012 + uWind * 0.005;
        float horizonFade = smoothstep(0.008, 0.09, dir.y);

        vec2 uv1 = cuv * vec2(0.24, 0.82) + vec2(uTime * speed, 0.0);
        float n1 = wFbm(uv1 + vec2(0.0, wFbm(uv1 * 0.5) * 0.35));
        float c1 = smoothstep(0.47, 0.65, n1) * horizonFade * (1.0 - smoothstep(0.60, 0.96, dir.y));
        c1 = floor(c1 * 10.0) / 10.0;
        float lit1 = clamp(pow(az, 4.0) * exp(-h * 2.0) * 1.5 + pow(sd, 8.0) * 0.5, 0.0, 1.0);
        vec3 col1 = mix(uCloudDark, uCloudLit, lit1) * 0.82;
        col1 += uSunColor * 0.10 * lit1;
        sky = mix(sky, col1, c1 * 0.55);

        vec2 uv2 = cuv * vec2(0.38, 1.05) + vec2(uTime * speed * 1.7, 0.0);
        float n2 = wFbm(uv2 * 1.25 + vec2(0.0, 3.7));
        float n2b = wFbm(uv2 * 3.1 + 6.3);
        float shape = n2 * 0.82 + n2b * 0.18;
        float c2 = smoothstep(0.45, 0.58, shape) * horizonFade;
        c2 = floor(c2 * 12.0) / 12.0;
        float rim = smoothstep(0.55, 0.62, shape) * (1.0 - smoothstep(0.62, 0.76, shape));
        float sunLit = clamp(pow(az, 3.4) * 1.35 + pow(sd, 3.4) * 0.9, 0.0, 1.0);
        vec3 col2 = mix(uCloudDark * 0.85, uCloudLit, sunLit);
        col2 += uSunColor * rim * 0.9 * sunLit;
        col2 *= 0.7 + 0.3 * (1.0 - sunLit);
        sky = mix(sky, col2, c2 * 0.74);
      }

      float haze = exp(-h * 42.0);
      sky = mix(sky, uHaze, haze * 0.4);

      // smaller warm sun disc with a tight halo
      float disc = smoothstep(0.99964, 0.99987, sd);
      vec3 discColor = mix(uSunColor * 1.15, vec3(1.0, 0.83, 0.58), 0.7);
      sky = mix(sky, discColor, disc * 0.98);
      sky += vec3(1.0, 0.8, 0.52) * smoothstep(0.9998, 0.99994, sd) * 0.9;
      sky += uSunColor * pow(sd, 500.0) * 0.22 * (1.0 - disc);

      if (dir.y < 0.0) sky = uHaze;

      gl_FragColor = vec4(sky * mix(0.78, 1.18, uBrightness), 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `;

  const skyGeometry = new THREE.SphereGeometry(
    SKY_RADIUS,
    Q.skySeg,
    Math.max(12, Math.round(Q.skySeg * 0.5))
  );
  const skyMaterial = new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    vertexShader: skyVertexShader,
    fragmentShader: skyFragmentShader,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    toneMapped: true,
    fog: false,
  });
  const skyMesh = new THREE.Mesh(skyGeometry, skyMaterial);
  skyMesh.name = 'skyDome';
  skyMesh.frustumCulled = false;
  skyMesh.renderOrder = -10;
  group.add(skyMesh);
  env.skyMesh = skyMesh;
  env.skyUniforms = skyUniforms;

  /* ---------------------------------------------------------------- */
  /* external ocean                                                   */
  /* ---------------------------------------------------------------- */

  const oceanUniforms = {
    uTime: { value: 0 },
    uWind: { value: st.wind },
    uSunDir: { value: SUN_DIRECTION.clone() },
    uDeep: { value: palette.deep.clone() },
    uMid: { value: palette.oceanMid.clone() },
    uTeal: { value: palette.oceanTeal.clone() },
    uShallow: { value: palette.oceanShallow.clone() },
    uFoam: { value: palette.foam.clone() },
    uSunColor: { value: palette.sun.clone() },
    uHaze: { value: palette.haze.clone() },
    uReflectSky: { value: palette.reflectSky.clone() },
    uBrightness: { value: 1 },
    uFogDensity: { value: FOG_DENSITY },
    uSunset: { value: st.sunset },
  };

  const oceanVertexShader = /* glsl */ `
    uniform float uTime;
    varying vec3 vWorld;
    ${GLSL_WAVES}
    void main() {
      vec3 pos = position;
      float shoreT = smoothstep(-16.0, -4.0, pos.z);
      float amp = mix(1.0, 0.28, shoreT);
      pos.y += waveH(pos.xz, uTime) * amp;
      vec4 wp = modelMatrix * vec4(pos, 1.0);
      vWorld = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `;

  const oceanFragmentShader = /* glsl */ `
    precision highp float;
    uniform float uTime;
    uniform float uWind;
    uniform float uBrightness;
    uniform float uFogDensity;
    uniform float uSunset;
    uniform vec3 uSunDir;
    uniform vec3 uDeep;
    uniform vec3 uMid;
    uniform vec3 uTeal;
    uniform vec3 uShallow;
    uniform vec3 uFoam;
    uniform vec3 uSunColor;
    uniform vec3 uHaze;
    uniform vec3 uReflectSky;
    varying vec3 vWorld;

    ${GLSL_NOISE}
    ${GLSL_WAVES}

    void main() {
      vec2 p = vWorld.xz;
      float camDist = distance(cameraPosition, vWorld);
      float shoreT = smoothstep(-16.0, -4.0, vWorld.z);
      float amp = mix(1.0, 0.28, shoreT);

      // analytic swell normals + a little distance-faded chop
      vec2 g = waveG(p, uTime) * amp;
      float detail = exp(-camDist * 0.02);
      g += vec2(
        cos(dot(p, vec2(2.30, 1.10)) + uTime * 2.6),
        cos(dot(p, vec2(-1.20, 2.70)) + uTime * 3.1)
      ) * 0.075 * detail;
      vec3 N = normalize(vec3(-g.x * 2.6, 1.0, -g.y * 2.6));
      vec3 V = normalize(cameraPosition - vWorld);

      // deep navy distance, teal mid-water, warm shallow band at the shore
      float farT = smoothstep(8.0, 80.0, camDist);
      vec3 water = mix(uTeal, uDeep, pow(farT, 1.6));
      water = mix(water, uMid, 0.4 * smoothstep(6.0, 40.0, camDist));
      float shallow = smoothstep(-12.0, -4.4, vWorld.z);
      water = mix(water, uShallow, shallow * 0.38);
      water *= vec3(0.78, 0.98, 1.0);

      float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0);
      water = mix(water, uReflectSky, fres * 0.18);

      // warm sun reflection column + pixel sparkle + sharp glints
      vec3 R = reflect(-V, N);
      float rs = clamp(dot(R, uSunDir), 0.0, 1.0);
      vec2 sunFlat = normalize(vec2(uSunDir.x, uSunDir.z) + vec2(1e-5));
      vec2 toPoint = normalize(p - cameraPosition.xz + vec2(1e-5));
      float pathAlign = clamp(dot(toPoint, sunFlat), 0.0, 1.0);
      float path = pow(pathAlign, 26.0) * 0.18;
      float sheen = pow(rs, 40.0) * 0.13;
      float glint = pow(rs, 380.0) * 6.5;
      vec2 cell = floor(p * 6.0);
      float sparkleSeed = wHash21(cell + floor(uTime * 1.6));
      float sparkle = step(0.9, sparkleSeed) * pow(pathAlign, 10.0) * 2.4 * detail;
      vec3 sunPathTint = uSunColor * vec3(1.0, 0.56, 0.28);
      water += sunPathTint * (path + sheen + glint + sparkle) * mix(0.8, 1.25, uBrightness);
      // narrow warm column of glitter toward the sun
      water += sunPathTint * pow(pathAlign, 60.0) * 0.14;

      float wh = waveH(p, uTime) * amp;
      water = mix(water, uSunColor, smoothstep(0.12, 0.26, wh) * 0.06);

      // foam: shoreline band + breaking crests
      float foamNoise = wNoise(p * 0.62 + vec2(uTime * 0.05, -uTime * 0.03));
      float lineZ = -4.95 - wh * 1.4;
      float sd = lineZ - vWorld.z;
      float foam = exp(-pow((sd - 0.02) / 0.26, 2.0)) * (0.85 + 0.15 * foamNoise);
      foam += exp(-pow((sd - 1.15) / 0.4, 2.0)) * smoothstep(0.55, 0.78, foamNoise) * 0.38;
      float crestNoise = wNoise(p * 1.15 + vec2(uTime * 0.09, 0.0));
      foam += smoothstep(0.10, 0.17, wh) * smoothstep(0.55, 0.8, crestNoise) * 0.55 * smoothstep(-26.0, -7.0, vWorld.z);
      foam *= 1.0 - smoothstep(21.0, 28.0, abs(vWorld.x));
      foam = clamp(foam, 0.0, 1.0);
      foam *= 0.72 + 0.28 * wNoise(p * 3.3 + uTime * 0.3);
      water = mix(water, uFoam, foam * 0.7);

      // keep some water colour much further out; the sky haze still fuses the horizon
      float fogAmt = 1.0 - exp(-pow(camDist * uFogDensity * 0.72, 2.0));
      fogAmt = pow(fogAmt, 1.35);
      water = mix(water, uHaze, fogAmt);
      water += uSunColor * pow(clamp(dot(V, uSunDir), 0.0, 1.0), 70.0) * 0.18 * (1.0 - fogAmt);

      gl_FragColor = vec4(water * mix(0.75, 1.2, uBrightness), 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `;

  const oceanGeometry = new THREE.PlaneGeometry(360, 360, Q.oceanSeg, Q.oceanSeg);
  oceanGeometry.rotateX(-Math.PI / 2);
  oceanGeometry.translate(0, 0, -120);
  const oceanMaterial = new THREE.ShaderMaterial({
    uniforms: oceanUniforms,
    vertexShader: oceanVertexShader,
    fragmentShader: oceanFragmentShader,
    side: THREE.FrontSide,
    fog: false,
    toneMapped: true,
  });
  const ocean = new THREE.Mesh(oceanGeometry, oceanMaterial);
  ocean.name = 'externalOcean';
  ocean.position.y = WATER_Y;
  ocean.frustumCulled = false;
  group.add(ocean);
  env.ocean = ocean;
  env.oceanUniforms = oceanUniforms;

  /* ---------------------------------------------------------------- */
  /* sand terrain                                                     */
  /* ---------------------------------------------------------------- */

  const terrainWidth = 64;
  const terrainDepth = 44;
  const terrainSegX = Q.terrainSegX;
  const terrainSegZ = Math.round(Q.terrainSegX * (terrainDepth / terrainWidth));
  const terrainGeometry = new THREE.PlaneGeometry(terrainWidth, terrainDepth, terrainSegX, terrainSegZ);
  terrainGeometry.rotateX(-Math.PI / 2);
  terrainGeometry.translate(0, 0, -2);
  {
    const pos = terrainGeometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i);
      const pz = pos.getZ(i);
      const jx = (fbm2(px * 0.55 + 41.2, pz * 0.55 + 7.9, 2) - 0.5) * 0.22;
      const jz = (fbm2(px * 0.55 - 13.7, pz * 0.55 + 21.4, 2) - 0.5) * 0.22;
      const edgeFade = 1 - smoothstep(19.0, 25.0, Math.abs(px));
      pos.setX(i, px + jx * edgeFade);
      pos.setZ(i, pz + jz * edgeFade);
    }
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, sandHeight(pos.getX(i), pos.getZ(i)));
    }
    pos.needsUpdate = true;
    terrainGeometry.computeVertexNormals();
  }

  const sandTextures = buildSandTextures(Q.sandTex);
  const sandColorTexture = new THREE.CanvasTexture(sandTextures.colorCanvas);
  sandColorTexture.wrapS = sandColorTexture.wrapT = THREE.RepeatWrapping;
  sandColorTexture.colorSpace = THREE.SRGBColorSpace;
  sandColorTexture.repeat.set(15, 9);
  sandColorTexture.anisotropy = maxAnisotropy;
  const sandNormalTexture = new THREE.CanvasTexture(sandTextures.normalCanvas);
  sandNormalTexture.wrapS = sandNormalTexture.wrapT = THREE.RepeatWrapping;
  sandNormalTexture.colorSpace = THREE.NoColorSpace;
  sandNormalTexture.repeat.set(15, 9);
  sandNormalTexture.anisotropy = maxAnisotropy;

  {
    const count = terrainGeometry.attributes.position.count;
    const positions = terrainGeometry.attributes.position;
    const normals = terrainGeometry.attributes.normal;
    const colors = new Float32Array(count * 3);
    const dryCol = new THREE.Color(0xf0c795);
    const lightCol = new THREE.Color(0xffe9bf);
    const darkCol = new THREE.Color(0xcf9d6c);
    const dampCol = new THREE.Color(0xb08258);
    const wetCol = new THREE.Color(0x8f6f52);
    const deepWetCol = new THREE.Color(0x65543f);
    const warmCol = new THREE.Color(0xffdfae);
    const goldCol = new THREE.Color(0xffd794);
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const x = positions.getX(i);
      const y = positions.getY(i);
      const z = positions.getZ(i);
      const nx = normals.getX(i);
      const ny = normals.getY(i);
      const nz = normals.getZ(i);
      const above = y - WATER_Y;
      const n1 = fbm2(x * 0.28 + 3.1, z * 0.28 - 1.7, 3);
      const n2 = valueNoise2(x * 1.7, z * 1.7);

      c.copy(dryCol).lerp(lightCol, clamp(n1 * 1.4 - 0.2, 0, 1) * 0.55);
      c.lerp(darkCol, clamp((1 - n1) * 0.5, 0, 1) * 0.35);

      const wetAmt = 1 - smoothstep(0.02, 0.30, above);
      const dampAmt = smoothstep(0.02, 0.22, above) * (1 - smoothstep(0.3, 0.9, above));
      c.lerp(wetCol, clamp(wetAmt, 0, 1) * 0.6);
      c.lerp(dampCol, clamp(dampAmt, 0, 1) * 0.35);
      if (above < 0) c.lerp(deepWetCol, clamp(-above * 1.2, 0, 0.7));

      const sunDot = nx * SUN_DIRECTION.x + ny * SUN_DIRECTION.y + nz * SUN_DIRECTION.z;
      c.lerp(warmCol, clamp(sunDot * 0.5 + 0.5, 0, 1) * 0.24);
      c.multiplyScalar(0.97 + 0.14 * n2);

      const bdx = (x - BOTTLE.x) / 3.6;
      const bdz = (z - BOTTLE.z) / 2.2;
      const nest = Math.exp(-(bdx * bdx + bdz * bdz) * 1.6);
      c.lerp(goldCol, nest * 0.2);

      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    terrainGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }

  const terrainMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    map: sandColorTexture,
    normalMap: sandNormalTexture,
    normalScale: new THREE.Vector2(0.55, 0.55),
    roughness: 0.9,
    metalness: 0.0,
    envMapIntensity: 0.55,
    dithering: true,
  });
  const terrain = new THREE.Mesh(terrainGeometry, terrainMaterial);
  terrain.name = 'sandTerrain';
  terrain.receiveShadow = true;
  terrain.castShadow = false;
  group.add(terrain);
  env.terrain = terrain;
  env.terrainMaterial = terrainMaterial;
  env.sandColorTexture = sandColorTexture;
  env.sandNormalTexture = sandNormalTexture;

  /* ---------------------------------------------------------------- */
  /* rocks, cliffs, sea stacks                                        */
  /* ---------------------------------------------------------------- */

  const rngRocks = mulberry32(1337);
  const rockGeos = [];

  function addRock(x, y, z, sx, sy, sz, rotY, detail, roughnessJitter) {
    const geo = makeRockGeometry(rngRocks, sx, sy, sz, detail, roughnessJitter);
    geo.rotateY(rotY);
    geo.rotateZ((rngRocks() - 0.5) * 0.22);
    geo.translate(x, y, z);
    rockGeos.push(geo);
  }

  // scattered beach rocks (a few large dark ones frame the left foreground)
  const beachRockDefs = [
    [-6.6, 2.4, 1.25, 0.85, 1.0],
    [-8.4, 1.2, 1.6, 1.05, 1.2],
    [-5.4, 4.4, 0.85, 0.6, 0.8],
    [-10.6, 2.8, 1.9, 1.25, 1.4],
    [-12.8, 0.4, 2.2, 1.6, 1.6],
    [-4.2, -1.8, 0.55, 0.4, 0.5],
    [-7.9, -3.4, 0.9, 0.7, 0.85],
    [-11.8, -4.6, 1.5, 1.5, 1.3],
    [4.6, 3.3, 0.55, 0.42, 0.5],
    [6.9, 2.0, 0.8, 0.55, 0.7],
    [9.4, 3.9, 0.6, 0.45, 0.55],
    [3.1, 5.6, 0.42, 0.3, 0.4],
    [12.2, -0.8, 1.3, 0.85, 1.1],
    [15.0, -3.6, 1.9, 1.4, 1.6],
    [7.8, -4.8, 0.9, 0.7, 0.8],
    [-3.0, -4.4, 0.35, 0.26, 0.32],
    [1.9, -4.8, 0.4, 0.3, 0.36],
    [-9.5, -6.4, 1.2, 0.9, 1.1],
    [13.6, -8.8, 1.6, 1.1, 1.4],
    [-14.2, -2.2, 2.3, 1.7, 1.9],
  ];
  for (let i = 0; i < beachRockDefs.length; i++) {
    const d = beachRockDefs[i];
    const groundY = sandHeight(d[0], d[1]);
    addRock(d[0], groundY + d[3] * 0.28 - 0.1, d[1], d[2], d[3], d[4], rngRocks() * TAU, 1, 0.34);
  }

  // left shoreline outcrop
  for (let i = 0; i < 7; i++) {
    const x = -13.5 - rngRocks() * 6.0;
    const z = -4.5 - rngRocks() * 5.0;
    const s = 0.9 + rngRocks() * 1.6;
    addRock(x, -0.25 + rngRocks() * 0.3, z, s, s * (0.7 + rngRocks() * 0.5), s, rngRocks() * TAU, 1, 0.32);
  }

  // right headland cradling the lighthouse (tops kept just under the mesa top)
  const cliffDefs = [
    [7.6, -16.8, 4.4, 3.0, 4.8],
    [12.0, -17.6, 4.6, 3.2, 4.4],
    [16.0, -19.4, 4.2, 3.0, 4.6],
    [8.8, -20.8, 4.8, 3.4, 4.8],
    [13.6, -21.6, 5.2, 3.6, 5.0],
    [6.6, -23.8, 4.2, 2.9, 4.2],
    [16.6, -23.6, 4.6, 3.2, 4.6],
    [10.0, -25.8, 5.6, 3.7, 5.2],
    [14.6, -27.6, 5.2, 3.5, 4.8],
    [8.0, -28.4, 4.6, 3.2, 4.4],
    [12.6, -30.6, 5.4, 3.6, 5.2],
    [18.4, -29.0, 4.4, 3.0, 4.4],
    [21.5, -21.5, 5.0, 3.2, 5.0],
    [25.0, -24.0, 5.6, 3.4, 5.4],
    [28.5, -26.0, 6.0, 3.6, 5.6],
    [24.0, -17.0, 4.4, 2.8, 4.4],
    [30.0, -31.0, 6.5, 3.8, 6.0],
    [17.0, -34.5, 6.0, 3.5, 5.5],
    [24.0, -33.0, 5.6, 3.3, 5.2],
  ];
  // cliff tops sit just under the lighthouse platform (top y ~2.5)
  for (let i = 0; i < cliffDefs.length; i++) {
    const d = cliffDefs[i];
    const sy = d[3];
    const y = 1.35 - sy * 0.8 + rngRocks() * 0.35;
    addRock(d[0], y, d[1], d[2], sy, d[4], rngRocks() * TAU, 1, 0.3);
  }
  // rock fins behind the lighthouse for a dramatic silhouette
  addRock(14.2, 1.35, -31.8, 2.2, 2.2, 2.0, 1.1, 1, 0.3);
  addRock(8.6, 1.2, -32.4, 2.0, 2.1, 1.9, 2.4, 1, 0.3);

  // flat mesa platform that seats the lighthouse (extends well under the sea)
  {
    const mesa = makeMesaGeometry(3.0, 5.2, 4.2, 9, rngRocks, 0.2);
    mesa.translate(10.2, -1.7, -25.4);
    rockGeos.push(mesa);
  }
  // apron rocks around the mesa so it reads as one continuous cliff
  addRock(6.8, -0.7, -23.4, 2.8, 2.2, 2.4, 1.2, 1, 0.3);
  addRock(13.3, -0.8, -23.0, 2.6, 2.1, 2.6, 2.6, 1, 0.3);
  addRock(10.2, -1.0, -21.6, 3.0, 2.3, 2.2, 4.0, 1, 0.3);
  addRock(6.4, -1.1, -26.6, 3.0, 2.4, 2.8, 5.2, 1, 0.3);
  addRock(14.8, -1.2, -27.2, 3.2, 2.5, 2.8, 0.7, 1, 0.3);
  addRock(18.6, -1.0, -20.6, 3.6, 2.7, 3.2, 3.4, 1, 0.3);

  // background coastal ridge so the headland silhouette continues behind the
  // lighthouse toward the right frame edge instead of reading as a floating islet
  const coastRng = mulberry32(5566);
  for (let i = 0; i < 16; i++) {
    const x = 9 + coastRng() * 34;
    const z = -36 - coastRng() * 30;
    const s = 3.0 + coastRng() * 3.6;
    const sy = s * (1.0 + coastRng() * 0.7);
    const top = 1.6 + coastRng() * 2.6 + Math.max(0, x - 26) * 0.06;
    addRock(x, top - sy * 0.92, z, s, sy, s * (0.8 + coastRng() * 0.5), coastRng() * TAU, 1, 0.28);
  }

  // distant sea stacks
  const stackRng = mulberry32(4242);
  for (let i = 0; i < 9; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    const x = side * (22 + stackRng() * 46);
    const z = -64 - stackRng() * 96;
    const s = 2.2 + stackRng() * 3.4;
    const h = 4.5 + stackRng() * 11;
    addRock(x, -0.8 + h * 0.18, z, s, h, s * (0.8 + stackRng() * 0.5), stackRng() * TAU, 1, 0.3);
    if (stackRng() > 0.5) {
      addRock(x + side * 3.2, -0.6, z + 2.4, s * 0.7, h * 0.5, s * 0.6, stackRng() * TAU, 0, 0.34);
    }
  }

  const rockGeometry = mergeGeometries(rockGeos);
  {
    const count = rockGeometry.attributes.position.count;
    const pos = rockGeometry.attributes.position;
    const nor = rockGeometry.attributes.normal;
    const colors = new Float32Array(count * 3);
    const base = new THREE.Color(0x9b8878);
    const warmC = new THREE.Color(0xd0a578);
    const darkC = new THREE.Color(0x5a4c43);
    const wetC = new THREE.Color(0x47403a);
    const foamTint = new THREE.Color(0xded2bd);
    const violetC = new THREE.Color(0x776680);
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const nx = nor.getX(i);
      const ny = nor.getY(i);
      const nz = nor.getZ(i);
      const above = y - WATER_Y;
      const vnoise = valueNoise2(x * 0.6 + 3.7, z * 0.6 - 8.1);
      c.copy(base).lerp(darkC, clamp((1 - vnoise) * 0.6, 0, 1) * 0.45);
      const sunDot = nx * SUN_DIRECTION.x + ny * SUN_DIRECTION.y + nz * SUN_DIRECTION.z;
      c.lerp(warmC, clamp(sunDot * 0.62 + 0.22, 0, 1) * 0.55);
      c.lerp(violetC, smoothstep(24.0, 80.0, Math.hypot(x, z)) * 0.34);
      const wetAmt = 1 - smoothstep(-0.05, 0.65, above);
      c.lerp(wetC, clamp(wetAmt, 0, 1) * 0.5);
      const foamBand = Math.exp(-Math.pow((above - 0.04) / 0.14, 2));
      c.lerp(foamTint, foamBand * 0.28);
      const grime = 0.92 + 0.16 * hashInt3(Math.round(x * 12), Math.round(y * 12), Math.round(z * 12));
      colors[i * 3] = c.r * grime;
      colors[i * 3 + 1] = c.g * grime;
      colors[i * 3 + 2] = c.b * grime;
    }
    rockGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  const rockMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    flatShading: true,
    roughness: 0.82,
    metalness: 0.02,
    envMapIntensity: 0.55,
    dithering: true,
  });
  const rocksMesh = new THREE.Mesh(rockGeometry, rockMaterial);
  rocksMesh.name = 'rocksAndCliffs';
  rocksMesh.castShadow = true;
  rocksMesh.receiveShadow = true;
  group.add(rocksMesh);
  env.rocks = rocksMesh;

  // distant coastline silhouette ridge
  const ridgeMaterial = new THREE.MeshBasicMaterial({
    color: palette.ridge.getHex(),
    fog: true,
    toneMapped: true,
    side: THREE.DoubleSide,
  });
  {
    const positions = [];
    const segs = 40;
    const x0 = -270;
    const x1 = 270;
    const zFront = -206;
    const zTop = -216;
    for (let i = 0; i < segs; i++) {
      const xa = lerp(x0, x1, i / segs);
      const xb = lerp(x0, x1, (i + 1) / segs);
      const ha = 1.8 + 10.0 * Math.pow(fbm2(xa * 0.012 + 5.1, 2.2, 3), 1.4);
      const hb = 1.8 + 10.0 * Math.pow(fbm2(xb * 0.012 + 5.1, 2.2, 3), 1.4);
      positions.push(xa, -2.5, zFront, xb, -2.5, zFront, xa, ha, zTop);
      positions.push(xb, -2.5, zFront, xb, hb, zTop, xa, ha, zTop);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    const ridge = new THREE.Mesh(geo, ridgeMaterial);
    ridge.name = 'distantCoast';
    group.add(ridge);
    env.distantRidge = ridge;
  }

  // tiny bird silhouettes near the sun
  const birdsMaterial = new THREE.MeshBasicMaterial({
    color: 0x2a2030,
    side: THREE.DoubleSide,
    fog: true,
    toneMapped: true,
  });
  let birdsMesh = null;
  {
    const positions = [];
    const birdRng = mulberry32(777);
    for (let i = 0; i < 5; i++) {
      const cx = -7 + birdRng() * 20;
      const cy = 4.6 + birdRng() * 2.6;
      const cz = -52 - birdRng() * 26;
      const s = 0.45 + birdRng() * 0.5;
      positions.push(cx - s, cy, cz, cx, cy + s * 0.16, cz, cx - s * 0.5, cy, cz + s * 0.12);
      positions.push(cx + s, cy, cz, cx, cy + s * 0.16, cz, cx + s * 0.5, cy, cz + s * 0.12);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    birdsMesh = new THREE.Mesh(geo, birdsMaterial);
    birdsMesh.name = 'birds';
    group.add(birdsMesh);
  }

  /* ---------------------------------------------------------------- */
  /* lighthouse                                                       */
  /* ---------------------------------------------------------------- */

  const lighthouseGroup = new THREE.Group();
  lighthouseGroup.name = 'lighthouse';
  lighthouseGroup.position.set(9.9, 2.5, -25.4);
  group.add(lighthouseGroup);

  const whiteParts = [];
  const darkParts = [];

  function pushWhite(geo) {
    whiteParts.push(geo);
  }

  function pushDark(geo, color) {
    const g = asNonIndexed(geo);
    const count = g.attributes.position.count;
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      arr[i * 3] = color.r;
      arr[i * 3 + 1] = color.g;
      arr[i * 3 + 2] = color.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    darkParts.push(g);
  }

  const metalDark = new THREE.Color(0x2f2b33);
  const roofDark = new THREE.Color(0x3a2f33);
  const copperDark = new THREE.Color(0x44564c);
  const frameDark = new THREE.Color(0x2c2630);

  // plinth + tapered tower
  const plinthGeo = new THREE.CylinderGeometry(1.02, 1.24, 0.4, 10, 1);
  plinthGeo.translate(0, 0.2, 0);
  pushWhite(plinthGeo);
  const towerGeo = new THREE.CylinderGeometry(0.5, 0.8, 3.4, 10, 4);
  towerGeo.translate(0, 2.1, 0);
  pushWhite(towerGeo);

  // keeper house attached to the tower (screen right)
  const houseW = 1.4;
  const houseD = 1.15;
  const houseH = 0.9;
  const houseGeo = new THREE.BoxGeometry(houseW, houseH, houseD);
  houseGeo.translate(1.25, houseH * 0.5 + 0.02, 0.1);
  pushWhite(houseGeo);
  const chimneyGeo = new THREE.BoxGeometry(0.16, 0.4, 0.16);
  chimneyGeo.translate(1.75, houseH + 0.32, -0.26);
  pushWhite(chimneyGeo);
  const roofGeo = makeGableRoof(houseW + 0.16, houseD + 0.16, 0.4);
  roofGeo.translate(1.25, houseH + 0.02, 0.1);
  pushDark(roofGeo, roofDark);

  // gallery, railing, lantern frame, dome and finial
  const galleryGeo = new THREE.CylinderGeometry(0.74, 0.62, 0.16, 10, 1);
  galleryGeo.translate(0, 3.88, 0);
  pushDark(galleryGeo, metalDark);
  const railGeo = new THREE.TorusGeometry(0.7, 0.026, 4, 12);
  railGeo.rotateX(-Math.PI / 2);
  railGeo.translate(0, 4.22, 0);
  pushDark(railGeo, metalDark);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * TAU;
    const post = new THREE.BoxGeometry(0.034, 0.28, 0.034);
    post.translate(Math.sin(a) * 0.7, 4.08, Math.cos(a) * 0.7);
    pushDark(post, metalDark);
  }
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU + 0.2;
    const post = new THREE.BoxGeometry(0.045, 0.5, 0.045);
    post.translate(Math.sin(a) * 0.45, 4.22, Math.cos(a) * 0.45);
    pushDark(post, metalDark);
  }
  const domeGeo = new THREE.SphereGeometry(0.5, 10, 5, 0, TAU, 0, Math.PI / 2);
  domeGeo.scale(1.0, 0.6, 1.0);
  domeGeo.translate(0, 4.47, 0);
  pushDark(domeGeo, copperDark);
  const finialGeo = new THREE.CylinderGeometry(0.016, 0.016, 0.14, 5);
  finialGeo.translate(0, 4.83, 0);
  pushDark(finialGeo, metalDark);
  const finialBall = new THREE.SphereGeometry(0.05, 6, 4);
  finialBall.translate(0, 4.9, 0);
  pushDark(finialBall, metalDark);

  // tower windows + door (front faces +Z toward the camera)
  const winHeights = [1.15, 1.95, 2.75];
  for (let i = 0; i < winHeights.length; i++) {
    const wy = winHeights[i];
    const t = clamp((wy - 0.4) / 3.4, 0, 1);
    const r = lerp(0.8, 0.5, t);
    const win = new THREE.BoxGeometry(0.15, 0.27, 0.06);
    win.translate(0, wy, r);
    pushDark(win, frameDark);
  }
  const sideWin = new THREE.BoxGeometry(0.13, 0.23, 0.06);
  sideWin.rotateY(Math.PI / 2);
  sideWin.translate(0.62, 2.3, 0.22);
  pushDark(sideWin, frameDark);
  const doorGeo = new THREE.BoxGeometry(0.3, 0.58, 0.08);
  doorGeo.translate(0, 0.7, 0.78);
  pushDark(doorGeo, roofDark);
  // keeper house door + window frame
  const houseDoor = new THREE.BoxGeometry(0.24, 0.48, 0.06);
  houseDoor.translate(1.02, 0.26, 0.68);
  pushDark(houseDoor, roofDark);
  const houseWinFrame = new THREE.BoxGeometry(0.3, 0.26, 0.05);
  houseWinFrame.translate(1.58, 0.52, 0.68);
  pushDark(houseWinFrame, frameDark);

  const whiteGeometry = mergeGeometries(whiteParts);
  {
    const count = whiteGeometry.attributes.position.count;
    const pos = whiteGeometry.attributes.position;
    const nor = whiteGeometry.attributes.normal;
    const colors = new Float32Array(count * 3);
    const stoneHigh = new THREE.Color(0xf0e6d6);
    const stoneLow = new THREE.Color(0xc7b9a6);
    const warmTint = new THREE.Color(0xffd9a8);
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const nx = nor.getX(i);
      const ny = nor.getY(i);
      const nz = nor.getZ(i);
      c.copy(stoneHigh);
      c.lerp(stoneLow, (1 - smoothstep(0.0, 2.2, y)) * 0.5);
      const sunDot = nx * SUN_DIRECTION.x + ny * SUN_DIRECTION.y + nz * SUN_DIRECTION.z;
      c.lerp(warmTint, clamp(sunDot, 0, 1) * 0.24);
      const grime = 0.94 + 0.09 * hashInt3(Math.round(x * 30), Math.round(y * 30), Math.round(z * 30));
      colors[i * 3] = c.r * grime;
      colors[i * 3 + 1] = c.g * grime;
      colors[i * 3 + 2] = c.b * grime;
    }
    whiteGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  const whiteMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    flatShading: true,
    roughness: 0.8,
    metalness: 0.0,
    envMapIntensity: 0.5,
  });
  const whiteMesh = new THREE.Mesh(whiteGeometry, whiteMaterial);
  whiteMesh.name = 'lighthouseTower';
  whiteMesh.castShadow = true;
  whiteMesh.receiveShadow = true;
  whiteMesh.userData.lighthouse = true;
  lighthouseGroup.add(whiteMesh);

  const darkGeometry = mergeGeometries(darkParts);
  const darkMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    flatShading: true,
    roughness: 0.52,
    metalness: 0.32,
    envMapIntensity: 0.7,
  });
  const darkMesh = new THREE.Mesh(darkGeometry, darkMaterial);
  darkMesh.name = 'lighthouseDetails';
  darkMesh.castShadow = true;
  darkMesh.receiveShadow = true;
  darkMesh.userData.lighthouse = true;
  lighthouseGroup.add(darkMesh);

  // lantern room: warm glowing glass (its own material so the lamp can be toggled)
  const lanternMaterial = new THREE.MeshStandardMaterial({
    color: 0x37313a,
    emissive: 0xffa64d,
    emissiveIntensity: 0.75,
    roughness: 0.38,
    metalness: 0.35,
    transparent: true,
    opacity: 0.78,
    flatShading: true,
    envMapIntensity: 0.8,
  });
  const lanternGeo = new THREE.CylinderGeometry(0.44, 0.46, 0.5, 8, 1);
  lanternGeo.translate(0, 4.22, 0);
  const lanternMesh = new THREE.Mesh(lanternGeo, lanternMaterial);
  lanternMesh.name = 'lighthouseLantern';
  lanternMesh.userData.lighthouse = true;
  lighthouseGroup.add(lanternMesh);

  // warm emissive bits: lamp core inside the lantern + one lit keeper-house window
  const lampGeos = [];
  const lampCore = new THREE.SphereGeometry(0.17, 8, 6);
  lampCore.translate(0, 4.22, 0);
  lampGeos.push(lampCore);
  const litWindow = new THREE.PlaneGeometry(0.2, 0.17);
  litWindow.translate(1.58, 0.53, 0.71);
  lampGeos.push(litWindow);
  const lampMaterial = new THREE.MeshBasicMaterial({ color: 0xffd9a2, toneMapped: false });
  const lampMesh = new THREE.Mesh(mergeGeometries(lampGeos), lampMaterial);
  lampMesh.name = 'lighthouseLamp';
  lampMesh.userData.lighthouse = true;
  lighthouseGroup.add(lampMesh);

  // glow sprite
  const glowCanvas = buildRadialCanvas(64, 'rgba(255,224,170,0.95)', 'rgba(255,164,88,0.35)', 0.35);
  const glowTexture = new THREE.CanvasTexture(glowCanvas);
  glowTexture.colorSpace = THREE.SRGBColorSpace;
  const glowMaterial = new THREE.SpriteMaterial({
    map: glowTexture,
    color: 0xffc487,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
    fog: false,
    opacity: 0.4,
  });
  const glowSprite = new THREE.Sprite(glowMaterial);
  glowSprite.position.set(0, 4.24, 0);
  glowSprite.scale.setScalar(1.1);
  lighthouseGroup.add(glowSprite);

  // warm point light
  const lampLight = new THREE.PointLight(0xffb45c, 18, 40, 2);
  lampLight.position.set(0, 4.22, 0);
  lampLight.castShadow = false;
  lighthouseGroup.add(lampLight);

  // rotating beams
  const beamGroup = new THREE.Group();
  beamGroup.position.set(0, 4.22, 0);
  lighthouseGroup.add(beamGroup);
  const beamMaterial = new THREE.MeshBasicMaterial({
    color: 0xffc98a,
    transparent: true,
    opacity: 0.01,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false,
  });
  const beamGeo = new THREE.ConeGeometry(0.22, 8, 6, 1, true);
  beamGeo.translate(0, -4, 0);
  beamGeo.rotateX(-Math.PI / 2);
  const beam = new THREE.Mesh(beamGeo, beamMaterial);
  beam.renderOrder = 3;
  beamGroup.add(beam);

  env.lighthouse = {
    group: lighthouseGroup,
    isEnabled: st.lighthouse,
    hitObjects: [whiteMesh, darkMesh, lanternMesh],
    setEnabled(on) {
      const enabled = !!on;
      this.isEnabled = enabled;
      lampLight.visible = enabled;
      glowSprite.visible = enabled;
      beamGroup.visible = enabled;
      lampMesh.visible = enabled;
      lanternMaterial.emissiveIntensity = enabled ? 0.9 : 0.02;
    },
    update(time, dt) {
      beamGroup.rotation.y = time * (0.45 + st.wind * 0.35);
      if (!this.isEnabled) return;
      const bright = 0.6 + 0.4 * st.brightness;
      const flicker = 0.92 + 0.06 * Math.sin(time * 7.1) + 0.03 * Math.sin(time * 23.7 + 1.2);
      lampLight.intensity = 14 * flicker * bright;
      glowMaterial.opacity = (0.3 + 0.05 * Math.sin(time * 3.3) + 0.03 * Math.sin(time * 11.7)) * bright;
      glowSprite.scale.setScalar(1.1 * (1 + 0.04 * Math.sin(time * 5.2)));
      beamMaterial.opacity = 0.008 + 0.004 * (0.5 + 0.5 * Math.sin(time * 0.8));
    },
  };

  /* ---------------------------------------------------------------- */
  /* static beach props: pebbles, shells, seaweed, driftwood           */
  /* ---------------------------------------------------------------- */

  const propRng = mulberry32(24680);

  // cheap fake contact shadow decal
  const contactShadowCanvas = buildRadialCanvas(64, 'rgba(255,255,255,0.72)', 'rgba(255,255,255,0)', 0.55);
  const contactShadowTexture = new THREE.CanvasTexture(contactShadowCanvas);
  contactShadowTexture.colorSpace = THREE.SRGBColorSpace;
  const contactShadowMaterial = new THREE.MeshBasicMaterial({
    color: 0x2c1c10,
    map: contactShadowTexture,
    transparent: true,
    depthWrite: false,
    opacity: 0.34,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    toneMapped: false,
    fog: true,
  });
  const contactShadowGeometry = new THREE.PlaneGeometry(1, 1);
  contactShadowGeometry.rotateX(-Math.PI / 2);

  const shadowPlacements = [];

  // ---- pebbles ----
  const pebbleGeo = new THREE.IcosahedronGeometry(1, 0);
  {
    const pos = pebbleGeo.attributes.position;
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const seed = hashInt3(Math.round(x * 89), Math.round(y * 89), Math.round(z * 89));
      const r = 1 + (seed - 0.5) * 0.35;
      pos.setXYZ(i, x * r, y * r * 0.7, z * r);
      const shade = 0.72 + seed * 0.28;
      col[i * 3] = shade * 1.04;
      col[i * 3 + 1] = shade * 0.96;
      col[i * 3 + 2] = shade * 0.86;
    }
    pos.needsUpdate = true;
    pebbleGeo.computeVertexNormals();
    pebbleGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  const pebbleMaterial = new THREE.MeshStandardMaterial({
    color: 0xd9b48a,
    vertexColors: true,
    flatShading: true,
    roughness: 0.95,
    metalness: 0.0,
    envMapIntensity: 0.22,
  });
  const pebbleMesh = new THREE.InstancedMesh(pebbleGeo, pebbleMaterial, Q.pebbles);
  pebbleMesh.name = 'beachPebbles';
  pebbleMesh.receiveShadow = true;
  pebbleMesh.castShadow = false;
  {
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    let placed = 0;
    for (let i = 0; i < Q.pebbles * 4 && placed < Q.pebbles; i++) {
      const x = -19 + propRng() * 38;
      const z = -5.0 + propRng() * 12.5;
      const h = sandHeight(x, z);
      if (h < -0.1 || h > 2.6) continue;
      let s = 0.025 + propRng() * 0.09;
      if (z > 3.5) s *= 0.6;
      dummy.position.set(x, h + s * 0.24, z);
      dummy.rotation.set(propRng() * 0.6, propRng() * TAU, propRng() * 0.6);
      dummy.scale.set(s * (1 + propRng() * 0.7), s, s * (1 + propRng() * 0.7));
      dummy.updateMatrix();
      pebbleMesh.setMatrixAt(placed, dummy.matrix);
      const shade = 0.34 + propRng() * 0.36;
      color.setRGB(shade * 1.08, shade * 0.98, shade * 0.86);
      pebbleMesh.setColorAt(placed, color);
      placed++;
    }
    pebbleMesh.count = placed;
    pebbleMesh.instanceMatrix.needsUpdate = true;
    if (pebbleMesh.instanceColor) pebbleMesh.instanceColor.needsUpdate = true;
    pebbleMesh.computeBoundingSphere();
  }
  group.add(pebbleMesh);

  // ---- scallop shells (larger ones scattered around the bottle) ----
  const shellGeo = makeShellGeometry(8686);
  {
    const pos = shellGeo.attributes.position;
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const shade = 0.78 + 0.22 * hashInt3(i, 13, 5);
      col[i * 3] = shade;
      col[i * 3 + 1] = shade * 0.94;
      col[i * 3 + 2] = shade * 0.88;
    }
    shellGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  const shellMaterial = new THREE.MeshStandardMaterial({
    color: 0xffe2bd,
    vertexColors: true,
    flatShading: true,
    roughness: 0.82,
    metalness: 0.0,
    side: THREE.DoubleSide,
    envMapIntensity: 0.25,
  });
  const shellPlacements = [];
  {
    for (let i = 0; i < 10; i++) {
      const a = propRng() * TAU;
      const r = 1.6 + propRng() * 2.4;
      shellPlacements.push({
        x: BOTTLE.x + Math.cos(a) * r,
        z: BOTTLE.z + Math.sin(a) * r * 0.7,
        s: 0.15 + propRng() * 0.1,
        rot: propRng() * TAU,
      });
    }
    for (let i = 0; i < 18; i++) {
      shellPlacements.push({
        x: -16 + propRng() * 32,
        z: -4.6 + propRng() * 8.2,
        s: 0.05 + propRng() * 0.07,
        rot: propRng() * TAU,
      });
    }
  }
  const shellMesh = new THREE.InstancedMesh(shellGeo, shellMaterial, shellPlacements.length);
  shellMesh.name = 'shells';
  shellMesh.receiveShadow = true;
  shellMesh.castShadow = false;
  {
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const shellsPalette = [0xfff0d8, 0xf7dcc0, 0xffe8da, 0xe8cda8, 0xffd9b8];
    for (let i = 0; i < shellPlacements.length; i++) {
      const sp = shellPlacements[i];
      const h = sandHeight(sp.x, sp.z);
      dummy.position.set(sp.x, h + 0.012, sp.z);
      dummy.rotation.set((propRng() - 0.5) * 0.25, sp.rot, (propRng() - 0.5) * 0.2);
      dummy.scale.set(sp.s, sp.s * 0.9, sp.s);
      dummy.updateMatrix();
      shellMesh.setMatrixAt(i, dummy.matrix);
      color.set(shellsPalette[Math.floor(propRng() * shellsPalette.length)]);
      color.multiplyScalar(0.82 + propRng() * 0.2);
      shellMesh.setColorAt(i, color);
      if (sp.s > 0.12) shadowPlacements.push({ x: sp.x, z: sp.z, size: sp.s * 0.65 });
    }
    shellMesh.instanceMatrix.needsUpdate = true;
    if (shellMesh.instanceColor) shellMesh.instanceColor.needsUpdate = true;
    shellMesh.computeBoundingSphere();
  }
  group.add(shellMesh);

  // ---- seaweed clumps near the wet sand ----
  const seaweedGeo = makeSeaweedGeometry(5150);
  {
    const pos = seaweedGeo.attributes.position;
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const shade = 0.75 + 0.25 * hashInt3(i, 3, 21);
      col[i * 3] = 0.16 * shade;
      col[i * 3 + 1] = 0.22 * shade;
      col[i * 3 + 2] = 0.09 * shade;
    }
    seaweedGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  const seaweedMaterial = new THREE.MeshStandardMaterial({
    color: 0xd9c9a0,
    vertexColors: true,
    roughness: 0.9,
    metalness: 0.0,
    side: THREE.DoubleSide,
    envMapIntensity: 0.15,
    flatShading: true,
  });
  const seaweedCount = 30;
  const seaweedMesh = new THREE.InstancedMesh(seaweedGeo, seaweedMaterial, seaweedCount);
  seaweedMesh.name = 'seaweed';
  seaweedMesh.receiveShadow = true;
  seaweedMesh.castShadow = false;
  {
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    let placed = 0;
    for (let i = 0; i < seaweedCount * 4 && placed < seaweedCount; i++) {
      const x = -17 + propRng() * 34;
      const z = -5.4 + propRng() * 2.6;
      const h = sandHeight(x, z);
      if (h < -0.18 || h > 0.6) continue;
      const s = 0.3 + propRng() * 0.45;
      dummy.position.set(x, h - 0.02, z);
      dummy.rotation.set(0, propRng() * TAU, (propRng() - 0.5) * 0.2);
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      seaweedMesh.setMatrixAt(placed, dummy.matrix);
      const shade = 0.7 + propRng() * 0.6;
      color.setRGB(shade, shade * 1.05, shade * 0.9);
      seaweedMesh.setColorAt(placed, color);
      placed++;
    }
    seaweedMesh.count = placed;
    seaweedMesh.instanceMatrix.needsUpdate = true;
    if (seaweedMesh.instanceColor) seaweedMesh.instanceColor.needsUpdate = true;
    seaweedMesh.computeBoundingSphere();
  }
  group.add(seaweedMesh);

  // ---- driftwood (merged into one draw call) ----
  const driftwoodMaterial = new THREE.MeshStandardMaterial({
    color: 0xa8927a,
    vertexColors: true,
    flatShading: true,
    roughness: 0.92,
    metalness: 0.0,
    envMapIntensity: 0.38,
  });
  const driftwoodGeos = [];
  {
    const woodRng = mulberry32(31337);
    const woodSpots = [
      { x: -4.9, z: 3.2, ry: 0.4, s: 1.0 },
      { x: 3.6, z: 1.2, ry: 1.9, s: 0.8 },
      { x: -8.2, z: -2.4, ry: 2.6, s: 1.15 },
      { x: 6.4, z: -2.9, ry: 0.9, s: 0.7 },
      { x: -2.2, z: -3.9, ry: 1.2, s: 0.65 },
    ];
    for (let i = 0; i < woodSpots.length; i++) {
      const sp = woodSpots[i];
      const geo = makeDriftwoodGeometry(woodRng);
      geo.rotateY(sp.ry);
      geo.rotateZ((woodRng() - 0.5) * 0.15);
      geo.scale(sp.s, sp.s, sp.s);
      const h = sandHeight(sp.x, sp.z);
      geo.translate(sp.x, h + 0.02, sp.z);
      driftwoodGeos.push(geo);
      shadowPlacements.push({ x: sp.x, z: sp.z, size: 0.6 * sp.s });
    }
  }
  const driftwoodMesh = new THREE.Mesh(mergeGeometries(driftwoodGeos), driftwoodMaterial);
  driftwoodMesh.name = 'driftwood';
  driftwoodMesh.castShadow = true;
  driftwoodMesh.receiveShadow = true;
  group.add(driftwoodMesh);

  // static contact shadows (one instanced draw call)
  if (shadowPlacements.length > 0) {
    const staticShadowMesh = new THREE.InstancedMesh(
      contactShadowGeometry,
      contactShadowMaterial,
      shadowPlacements.length
    );
    staticShadowMesh.name = 'contactShadows';
    staticShadowMesh.renderOrder = 2;
    const dummy = new THREE.Object3D();
    const normal = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const quat = new THREE.Quaternion();
    for (let i = 0; i < shadowPlacements.length; i++) {
      const sp = shadowPlacements[i];
      sandNormal(sp.x, sp.z, normal);
      quat.setFromUnitVectors(up, normal);
      const h = sandHeight(sp.x, sp.z);
      dummy.position.set(sp.x, h + 0.016, sp.z);
      dummy.quaternion.copy(quat);
      dummy.scale.set(sp.size * 2.4, 1, sp.size * 2.4);
      dummy.updateMatrix();
      staticShadowMesh.setMatrixAt(i, dummy.matrix);
    }
    staticShadowMesh.instanceMatrix.needsUpdate = true;
    staticShadowMesh.computeBoundingSphere();
    group.add(staticShadowMesh);
  }

  /* ---------------------------------------------------------------- */
  /* dust motes and sea spray particles                               */
  /* ---------------------------------------------------------------- */

  const particleScale = { value: 260 };

  function makeParticles(count, kind) {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const prng = mulberry32(kind === 'dust' ? 6161 : 7272);
    for (let i = 0; i < count; i++) {
      let x;
      let y;
      let z;
      if (kind === 'dust') {
        x = -17 + prng() * 34;
        z = -5.5 + prng() * 13.0;
        y = sandHeight(x, z) + 0.2 + prng() * prng() * 3.4;
      } else {
        x = -26 + prng() * 52;
        z = -5.5 + prng() * 1.8;
        y = WATER_Y + 0.03 + prng() * 0.1;
      }
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      seeds[i * 3] = prng();
      seeds[i * 3 + 1] = prng();
      seeds[i * 3 + 2] = prng();
      sizes[i] = kind === 'dust' ? 0.03 + prng() * 0.075 : 0.022 + prng() * 0.05;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

    const uniforms = {
      uTime: { value: 0 },
      uWind: { value: st.wind },
      uBrightness: { value: 1 },
      uPointScale: particleScale,
      uColor: { value: kind === 'dust' ? new THREE.Color(0xffcf9a) : new THREE.Color(0xfff2e2) },
    };

    const dustVS = /* glsl */ `
      uniform float uTime;
      uniform float uWind;
      uniform float uPointScale;
      attribute vec3 aSeed;
      attribute float aSize;
      varying float vAlpha;
      void main() {
        vec3 p = position;
        float drift = 0.10 + uWind * 1.15;
        p.x += sin(uTime * 0.37 + aSeed.x * 6.28) * 0.6 + uTime * drift * (0.25 + aSeed.y * 0.5);
        p.y += sin(uTime * 0.63 + aSeed.y * 6.28) * 0.25 + sin(uTime * 0.21 + aSeed.z * 6.28) * 0.15;
        p.z += cos(uTime * 0.29 + aSeed.z * 6.28) * 0.5 + uTime * 0.04 * (aSeed.x - 0.5);
        p.x = mod(p.x + 17.0, 34.0) - 17.0;
        p.z = mod(p.z + 8.0, 18.0) - 8.0;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(aSize * uPointScale / max(1.0, -mv.z), 1.0, 5.0);
        float twinkle = 0.55 + 0.45 * sin(uTime * 2.0 + aSeed.x * 31.0 + aSeed.z * 17.0);
        vAlpha = twinkle;
      }
    `;

    const sprayVS = /* glsl */ `
      uniform float uTime;
      uniform float uWind;
      uniform float uPointScale;
      attribute vec3 aSeed;
      attribute float aSize;
      varying float vAlpha;
      void main() {
        float life = fract(aSeed.x + uTime * (0.085 + aSeed.y * 0.075));
        vec3 p = position;
        p.y += life * (0.22 + aSeed.y * 0.95);
        float drift = 0.45 + 1.7 * uWind;
        p.x += life * life * drift * (aSeed.z - 0.5) * 2.0;
        p.z += life * 0.45 * (aSeed.y - 0.5);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(aSize * uPointScale / max(1.0, -mv.z) * (1.0 + life * 1.2), 1.0, 4.0);
        vAlpha = sin(life * 3.14159) * (0.45 + 0.55 * aSeed.z);
      }
    `;

    const particleFS = /* glsl */ `
      precision highp float;
      uniform vec3 uColor;
      uniform float uBrightness;
      varying float vAlpha;
      void main() {
        vec2 c = gl_PointCoord - vec2(0.5);
        float d = length(c);
        float a = smoothstep(0.5, 0.05, d);
        gl_FragColor = vec4(uColor * mix(0.7, 1.2, uBrightness), a * vAlpha * 0.5);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `;

    const material = new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      toneMapped: true,
      fog: false,
      vertexShader: kind === 'dust' ? dustVS : sprayVS,
      fragmentShader: particleFS,
    });
    const points = new THREE.Points(geo, material);
    points.frustumCulled = false;
    points.renderOrder = 4;
    return { points, uniforms };
  }

  const dust = makeParticles(Q.dust, 'dust');
  dust.points.name = 'dustMotes';
  group.add(dust.points);
  env.dust = dust.points;
  env.dustUniforms = dust.uniforms;

  const spray = makeParticles(Q.spray, 'spray');
  spray.points.name = 'seaSpray';
  group.add(spray.points);
  env.spray = spray.points;
  env.sprayUniforms = spray.uniforms;

  /* ---------------------------------------------------------------- */
  /* environment map (PMREM from a procedural equirect sky)           */
  /* ---------------------------------------------------------------- */

  let pmremGenerator = null;
  let envRenderTarget = null;
  let envMap = null;
  let envDirty = true;
  let envReady = false;
  let lastEnvBuild = -1000;

  function rebuildEnvMap(force) {
    if (!renderer) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!force && now - lastEnvBuild < 80) return;
    lastEnvBuild = now;
    if (!pmremGenerator) pmremGenerator = new THREE.PMREMGenerator(renderer);
    const canvas = buildSkyEquirectCanvas(palette, Q.envTex, Math.round(Q.envTex * 0.5));
    const texture = new THREE.CanvasTexture(canvas);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    const rt = pmremGenerator.fromEquirectangular(texture);
    texture.dispose();
    if (envRenderTarget) envRenderTarget.dispose();
    envRenderTarget = rt;
    envMap = rt.texture;
    if (scene) scene.environment = envMap;
    env.envMap = envMap;
    envDirty = false;
    envReady = true;
  }

  /* ---------------------------------------------------------------- */
  /* raycast targets                                                  */
  /* ---------------------------------------------------------------- */

  const raycastTargets = [terrain, ocean, rocksMesh, birdsMesh, ...env.lighthouse.hitObjects];
  env.raycastTargets = raycastTargets;

  /* ---------------------------------------------------------------- */
  /* public setters                                                   */
  /* ---------------------------------------------------------------- */

  const lastApplied = {
    sunset: st.sunset,
    brightness: st.brightness,
    wind: st.wind,
    dust: st.dust,
    spray: st.spray,
    lighthouse: st.lighthouse,
  };

  function applyBrightness(value) {
    const b = clamp(typeof value === 'number' ? value : 1, 0.2, 2.5);
    st.brightness = b;
    lastApplied.brightness = b;
    sunLight.intensity = palette.sunIntensity * b;
    hemiLight.intensity = palette.hemiIntensity * (0.4 + 0.6 * b);
    fillLight.intensity = palette.fillIntensity * b;
    bounceLight.intensity = 0.85 * (0.45 + 0.55 * b);
    skyUniforms.uBrightness.value = b;
    oceanUniforms.uBrightness.value = b;
    dust.uniforms.uBrightness.value = b;
    spray.uniforms.uBrightness.value = b;
    if (scene && 'environmentIntensity' in scene) {
      scene.environmentIntensity = palette.envIntensity * (0.55 + 0.45 * b);
    }
  }

  function applySunset(value) {
    const t = clamp(typeof value === 'number' ? value : 0.45, 0, 1);
    st.sunset = t;
    lastApplied.sunset = t;
    samplePalette(t, palette);

    skyUniforms.uZenith.value.copy(palette.zenith);
    skyUniforms.uMid.value.copy(palette.mid);
    skyUniforms.uHorizon.value.copy(palette.horizon);
    skyUniforms.uHaze.value.copy(palette.haze);
    skyUniforms.uSunColor.value.copy(palette.sun);
    skyUniforms.uCloudDark.value.copy(palette.cloudDark);
    skyUniforms.uCloudLit.value.copy(palette.cloudLit);
    skyUniforms.uSunset.value = t;

    sunLight.color.copy(palette.sunLightCol);
    hemiLight.color.copy(palette.hemiSky);
    hemiLight.groundColor.copy(palette.hemiGround);
    fog.color.copy(palette.fog);

    oceanUniforms.uDeep.value.copy(palette.deep);
    oceanUniforms.uMid.value.copy(palette.oceanMid);
    oceanUniforms.uTeal.value.copy(palette.oceanTeal);
    oceanUniforms.uShallow.value.copy(palette.oceanShallow);
    oceanUniforms.uFoam.value.copy(palette.foam);
    oceanUniforms.uSunColor.value.copy(palette.sun);
    oceanUniforms.uHaze.value.copy(palette.haze);
    oceanUniforms.uReflectSky.value.copy(palette.reflectSky);
    oceanUniforms.uSunset.value = t;

    ridgeMaterial.color.copy(palette.ridge);

    dust.uniforms.uColor.value.copy(palette.sun).lerp(scratchColor.set(0xfff0da), 0.45);
    spray.uniforms.uColor.value.copy(palette.foam);

    applyBrightness(st.brightness);
    envDirty = true;
    if (envReady) rebuildEnvMap(false);
  }

  function setWind(value) {
    const w = clamp(typeof value === 'number' ? value : 0.25, 0, 1);
    st.wind = w;
    lastApplied.wind = w;
    oceanUniforms.uWind.value = w;
    skyUniforms.uWind.value = w;
    dust.uniforms.uWind.value = w;
    spray.uniforms.uWind.value = w;
  }

  function setDustEnabled(on) {
    const enabled = !!on;
    st.dust = enabled;
    lastApplied.dust = enabled;
    dust.points.visible = enabled;
  }

  function setSprayEnabled(on) {
    const enabled = !!on;
    st.spray = enabled;
    lastApplied.spray = enabled;
    spray.points.visible = enabled;
  }

  function setLighthouse(on) {
    const enabled = !!on;
    st.lighthouse = enabled;
    lastApplied.lighthouse = enabled;
    env.lighthouse.setEnabled(enabled);
  }

  /* ---------------------------------------------------------------- */
  /* user props: addProp / undoProp / resetProps                      */
  /* ---------------------------------------------------------------- */

  const addedProps = [];
  const propRng2 = mulberry32(86420);
  const propRockMat = new THREE.MeshStandardMaterial({
    color: 0x8b7768,
    flatShading: true,
    roughness: 0.85,
    metalness: 0.02,
    envMapIntensity: 0.45,
  });
  const propShellMat = new THREE.MeshStandardMaterial({
    color: 0xffd9b0,
    flatShading: true,
    roughness: 0.82,
    metalness: 0.0,
    side: THREE.DoubleSide,
    envMapIntensity: 0.28,
  });
  const propWeedMat = new THREE.MeshStandardMaterial({
    color: 0x7a7a4a,
    flatShading: true,
    roughness: 0.85,
    metalness: 0.0,
    side: THREE.DoubleSide,
    envMapIntensity: 0.35,
  });
  const propUp = new THREE.Vector3(0, 1, 0);
  const propNormal = new THREE.Vector3();

  function addProp(kind, worldPoint) {
    if (!worldPoint || addedProps.length > 96) return null;
    const x = typeof worldPoint.x === 'number' ? worldPoint.x : 0;
    const z = typeof worldPoint.z === 'number' ? worldPoint.z : 0;
    if (!isFinite(x) || !isFinite(z)) return null;
    if (kind !== 'rock' && kind !== 'shell' && kind !== 'seaweed') return null;
    if (x < -24 || x > 24 || z < -8 || z > 14) return null;
    const y = sandHeight(x, z);
    const propGroup = new THREE.Group();
    propGroup.position.set(x, y, z);
    propGroup.rotation.y = propRng2() * TAU;
    let mesh = null;
    if (kind === 'shell') {
      const geometry = makeShellGeometry(Math.floor(propRng2() * 100000));
      mesh = new THREE.Mesh(geometry, propShellMat);
      const s = 0.14 + propRng2() * 0.12;
      propGroup.scale.setScalar(s);
      propGroup.position.y = y + 0.01;
    } else if (kind === 'seaweed') {
      const geometry = makeSeaweedGeometry(Math.floor(propRng2() * 100000));
      mesh = new THREE.Mesh(geometry, propWeedMat);
      const s = 0.3 + propRng2() * 0.3;
      propGroup.scale.setScalar(s);
      propGroup.position.y = y - 0.02;
    } else {
      const geometry = makeRockGeometry(
        propRng2,
        0.22 + propRng2() * 0.18,
        0.16 + propRng2() * 0.16,
        0.2 + propRng2() * 0.16,
        1,
        0.4
      );
      mesh = new THREE.Mesh(geometry, propRockMat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
    mesh.userData.propKind = kind;
    mesh.userData.tempGeometry = true;
    propGroup.add(mesh);

    const shadow = new THREE.Mesh(contactShadowGeometry, contactShadowMaterial);
    const shadowScale = kind === 'rock' ? 0.7 : 0.4;
    sandNormal(x, z, propNormal);
    shadow.quaternion.setFromUnitVectors(propUp, propNormal);
    shadow.position.y = 0.018;
    shadow.scale.set(shadowScale * 2.2, 1, shadowScale * 2.2);
    shadow.renderOrder = 2;
    propGroup.add(shadow);

    group.add(propGroup);
    addedProps.push(propGroup);
    raycastTargets.push(mesh);
    sunLight.shadow.needsUpdate = true;
    return propGroup;
  }

  function undoProp() {
    const prop = addedProps.pop();
    if (!prop) return false;
    group.remove(prop);
    sunLight.shadow.needsUpdate = true;
    for (let i = 0; i < prop.children.length; i++) {
      const child = prop.children[i];
      const idx = raycastTargets.indexOf(child);
      if (idx >= 0) raycastTargets.splice(idx, 1);
      if (child.userData && child.userData.tempGeometry && child.geometry) child.geometry.dispose();
    }
    return true;
  }

  function resetProps() {
    while (addedProps.length > 0) undoProp();
  }

  /* ---------------------------------------------------------------- */
  /* per-frame update                                                 */
  /* ---------------------------------------------------------------- */

  function update(time, delta, stateRef) {
    const t = typeof time === 'number' ? time : 0;
    const s = stateRef || null;

    if (s) {
      if (typeof s.sunset === 'number' && Math.abs(s.sunset - lastApplied.sunset) > 1e-4) applySunset(s.sunset);
      if (typeof s.brightness === 'number' && Math.abs(s.brightness - lastApplied.brightness) > 1e-4) {
        applyBrightness(s.brightness);
      }
      if (typeof s.wind === 'number' && Math.abs(s.wind - lastApplied.wind) > 1e-4) setWind(s.wind);
      if (typeof s.dust === 'boolean' && s.dust !== lastApplied.dust) setDustEnabled(s.dust);
      if (typeof s.spray === 'boolean' && s.spray !== lastApplied.spray) setSprayEnabled(s.spray);
      if (typeof s.lighthouse === 'boolean' && s.lighthouse !== lastApplied.lighthouse) {
        setLighthouse(s.lighthouse);
      }
    }

    oceanUniforms.uTime.value = t;
    oceanUniforms.uWind.value = st.wind;
    skyUniforms.uTime.value = t;
    skyUniforms.uWind.value = st.wind;

    env.lighthouse.update(t, delta || 0);

    dust.uniforms.uTime.value = t;
    spray.uniforms.uTime.value = t;

    if (renderer) {
      renderer.getDrawingBufferSize(sizeScratch);
      particleScale.value = sizeScratch.y * 0.62;
    }

    if (birdsMesh) {
      birdsMesh.position.x = Math.sin(t * 0.045) * 3.2;
      birdsMesh.position.y = Math.sin(t * 0.11 + 1.4) * 0.35;
    }

    if (envDirty) rebuildEnvMap(false);
  }

  env.update = update;
  env.applySunset = applySunset;
  env.applyBrightness = applyBrightness;
  env.setWind = setWind;
  env.setDustEnabled = setDustEnabled;
  env.setSprayEnabled = setSprayEnabled;
  env.setLighthouse = setLighthouse;
  env.addProp = addProp;
  env.undoProp = undoProp;
  env.resetProps = resetProps;
  // The sun shadow map is baked once (static exterior). Call this after adding
  // shadow casters that were not in the scene on the first rendered frame.
  env.refreshShadows = function refreshShadows() {
    sunLight.shadow.needsUpdate = true;
  };

  /* ---------------------------------------------------------------- */
  /* dispose                                                          */
  /* ---------------------------------------------------------------- */

  function dispose() {
    if (scene) {
      if (scene.environment === envMap) scene.environment = null;
      if (scene.fog === fog) scene.fog = null;
    }
    if (group.parent) group.parent.remove(group);
    const disposedGeometries = new Set();
    const disposedMaterials = new Set();
    const disposedTextures = new Set();
    group.traverse((obj) => {
      if (obj.geometry && !disposedGeometries.has(obj.geometry)) {
        disposedGeometries.add(obj.geometry);
        obj.geometry.dispose();
      }
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (let i = 0; i < mats.length; i++) {
          const mat = mats[i];
          if (!mat || disposedMaterials.has(mat)) continue;
          disposedMaterials.add(mat);
          for (const key in mat) {
            const value = mat[key];
            if (value && value.isTexture && !disposedTextures.has(value)) {
              disposedTextures.add(value);
              value.dispose();
            }
          }
          mat.dispose();
        }
      }
    });
    if (envRenderTarget) {
      envRenderTarget.dispose();
      envRenderTarget = null;
    }
    if (pmremGenerator) {
      pmremGenerator.dispose();
      pmremGenerator = null;
    }
    raycastTargets.length = 0;
    addedProps.length = 0;
    env.envMap = null;
  }

  env.dispose = dispose;

  /* ---------------------------------------------------------------- */
  /* initialise                                                       */
  /* ---------------------------------------------------------------- */

  applySunset(st.sunset);
  applyBrightness(st.brightness);
  setWind(st.wind);
  setDustEnabled(st.dust);
  setSprayEnabled(st.spray);
  setLighthouse(st.lighthouse);
  rebuildEnvMap(true);

  return env;
}

export default createEnvironment;
