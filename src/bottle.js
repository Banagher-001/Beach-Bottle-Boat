import * as THREE from 'three';

export const BOTTLE_CONFIG = {
  center: new THREE.Vector3(-0.15, 1.15, 0.1),
  yaw: THREE.MathUtils.degToRad(7.5),
  tilt: THREE.MathUtils.degToRad(12.5),
  bodyRadius: 0.9,
  length: 4.45
};

// Outer and inner surfaces are one continuous lathe profile so the bottle has a
// real glass wall, a rolled lip and a closed bottom with visible thickness.
const SHELL_PROFILE = [
  [0.0, -2.28],
  [0.28, -2.265],
  [0.49, -2.215],
  [0.66, -2.135],
  [0.79, -2.02],
  [0.865, -1.86],
  [0.89, -1.66],
  [0.9, -1.35],
  [0.905, -0.9],
  [0.91, -0.35],
  [0.905, 0.05],
  [0.89, 0.35],
  [0.865, 0.59],
  [0.815, 0.79],
  [0.73, 0.97],
  [0.62, 1.12],
  [0.47, 1.255],
  [0.32, 1.375],
  [0.268, 1.475],
  [0.255, 1.62],
  [0.255, 1.82],
  [0.265, 1.97],
  [0.295, 2.075],
  [0.315, 2.135],
  [0.302, 2.175],
  [0.255, 2.18],
  [0.228, 2.12],
  [0.214, 1.99],
  [0.207, 1.82],
  [0.209, 1.65],
  [0.224, 1.5],
  [0.31, 1.39],
  [0.45, 1.285],
  [0.57, 1.15],
  [0.675, 0.98],
  [0.755, 0.79],
  [0.798, 0.58],
  [0.82, 0.29],
  [0.83, -0.05],
  [0.827, -0.65],
  [0.818, -1.22],
  [0.797, -1.58],
  [0.755, -1.84],
  [0.685, -2.03],
  [0.575, -2.155],
  [0.43, -2.225],
  [0.0, -2.26]
];

const INNER_PROFILE = SHELL_PROFILE.slice(26).map(([r, y]) => [r, y]);
// The inner cavity surface is used for the tinted water volume. Starting at the
// inner rim keeps it open at the top and gives a believable inner glass silhouette.

export const CAVITY_GLSL = /* glsl */ `
float bottleCavityRadius(float u) {
  if (u < -2.235 || u > 2.095) return 0.0;
  float shoulder = smoothstep(0.25, 1.38, u);
  float r = mix(0.826, 0.198, shoulder);
  float bottom = smoothstep(-2.235, -1.83, u);
  r *= mix(0.08, 1.0, bottom);
  float top = 1.0 - smoothstep(1.98, 2.095, u) * 0.08;
  return r * top;
}

bool insideBottleCavity(vec3 localPoint, float margin) {
  if (localPoint.y < -2.225 || localPoint.y > 2.085) return false;
  float r = bottleCavityRadius(localPoint.y) - margin;
  if (r <= 0.0) return false;
  return dot(localPoint.xz, localPoint.xz) < r * r;
}

float bottleCavityEdge(vec3 localPoint, float width) {
  float r = bottleCavityRadius(localPoint.y);
  if (r <= 0.001) return 1.0;
  return smoothstep(r - width, r, length(localPoint.xz));
}
`;

function lathePoints(points) {
  return points.map(([r, y]) => new THREE.Vector2(Math.max(0, r), y));
}

function makeCorkTexture() {
  const size = 192;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const base = ctx.createLinearGradient(0, 0, size, 0);
  base.addColorStop(0, '#916443');
  base.addColorStop(0.32, '#b07a50');
  base.addColorStop(0.62, '#9b6946');
  base.addColorStop(1, '#7a5036');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  let seed = 49217;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < 620; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const w = 0.7 + rand() * 3.6;
    const h = 2 + rand() * 13;
    ctx.globalAlpha = 0.1 + rand() * 0.28;
    ctx.fillStyle = rand() > 0.55 ? '#4f3020' : '#d2a074';
    ctx.beginPath();
    ctx.ellipse(x, y, w, h, (rand() - 0.5) * 0.18, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 24; i++) {
    ctx.globalAlpha = 0.16 + rand() * 0.2;
    ctx.strokeStyle = '#4a2b1d';
    ctx.lineWidth = 0.7 + rand();
    const y = rand() * size;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= size; x += 16) ctx.lineTo(x, y + Math.sin(x * 0.06 + i) * 2.2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2.1, 1.3);
  tex.anisotropy = 4;
  return tex;
}

function createGlassMaterial(opacity) {
  // A bespoke thin-glass shader gives crisp Fresnel rims and sun glints without
  // the milky double-surface wash that a stock physical material produces here.
  return new THREE.ShaderMaterial({
    uniforms: {
      uOpacity: { value: opacity },
      uSunDir: { value: new THREE.Vector3(0.1, 0.18, -0.98).normalize() },
      uSunColor: { value: new THREE.Color(0xffd4a0).convertSRGBToLinear() },
      uWarm: { value: new THREE.Color(0xffe0b6).convertSRGBToLinear() },
      uCool: { value: new THREE.Color(0x0c3b3e).convertSRGBToLinear() },
      uSky: { value: new THREE.Color(0x716383).convertSRGBToLinear() },
      uHorizon: { value: new THREE.Color(0xf4a072).convertSRGBToLinear() }
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      varying vec3 vLocalPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        vLocalPos = position;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      varying vec3 vLocalPos;
      uniform float uOpacity;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec3 uWarm;
      uniform vec3 uCool;
      uniform vec3 uSky;
      uniform vec3 uHorizon;

      float hash12(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }

      void main() {
        vec3 n = normalize(vWorldNormal);
        vec3 v = normalize(cameraPosition - vWorldPos);
        float facing = clamp(abs(dot(n, v)), 0.0, 1.0);
        float fres = pow(1.0 - facing, 2.65);
        vec3 reflected = reflect(-v, n);
        float skyUp = smoothstep(-0.08, 0.58, reflected.y);
        vec3 skyCol = mix(uHorizon, uSky, skyUp);

        vec3 col = mix(uCool * 1.3, skyCol, 0.20 + fres * 0.7);
        col = mix(col, uWarm, pow(fres, 2.5) * 0.30);
        float rimWhite = smoothstep(0.38, 0.96, fres);
        col = mix(col, vec3(0.92, 0.97, 0.94), rimWhite * 0.46);
        float horizonBand = exp(-pow((reflected.y - 0.06) / 0.17, 2.0));
        col += mix(vec3(0.78, 0.92, 0.9), uWarm, 0.32) * horizonBand * (0.07 + fres * 0.34);
        float veil = pow(1.0 - facing, 1.1);
        col = mix(col, skyCol * 0.7 + uCool * 0.6, veil * 0.22);
        col += vec3(0.02, 0.045, 0.048) * veil;
        float topGlow = smoothstep(0.08, 0.9, n.y) * (1.0 - facing) * 0.55;
        col += uWarm * topGlow;
        col += vec3(0.035, 0.075, 0.08) * pow(fres, 1.8);

        // Hand-painted reflection ribbons travel with the glass, keeping the
        // bottle readable as a vessel from almost any orbit angle.
        float radialAngle = atan(vLocalPos.z, vLocalPos.x);
        float u = vLocalPos.y;
        float along = smoothstep(-2.02, -1.35, u) * (1.0 - smoothstep(0.35, 1.28, u));
        float bandA = exp(-pow((radialAngle - 2.18) / 0.11, 2.0)) * along;
        float bandB = exp(-pow((radialAngle - 1.78) / 0.055, 2.0)) * smoothstep(-1.9, -1.0, u) * (1.0 - smoothstep(-0.2, 0.9, u));
        float bandC = exp(-pow((radialAngle + 2.7) / 0.20, 2.0)) * smoothstep(-1.7, -0.5, u) * (1.0 - smoothstep(0.2, 0.8, u));
        col += uWarm * (bandA * 0.95 + bandB * 0.65 + bandC * 0.42);
        col += vec3(0.09, 0.16, 0.17) * bandA;

        float sunFacing = max(dot(reflected, normalize(uSunDir)), 0.0);
        float broad = pow(sunFacing, 18.0);
        float sharp = pow(sunFacing, 320.0);
        col += uSunColor * (broad * 0.22 + sharp * 2.6);

        float alpha = 0.046 + fres * 0.46 + sharp * 0.28 + broad * 0.014 + topGlow * 0.11 + horizonBand * (0.018 + fres * 0.07) + bandA * 0.28 + bandB * 0.16 + bandC * 0.06 + veil * 0.055;
        alpha *= clamp(uOpacity / 0.13, 0.28, 2.8);
        gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.62));
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide
  });
}

export function createBottle({ scene, renderer, state }) {
  const cfg = BOTTLE_CONFIG;
  const root = new THREE.Group();
  root.name = 'BottleRoot';
  root.position.copy(cfg.center);
  root.rotation.y = cfg.yaw;
  scene.add(root);

  const tilt = new THREE.Group();
  tilt.name = 'BottleTilt';
  tilt.rotation.z = -Math.PI / 2 - cfg.tilt;
  root.add(tilt);

  const shellGeometry = new THREE.LatheGeometry(lathePoints(SHELL_PROFILE), 112, 0, Math.PI * 2);
  shellGeometry.computeVertexNormals();
  shellGeometry.computeBoundingSphere();

  const glassMaterial = createGlassMaterial(state.glassOpacity);
  glassMaterial.name = 'GlassMaterial';
  glassMaterial.renderOrder = 20;

  const glassMesh = new THREE.Mesh(shellGeometry, glassMaterial);
  glassMesh.name = 'BottleGlass';
  glassMesh.castShadow = false;
  glassMesh.receiveShadow = false;
  glassMesh.renderOrder = 20;
  tilt.add(glassMesh);

  // Kept as a no-op alias for debugging and for the UI opacity slider.
  const fresnelMaterial = glassMaterial;

  // Actual inner cavity surface, reused by the water-volume shader.
  const cavityGeometry = new THREE.LatheGeometry(lathePoints(INNER_PROFILE), 96, 0, Math.PI * 2);
  cavityGeometry.computeVertexNormals();
  const cavityMesh = new THREE.Mesh(cavityGeometry, new THREE.MeshBasicMaterial({ visible: false }));
  cavityMesh.name = 'BottleCavityReference';
  cavityMesh.visible = false;
  tilt.add(cavityMesh);

  // Cork: a lathe-turned, slightly flared stopper.
  const corkProfile = [
    [0.0, 1.89],
    [0.176, 1.905],
    [0.196, 1.955],
    [0.201, 2.03],
    [0.207, 2.12],
    [0.232, 2.2],
    [0.245, 2.28],
    [0.248, 2.36],
    [0.238, 2.43],
    [0.213, 2.46],
    [0.16, 2.475],
    [0.0, 2.485]
  ];
  const corkGeometry = new THREE.LatheGeometry(lathePoints(corkProfile), 48);
  corkGeometry.computeVertexNormals();
  const corkTexture = makeCorkTexture();
  const corkMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x98795a),
    map: corkTexture,
    roughness: 0.96,
    metalness: 0,
    flatShading: false
  });
  const corkMesh = new THREE.Mesh(corkGeometry, corkMaterial);
  corkMesh.name = 'BottleCork';
  corkMesh.castShadow = true;
  corkMesh.receiveShadow = true;
  corkMesh.renderOrder = 11;
  tilt.add(corkMesh);

  const corkTopMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x7d5034),
    roughness: 0.95
  });
  const corkTop = new THREE.Mesh(new THREE.CircleGeometry(0.195, 32), corkTopMaterial);
  corkTop.rotation.x = -Math.PI / 2;
  corkTop.position.set(0, 2.486, 0);
  tilt.add(corkTop);

  const twineMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xc3a273),
    roughness: 0.85
  });
  const twine = new THREE.Mesh(new THREE.TorusGeometry(0.238, 0.0085, 5, 40), twineMaterial);
  twine.rotation.x = Math.PI / 2;
  twine.position.y = 2.3;
  twine.castShadow = true;
  tilt.add(twine);

  // Three subtle moulded rings around the neck.
  const ringMaterial = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0xbde6dd),
    roughness: 0.06,
    transparent: true,
    opacity: Math.min(0.5, state.glassOpacity * 1.3),
    depthWrite: false,
    envMapIntensity: 2.5,
    clearcoat: 1
  });
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.012, 6, 40), ringMaterial);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 1.57 + i * 0.095;
    ring.renderOrder = 19;
    tilt.add(ring);
  }

  // A warm practical light inside the glass helps the tiny ship read.
  const interiorLight = new THREE.PointLight(0xffc47a, 1.15, 4.2, 2);
  interiorLight.position.set(0.15, 0.45, 0.45);
  interiorLight.castShadow = false;
  root.add(interiorLight);

  const clipUniforms = {
    uBottleCavityInv: { value: new THREE.Matrix4() }
  };

  root.updateWorldMatrix(true, true);
  clipUniforms.uBottleCavityInv.value.copy(tilt.matrixWorld).invert();

  const cavityWorldMatrix = new THREE.Matrix4();
  const cavityInverse = new THREE.Matrix4();
  const tmpLocal = new THREE.Vector3();

  function refreshCavityMatrix() {
    tilt.updateWorldMatrix(true, false);
    cavityWorldMatrix.copy(tilt.matrixWorld);
    cavityInverse.copy(cavityWorldMatrix).invert();
    clipUniforms.uBottleCavityInv.value.copy(cavityInverse);
  }
  refreshCavityMatrix();

  function worldToCavity(worldPoint) {
    return new THREE.Vector3().copy(worldPoint).applyMatrix4(cavityInverse);
  }

  function cavityToWorld(localPoint) {
    return new THREE.Vector3().copy(localPoint).applyMatrix4(cavityWorldMatrix);
  }

  function isInsideCavity(worldPoint, margin = 0.035) {
    const local = worldToCavity(worldPoint);
    if (local.y < -2.225 || local.y > 2.08) return false;
    let r;
    if (local.y < -1.83) {
      r = THREE.MathUtils.lerp(0.83, 0.08, THREE.MathUtils.smoothstep(local.y, -2.235, -1.83));
    } else {
      const shoulder = THREE.MathUtils.smoothstep(local.y, 0.25, 1.38);
      r = THREE.MathUtils.lerp(0.826, 0.198, shoulder);
    }
    return local.x * local.x + local.z * local.z < Math.max(0, r - margin) ** 2;
  }

  function getChamberPoint(worldX, worldZ, localY = 0.0) {
    const local = new THREE.Vector3();
    // Solve for the cavity's local X/Z position at a chosen world X/Z by using
    // the inverse transform of the approx. world point at the bottle's mid-level.
    local.set(worldX, 0.0, worldZ);
    return cavityToWorld(local);
  }

  function setGlassOpacity(value) {
    const opacity = THREE.MathUtils.clamp(value, 0.04, 0.48);
    glassMaterial.uniforms.uOpacity.value = opacity;
    ringMaterial.opacity = Math.min(0.4, opacity * 1.15);
  }

  function setSunDirection(dir) {
    glassMaterial.uniforms.uSunDir.value.copy(dir).normalize();
  }

  function setLightIntensity(v) {
    interiorLight.intensity = v;
  }

  return {
    root,
    tilt,
    glassMesh,
    glassMaterial,
    fresnelMaterial,
    cavityMesh,
    cavityGeometry,
    corkMesh,
    corkMaterial,
    clipUniforms,
    clipGLSL: CAVITY_GLSL,
    innerProfile: INNER_PROFILE,
    refreshCavityMatrix,
    worldToCavity,
    cavityToWorld,
    isInsideCavity,
    getChamberPoint,
    setGlassOpacity,
    setSunDirection,
    setLightIntensity,
    interiorLight,
    config: cfg,
    dispose() {
      shellGeometry.dispose();
      cavityGeometry.dispose();
      glassMaterial.dispose();
      fresnelMaterial.dispose();
      corkGeometry.dispose();
      corkMaterial.dispose();
      corkTexture.dispose();
      ringMaterial.dispose();
    }
  };
}
