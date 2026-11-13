import * as THREE from 'three';

const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const DEG = Math.PI / 180;

function makeWoodTexture() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0, '#794b2e');
  grad.addColorStop(0.45, '#5c3924');
  grad.addColorStop(1, '#402519');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  let seed = 1201;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < 90; i++) {
    const x = rand() * size;
    ctx.strokeStyle = rand() > 0.5 ? 'rgba(30,14,8,0.26)' : 'rgba(208,150,94,0.15)';
    ctx.lineWidth = 0.5 + rand() * 1.4;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.bezierCurveTo(x + rand() * 9 - 4, size * 0.33, x + rand() * 11 - 5, size * 0.66, x + rand() * 8 - 4, size);
    ctx.stroke();
  }
  for (let i = 0; i < 8; i++) {
    ctx.strokeStyle = 'rgba(20,10,5,0.5)';
    ctx.lineWidth = 1.2;
    const y = (i + 0.5) * (size / 8);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

function makeDeckTexture() {
  const w = 256;
  const h = 128;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#8b5a35';
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 16; i++) {
    ctx.fillStyle = i % 2 === 0 ? 'rgba(244,203,139,0.08)' : 'rgba(37,20,10,0.08)';
    ctx.fillRect(0, i * 8, w, 7);
    ctx.fillStyle = 'rgba(35,18,9,0.52)';
    ctx.fillRect(0, i * 8 + 7, w, 1);
  }
  for (let i = 0; i < 80; i++) {
    ctx.fillStyle = 'rgba(36,20,10,0.18)';
    ctx.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 4, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2.6, 1.6);
  tex.anisotropy = 4;
  return tex;
}

function makeSailTexture() {
  const w = 256;
  const h = 256;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, '#f2e3bf');
  grad.addColorStop(0.5, '#e1cda4');
  grad.addColorStop(1, '#cdb589');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  // Cloth panels.
  for (let i = 1; i < 8; i++) {
    ctx.strokeStyle = 'rgba(116,88,55,0.28)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo((i * w) / 8, 0);
    ctx.lineTo((i * w) / 8, h);
    ctx.stroke();
  }
  for (let i = 0; i < 4; i++) {
    ctx.strokeStyle = 'rgba(125,96,61,0.35)';
    ctx.lineWidth = 2;
    const y = 22 + i * 62;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= w; x += 16) ctx.lineTo(x, y + Math.sin(x * 0.04 + i) * 1.7);
    ctx.stroke();
  }
  let seed = 27;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < 220; i++) {
    ctx.fillStyle = rand() > 0.5 ? 'rgba(94,66,35,0.06)' : 'rgba(255,248,224,0.08)';
    ctx.fillRect(rand() * w, rand() * h, 1 + rand() * 3, 1 + rand() * 2);
  }
  // A restrained painted ochre emblem on the main cloth.
  ctx.strokeStyle = 'rgba(147,67,42,0.26)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(w * 0.52, h * 0.42, 28, 0.2, Math.PI * 1.7);
  ctx.stroke();
  // Dark stitched hem keeps the squares legible against the bright sky.
  ctx.strokeStyle = 'rgba(63,45,26,0.62)';
  ctx.lineWidth = 5;
  ctx.strokeRect(3, 3, w - 6, h - 6);
  ctx.strokeStyle = 'rgba(238,225,196,0.22)';
  ctx.lineWidth = 2;
  ctx.strokeRect(8, 8, w - 16, h - 16);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function cylinderBetween(a, b, r1, r2, material, segments = 6) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const geo = new THREE.CylinderGeometry(r2, r1, len, segments, 1, false);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function makeSailGeometry(width, height, bulge = 0.045) {
  const geo = new THREE.PlaneGeometry(width, height, 10, 8);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const u = x / width + 0.5;
    const v = y / height + 0.5;
    const billow = Math.sin(u * Math.PI) * Math.sin(v * Math.PI * 0.92 + 0.12);
    const folds = Math.sin(u * Math.PI * 5.0 + v * 1.3) * 0.0045;
    pos.setZ(i, billow * bulge + folds);
    // A little sag along the bottom edge.
    pos.setX(i, x + Math.sin(v * Math.PI) * 0.008 * Math.sin(u * 7.0));
  }
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const u = x / width + 0.5;
    const v = y / height + 0.5;
    const shade = 0.72 + 0.25 * Math.sin(u * Math.PI) * (0.55 + 0.45 * Math.sin(v * Math.PI)) + 0.03 * Math.sin(v * Math.PI * 3.0);
    colors[i * 3] = shade;
    colors[i * 3 + 1] = shade;
    colors[i * 3 + 2] = shade;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

function buildHull(parent, woodMat, deckMat, trimMat) {
  const N = 14;
  const ringPoints = 9;
  const verts = [];
  const indices = [];
  const stations = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const x = lerp(-0.64, 0.64, t);
    const bow = Math.pow(t, 2.15);
    const stern = Math.pow(1 - t, 3.2);
    const beam = 0.19 * (0.48 + Math.sin(Math.pow(t, 0.8) * Math.PI) * 0.78) * (1 - bow * 0.72);
    const deckY = 0.055 + 0.045 * Math.pow(t, 1.5) + 0.045 * Math.pow(1 - t, 2.2) - 0.035;
    const keelY = -0.095 - 0.06 * Math.sin(Math.pow(t, 0.85) * Math.PI) - 0.02 * (1 - t) + bow * 0.045;
    const midY = keelY * 0.52;
    const wTop = beam;
    const wWater = beam * 1.02;
    const wLow = beam * 0.58;
    const ring = [
      [x, deckY, wTop],
      [x, deckY - 0.045, wWater],
      [x, 0.012, wWater],
      [x, midY, wLow],
      [x, keelY, 0],
      [x, midY, -wLow],
      [x, 0.012, -wWater],
      [x, deckY - 0.045, -wWater],
      [x, deckY, -wTop]
    ];
    ring.forEach((p) => verts.push(p[0], p[1], p[2]));
    stations.push(ring);
  }
  for (let i = 0; i < N - 1; i++) {
    for (let j = 0; j < ringPoints - 1; j++) {
      const a = i * ringPoints + j;
      const b = (i + 1) * ringPoints + j;
      const c = b + 1;
      const d = a + 1;
      indices.push(a, b, d, b, c, d);
    }
  }
  const hullGeo = new THREE.BufferGeometry();
  hullGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  hullGeo.setIndex(indices);
  hullGeo.computeVertexNormals();
  const hull = new THREE.Mesh(hullGeo, woodMat);
  hull.name = 'ShipHull';
  hull.castShadow = true;
  hull.receiveShadow = true;
  parent.add(hull);

  // Deck with camber and a few plank battens.
  const deckVerts = [];
  const deckUVs = [];
  const deckIndices = [];
  for (let i = 0; i < N; i++) {
    const ring = stations[i];
    const x = ring[0][0];
    const topY = ring[0][1];
    const beam = Math.max(0.01, ring[0][2] * 0.955);
    for (let k = 0; k <= 4; k++) {
      const u = k / 4;
      const z = lerp(beam, -beam, u);
      const camber = Math.sin(u * Math.PI) * 0.014;
      deckVerts.push(x, topY - 0.012 + camber, z);
      deckUVs.push(u, i / (N - 1));
    }
  }
  for (let i = 0; i < N - 1; i++) {
    for (let k = 0; k < 4; k++) {
      const a = i * 5 + k;
      const b = (i + 1) * 5 + k;
      deckIndices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const deckGeo = new THREE.BufferGeometry();
  deckGeo.setAttribute('position', new THREE.Float32BufferAttribute(deckVerts, 3));
  deckGeo.setAttribute('uv', new THREE.Float32BufferAttribute(deckUVs, 2));
  deckGeo.setIndex(deckIndices);
  deckGeo.computeVertexNormals();
  const deck = new THREE.Mesh(deckGeo, deckMat);
  deck.name = 'ShipDeck';
  deck.receiveShadow = true;
  parent.add(deck);

  // Raised gunwale rails.
  for (const side of [1, -1]) {
    const pts = [];
    for (let i = 0; i < N; i++) {
      const ring = stations[i];
      pts.push(new THREE.Vector3(ring[8][0], ring[8][1] + 0.012, ring[8][2] * 0.985));
    }
    if (side < 0) pts.reverse();
    const curve = new THREE.CatmullRomCurve3(pts);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.0105, 5, false), trimMat);
    tube.name = side > 0 ? 'GunwalePort' : 'GunwaleStarboard';
    tube.castShadow = true;
    parent.add(tube);
  }

  // Ochre sheer stripe just under the rail on both sides.
  for (const side of [1, -1]) {
    const stripeVerts = [];
    const stripeIndices = [];
    for (let i = 0; i < N; i++) {
      const ring = stations[i];
      const x = ring[0][0];
      const y = ring[0][1] - 0.055;
      const z = side * ring[0][2] * 1.012;
      stripeVerts.push(x, y + 0.011, z, x, y - 0.011, z);
      if (i < N - 1) {
        const a = i * 2;
        stripeIndices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(stripeVerts, 3));
    geo.setIndex(stripeIndices);
    geo.computeVertexNormals();
    const stripe = new THREE.Mesh(geo, trimMat);
    stripe.material.side = THREE.DoubleSide;
    parent.add(stripe);
  }

  // Keel and stem.
  const keelPts = [
    new THREE.Vector3(-0.63, -0.13, 0),
    new THREE.Vector3(-0.2, -0.19, 0),
    new THREE.Vector3(0.25, -0.17, 0),
    new THREE.Vector3(0.61, -0.08, 0)
  ];
  const keel = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(keelPts), 16, 0.012, 4, false), woodMat);
  parent.add(keel);

  // Stern castle/deckhouse.
  const castleMat = woodMat.clone();
  castleMat.color = new THREE.Color(0x4d2d1c);
  const castle = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.15, 0.30), castleMat);
  castle.position.set(-0.47, 0.105, 0);
  castle.castShadow = true;
  castle.receiveShadow = true;
  parent.add(castle);
  const castleRoof = new THREE.Mesh(new THREE.BoxGeometry(0.255, 0.018, 0.34), trimMat);
  castleRoof.position.set(-0.47, 0.187, 0);
  parent.add(castleRoof);

  // Warm stern windows.
  const windowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffb65c).convertSRGBToLinear() });
  for (let i = 0; i < 3; i++) {
    const win = new THREE.Mesh(new THREE.PlaneGeometry(0.032, 0.035), windowMat);
    win.position.set(-0.55 + i * 0.06, 0.12, 0.153);
    win.rotation.y = -0.12;
    parent.add(win);
  }

  // A row of small dark gunports on the port side.
  const portMat = new THREE.MeshStandardMaterial({ color: 0x23140c, roughness: 0.9 });
  for (let i = 0; i < 4; i++) {
    const port = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.022, 0.005), portMat);
    port.position.set(-0.34 + i * 0.18, -0.015, 0.192);
    parent.add(port);
  }

  return { hull, deck, stations };
}

function addMastShip(parent, mastX, height, mat, sailMat, trimMat) {
  const group = new THREE.Group();
  group.position.set(mastX, 0.065, 0);
  parent.add(group);

  const mast = cylinderBetween(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, height, 0),
    0.013,
    0.0065,
    mat,
    7
  );
  group.add(mast);

  // Crow's nest ring.
  const nest = new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.004, 5, 12), trimMat);
  nest.rotation.x = Math.PI / 2;
  nest.position.y = height * 0.79;
  group.add(nest);

  const sails = [];
  const tierDefs = height > 0.68
    ? [
        { y: height * 0.45, w: 0.46 + height * 0.15, h: 0.25 + height * 0.10, bulge: 0.05 },
        { y: height * 0.71, w: 0.32 + height * 0.08, h: 0.17 + height * 0.06, bulge: 0.036 },
        { y: height * 0.87, w: 0.22, h: 0.12, bulge: 0.028 }
      ]
    : [
        { y: height * 0.44, w: 0.4, h: 0.24, bulge: 0.045 },
        { y: height * 0.72, w: 0.29, h: 0.16, bulge: 0.032 }
      ];

  tierDefs.forEach((def, idx) => {
    const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, def.w * 1.08, 5), mat);
    yard.rotation.z = Math.PI / 2;
    yard.position.set(0, def.y, 0);
    yard.castShadow = true;
    group.add(yard);

    const pivot = new THREE.Group();
    pivot.position.set(0, def.y, 0.012);
    group.add(pivot);
    const geo = makeSailGeometry(def.w, def.h, def.bulge);
    const sail = new THREE.Mesh(geo, sailMat);
    sail.position.set(0, -def.h / 2, 0);
    sail.castShadow = true;
    sail.receiveShadow = true;
    pivot.add(sail);
    sails.push({ pivot, base: 0, phase: mastX * 12 + idx * 1.7, index: idx });
  });

  return { group, height, sails, mastX };
}

export function createBoat({ scene, waveField, state, bottle }) {
  const root = new THREE.Group();
  root.name = 'Sailboat';
  scene.add(root);

  const model = new THREE.Group();
  model.name = 'SailboatModel';
  model.position.y = 0.032;
  root.add(model);

  const woodTexture = makeWoodTexture();
  const deckTexture = makeDeckTexture();
  const sailTexture = makeSailTexture();

  const woodMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x8a5a37),
    map: woodTexture,
    roughness: 0.72,
    metalness: 0.04
  });
  // The deck and hull share the texture, but the hull is intentionally darker.
  woodMat.color = new THREE.Color(0x8a5a37);
  const deckMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xb07c4b),
    map: deckTexture,
    roughness: 0.82,
    metalness: 0.0
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xd0a157),
    roughness: 0.45,
    metalness: 0.35
  });
  const sailMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xd3c5a7),
    map: sailTexture,
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
    side: THREE.DoubleSide
  });

  const hullParts = buildHull(model, woodMat, deckMat, trimMat);

  // Bowsprit and figurehead.
  const bowsprit = cylinderBetween(
    new THREE.Vector3(0.58, 0.12, 0),
    new THREE.Vector3(1.04, 0.29, 0),
    0.012,
    0.0045,
    woodMat,
    6
  );
  model.add(bowsprit);
  const spritStay = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(1.03, 0.28, 0),
      new THREE.Vector3(0.37, 0.7, 0)
    ]),
    new THREE.LineBasicMaterial({ color: 0xe0cda6, transparent: true, opacity: 0.62 })
  );
  model.add(spritStay);

  const masts = [
    addMastShip(model, -0.34, 0.58, woodMat, sailMat, trimMat),
    addMastShip(model, 0.03, 0.8, woodMat, sailMat, trimMat),
    addMastShip(model, 0.37, 0.62, woodMat, sailMat, trimMat)
  ];

  // Yards, rigging and flags.
  const rigPoints = [];
  const mizzenTop = new THREE.Vector3(-0.34, 0.65, 0);
  const mainTop = new THREE.Vector3(0.03, 0.87, 0);
  const foreTop = new THREE.Vector3(0.37, 0.69, 0);
  const spritTip = new THREE.Vector3(1.03, 0.28, 0);
  rigPoints.push(
    spritTip, foreTop,
    foreTop, mainTop,
    mainTop, mizzenTop,
    new THREE.Vector3(-0.6, 0.1, 0), mizzenTop,
    new THREE.Vector3(0.6, 0.12, 0), foreTop
  );
  masts.forEach((m, index) => {
    const top = new THREE.Vector3(m.mastX, m.height + 0.065, 0);
    for (const side of [-1, 1]) {
      rigPoints.push(
        top,
        new THREE.Vector3(m.mastX + 0.09, 0.065, side * 0.135),
        top,
        new THREE.Vector3(m.mastX - 0.13, 0.09, side * 0.15),
        top,
        new THREE.Vector3(m.mastX + 0.02, 0.09, side * 0.165)
      );
    }
    rigPoints.push(
      new THREE.Vector3(m.mastX, 0.23, 0),
      new THREE.Vector3(m.mastX + 0.26, 0.15, 0.16)
    );
  });
  rigPoints.push(
    new THREE.Vector3(0.03, 0.4, 0),
    new THREE.Vector3(0.17, 0.18, 0.18),
    new THREE.Vector3(-0.34, 0.33, 0),
    new THREE.Vector3(-0.5, 0.18, -0.15)
  );
  const rigGeo = new THREE.BufferGeometry().setFromPoints(rigPoints);
  const rigMat = new THREE.LineBasicMaterial({ color: 0xd7c098, transparent: true, opacity: 0.38, depthWrite: false });
  const rigging = new THREE.LineSegments(rigGeo, rigMat);
  rigging.name = 'ShipRigging';
  model.add(rigging);

  const flagMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0xa84032).convertSRGBToLinear(),
    side: THREE.DoubleSide
  });
  const flags = [];
  const flagPositions = [
    [0.37, 0.7, 0.0, 0.11, 0.05],
    [0.03, 0.86, 0.0, 0.12, 0.055],
    [-0.34, 0.65, 0.0, 0.09, 0.045]
  ];
  flagPositions.forEach(([x, y, z, len, hgt], idx) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0.004,
      0, -hgt, 0.004,
      len, -hgt * 0.45, 0.004
    ], 3));
    geo.setIndex([0, 1, 2]);
    geo.computeVertexNormals();
    const flag = new THREE.Mesh(geo, flagMat);
    flag.position.set(x, y, z);
    flag.userData.phase = idx * 1.7;
    model.add(flag);
    flags.push(flag);
  });

  // Stern lantern.
  const lanternMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffb65f).convertSRGBToLinear() });
  const lantern = new THREE.Mesh(new THREE.OctahedronGeometry(0.022, 0), lanternMat);
  lantern.position.set(-0.61, 0.28, 0);
  model.add(lantern);
  const lanternGlow = new THREE.PointLight(0xffa755, 0.35, 0.8, 2);
  lanternGlow.position.copy(lantern.position);
  lanternGlow.castShadow = false;
  model.add(lanternGlow);

  const base = new THREE.Vector3(-0.32, 0, 0.04);
  const baseYaw = 0.115;
  const initialWater = waveField.heightAt(base.x, base.z);
  root.position.set(base.x, initialWater + 0.025, base.z);
  root.rotation.order = 'YXZ';
  root.rotation.set(0, baseYaw, 0);

  const body = {
    y: root.position.y,
    vy: 0,
    pitch: 0,
    pitchVel: 0,
    roll: 0,
    rollVel: 0,
    yaw: baseYaw,
    driftX: 0,
    driftZ: 0,
    baseY: initialWater + 0.025
  };
  const qYaw = new THREE.Quaternion();
  const qPitch = new THREE.Quaternion();
  const qRoll = new THREE.Quaternion();
  const axisY = new THREE.Vector3(0, 1, 0);
  const axisZ = new THREE.Vector3(0, 0, 1);
  const axisX = new THREE.Vector3(1, 0, 0);
  const samplePoints = {
    bow: [0.62, 0],
    stern: [-0.62, 0],
    port: [0, 0.19],
    starboard: [0, -0.19],
    center: [0, 0]
  };
  const lastSamples = {};
  let timeAccum = 0;

  function rotateLocal(lx, lz) {
    const c = Math.cos(body.yaw);
    const s = Math.sin(body.yaw);
    return [c * lx + s * lz, -s * lx + c * lz];
  }

  function sampleWater(time) {
    const offsets = {};
    for (const [key, [lx, lz]] of Object.entries(samplePoints)) {
      const [wx, wz] = rotateLocal(lx, lz);
      const x = base.x + body.driftX + wx;
      const z = base.z + body.driftZ + wz;
      offsets[key] = { x, z, sample: waveField.sample(x, z, time) };
    }
    return offsets;
  }

  function update(dt, time, state) {
    timeAccum = time;
    const response = clamp(state.boatResponse / 100, 0, 1);
    const dampingParam = clamp(state.boatDamping / 100, 0, 1);
    const wind = clamp(state.wind / 100, 0, 1);

    // Gentle wind-driven drift trend, kept inside a safe central pocket.
    const driftAmp = 0.095 * wind;
    const targetDriftX = Math.sin(time * 0.34 + 0.7) * driftAmp;
    const targetDriftZ = Math.cos(time * 0.27 + 1.8) * driftAmp * 0.55;
    body.driftX += (targetDriftX - body.driftX) * Math.min(1, dt * 0.8);
    body.driftZ += (targetDriftZ - body.driftZ) * Math.min(1, dt * 0.7);

    if (state.waveSpeed < 0.05) return;
    const samples = sampleWater(time);
    lastSamples.bow = samples.bow.sample;
    lastSamples.stern = samples.stern.sample;
    lastSamples.port = samples.port.sample;
    lastSamples.starboard = samples.starboard.sample;
    lastSamples.center = samples.center.sample;

    const avg = (
      samples.center.sample.height +
      samples.bow.sample.height +
      samples.stern.sample.height +
      samples.port.sample.height +
      samples.starboard.sample.height
    ) / 5;
    // Heave is driven by the water directly under the hull. Averaging all five
    // probes would cancel short waves and make the ship look unnaturally glued.
    const heaveResponse = clamp(response * 1.55, 0, 1.6);
    const heaveSample = samples.center.sample.height;
    const calmBase = waveField.baseLevel + 0.025;
    const targetY = calmBase + (heaveSample - waveField.baseLevel) * heaveResponse;
    const pitchFromWaves = Math.atan2(
      samples.bow.sample.height - samples.stern.sample.height,
      1.24
    );
    const rollFromWaves = Math.atan2(
      samples.starboard.sample.height - samples.port.sample.height,
      0.38
    );
    const targetPitch = clamp(pitchFromWaves * 5.2 * response, -0.28, 0.28);
    const targetRoll = clamp(rollFromWaves * 0.95 * response, -0.29, 0.29);

    const ySpring = 18 + 10 * (1 - response);
    const yDamp = 2 * lerp(0.82, 0.26, dampingParam) * Math.sqrt(ySpring);
    const aSpring = 11 + 8 * (1 - response);
    const aDamp = 2 * lerp(0.9, 0.32, dampingParam) * Math.sqrt(aSpring);

    // Substep integration keeps the spring stable at low and uneven frame rates.
    const steps = Math.max(1, Math.min(4, Math.ceil(dt / 0.016)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      body.vy += ((targetY - body.y) * ySpring - body.vy * yDamp) * h;
      body.y += body.vy * h;
      body.pitchVel += ((targetPitch - body.pitch) * aSpring - body.pitchVel * aDamp) * h;
      body.pitch += body.pitchVel * h;
      body.rollVel += ((targetRoll - body.roll) * aSpring - body.rollVel * aDamp) * h;
      body.roll += body.rollVel * h;
    }

    body.y = clamp(body.y, waveField.baseLevel - 0.1, waveField.baseLevel + 0.24);
    body.pitch = clamp(body.pitch, -0.25, 0.25);
    body.roll = clamp(body.roll, -0.32, 0.32);

    root.position.set(base.x + body.driftX, body.y, base.z + body.driftZ);
    applyPoseQuaternion();

    // Hard safety net: the bottle's safe range should already prevent clipping,
    // but extreme combinations must never let a mast pierce the glass.
    if (!validateContainment()) {
      let attempts = 0;
      while (!validateContainment() && attempts < 36) {
        body.y -= 0.0035;
        root.position.y = body.y;
        attempts++;
      }
      if (!validateContainment()) {
        body.roll *= 0.9;
        body.pitch *= 0.9;
        applyPoseQuaternion();
        validateContainment();
      }
    }

    // Sail flutter and flags ride on the same managed simulation clock.
    if (!state.paused) {
      model.children.forEach((child) => {
        if (child.isMesh && child.userData.phase !== undefined) {
          child.rotation.y = Math.sin(time * 1.9 + child.userData.phase) * (0.04 + wind * 0.18);
          child.rotation.z = Math.sin(time * 2.6 + child.userData.phase) * (0.025 + wind * 0.12);
        }
      });
      masts.forEach((m, mi) => {
        m.sails.forEach((s, si) => {
          s.pivot.rotation.z = Math.sin(time * 1.25 + s.phase + mi) * (0.006 + wind * 0.026);
          s.pivot.rotation.x = Math.sin(time * 1.72 + s.phase * 1.4) * (0.004 + wind * 0.018);
          s.pivot.position.z = 0.012 + Math.sin(time * 1.1 + s.phase) * wind * 0.008;
        });
      });
    }
  }

  function reset() {
    body.vy = 0;
    body.pitch = 0;
    body.pitchVel = 0;
    body.roll = 0;
    body.rollVel = 0;
    body.driftX = 0;
    body.driftZ = 0;
    const water = waveField.heightAt(base.x, base.z);
    body.y = water + 0.025;
    root.position.set(base.x, body.y, base.z);
    root.quaternion.identity();
    qYaw.setFromAxisAngle(axisY, baseYaw);
    root.quaternion.copy(qYaw);
    validateContainment();
  }

  const localForward = new THREE.Vector3(1, 0, 0);
  const modelOffsetY = 0.032;
  const mastTipLocals = masts.map((m) => new THREE.Vector3(m.mastX, 0.065 + m.height + modelOffsetY, 0));
  const hullCheckLocals = [
    { name: 'bow', point: new THREE.Vector3(0.62, 0.085 + modelOffsetY, 0) },
    { name: 'stern', point: new THREE.Vector3(-0.62, 0.085 + modelOffsetY, 0) },
    { name: 'port', point: new THREE.Vector3(0, 0.055 + modelOffsetY, 0.20) },
    { name: 'starboard', point: new THREE.Vector3(0, 0.055 + modelOffsetY, -0.20) },
    { name: 'mast foot', point: new THREE.Vector3(0.03, 0.10 + modelOffsetY, 0) }
  ];
  const tmp = new THREE.Vector3();
  const containment = {
    withinBottle: true,
    worst: null,
    checks: { mastTips: [true, true, true], hull: true },
    mastTipWorld: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
  };

  function validateContainment() {
    let all = true;
    let worst = null;
    for (let i = 0; i < mastTipLocals.length; i++) {
      const p = tmp.copy(mastTipLocals[i]).applyQuaternion(root.quaternion).add(root.position);
      containment.mastTipWorld[i].copy(p);
      const inside = bottle.isInsideCavity(p, 0.022);
      containment.checks.mastTips[i] = inside;
      if (!inside) {
        all = false;
        worst = 'mastTip' + i;
      }
    }
    for (let i = 0; i < hullCheckLocals.length; i++) {
      const p = tmp.copy(hullCheckLocals[i].point).applyQuaternion(root.quaternion).add(root.position);
      const inside = bottle.isInsideCavity(p, 0.018);
      containment.checks.hull = containment.checks.hull && inside;
      if (!inside) {
        all = false;
        worst = worst || hullCheckLocals[i].name;
      }
    }
    containment.withinBottle = all;
    containment.worst = worst;
    return all;
  }

  function applyPoseQuaternion() {
    qYaw.setFromAxisAngle(axisY, body.yaw);
    qPitch.setFromAxisAngle(axisZ, body.pitch);
    qRoll.setFromAxisAngle(axisX, body.roll);
    root.quaternion.copy(qYaw).multiply(qPitch).multiply(qRoll);
  }

  function getDiagnostics() {
    root.updateMatrixWorld(true);
    const tip = containment.mastTipWorld[1].clone();
    const center = waveField.sample(root.position.x, root.position.z);
    return {
      position: root.position.toArray(),
      quaternion: root.quaternion.toArray(),
      pitch: body.pitch,
      roll: body.roll,
      yaw: body.yaw,
      rootY: root.position.y,
      surfaceAtBoat: center.height,
      waterLevel: waveField.baseLevel,
      waveAmplitude: waveField.amplitude,
      sampleHeights: {
        bow: lastSamples.bow ? lastSamples.bow.height : null,
        stern: lastSamples.stern ? lastSamples.stern.height : null,
        port: lastSamples.port ? lastSamples.port.height : null,
        starboard: lastSamples.starboard ? lastSamples.starboard.height : null,
        center: lastSamples.center ? lastSamples.center.height : null
      },
      mastTip: tip.toArray(),
      mastTips: containment.mastTipWorld.map((p) => p.toArray()),
      forward: localForward.clone().applyQuaternion(root.quaternion).toArray(),
      drift: [body.driftX, body.driftZ],
      safety: {
        withinBottle: containment.withinBottle,
        worst: containment.worst,
        checks: { mastTips: containment.checks.mastTips.slice(), hull: containment.checks.hull }
      }
    };
  }

  function setStatus(flag) {
    // kept for diagnostics hooks; real containment is enforced by the safe
    // amplitude ranges and the boat's central drift pocket.
    root.userData.safe = flag;
  }

  return {
    root,
    model,
    masts,
    body,
    update,
    reset,
    getDiagnostics,
    setStatus,
    base,
    samplePoints,
    dispose() {
      scene.remove(root);
      woodTexture.dispose();
      deckTexture.dispose();
      sailTexture.dispose();
      woodMat.dispose();
      deckMat.dispose();
      trimMat.dispose();
      sailMat.dispose();
      root.traverse((obj) => {
        if (obj.isMesh) {
          obj.geometry?.dispose();
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
          else obj.material?.dispose();
        }
      });
    }
  };
}
