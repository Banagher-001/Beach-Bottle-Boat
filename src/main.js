import * as THREE from 'three';
import { createEnvironment } from './world.js';
import { createBottle, BOTTLE_CONFIG } from './bottle.js';
import { WaveField } from './waves.js';
import { createBottleWater } from './water.js';
import { createBoat } from './boat.js';
import { createPixelPipeline, QUALITY_PRESETS } from './post.js';
import { createCameraRig } from './camera.js';
import { createUI } from './ui.js';

const DEFAULTS = {
  waveHeight: 35,
  waveSpeed: 1,
  waveDensity: 1.25,
  waveDirection: 28,
  waterLevel: 42,
  boatResponse: 72,
  boatDamping: 48,
  wind: 22,
  pixelScale: 2.0,
  sunset: 45,
  brightness: 0.82,
  glassOpacity: 0.15,
  lighthouse: true,
  spray: true,
  dust: true,
  quality: 'fine',
  paused: false,
  editMode: null
};

const LIMITS = {
  waveHeight: [0, 100],
  waveSpeed: [0.2, 3],
  waveDensity: [0.5, 3],
  waveDirection: [0, 360],
  waterLevel: [0, 100],
  boatResponse: [0, 100],
  boatDamping: [0, 100],
  wind: [0, 100],
  pixelScale: [1, 5],
  sunset: [0, 100],
  brightness: [0.6, 1.6],
  glassOpacity: [0.04, 0.4]
};

const state = { ...DEFAULTS };
let ready = false;
let renderer = null;
let scene = null;
let camera = null;
let env = null;
let bottle = null;
let water = null;
let boat = null;
let waveField = null;
let post = null;
let cameraRig = null;
let ui = null;
let simTime = 0;
let clockLast = 0;
let rafId = 0;
let frameCount = 0;
let fpsTimer = 0;
let fps = 60;
let booted = false;
let contactShadows = null;

const envState = () => ({
  sunset: state.sunset / 100,
  brightness: state.brightness,
  wind: state.wind / 100,
  dust: state.dust,
  spray: state.spray,
  lighthouse: state.lighthouse
});

const debug = {
  ready: false,
  version: '1.0.0',
  state,
  setParam,
  setToggle,
  setPaused,
  setQuality,
  cameraPreset,
  setPreset: cameraPreset,
  resetAll,
  captureScreenshot,
  setEditMode,
  getDiagnostics,
  getParam: (name) => state[name],
  boat: null,
  waterField: null,
  bottle: null,
  water: null,
  environment: null,
  scene: null,
  camera: null,
  renderer: null,
  THREE
};
window.__bottleOcean = debug;

function clampParam(name, value) {
  const limits = LIMITS[name];
  if (!limits) return value;
  return THREE.MathUtils.clamp(value, limits[0], limits[1]);
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function applyWaveSettings() {
  if (!waveField) return;
  waveField.configure({
    height: state.waveHeight,
    speed: state.waveSpeed,
    density: state.waveDensity,
    direction: state.waveDirection,
    waterLevel: state.waterLevel
  });
  if (water) water.setWaterLevel(state.waterLevel);
}

function applySunAndWaterPalette() {
  if (!env || !water) return;
  env.applySunset?.(state.sunset / 100);
  water.setSun(env.sunDirection, env.sunLight?.color, state.sunset / 100);
  if (bottle) bottle.setSunDirection(env.sunDirection);
}

function applyShadowQuality(size) {
  if (!env?.sunLight?.shadow) return;
  const shadow = env.sunLight.shadow;
  if (shadow.mapSize.x === size) return;
  shadow.mapSize.set(size, size);
  if (shadow.map) {
    shadow.map.dispose();
    shadow.map = null;
  }
  env.refreshShadows?.();
  if (renderer) renderer.shadowMap.needsUpdate = true;
}

function setParam(name, rawValue, source = 'api') {
  if (!(name in LIMITS)) return state[name];
  const value = clampParam(name, Number(rawValue));
  if (!Number.isFinite(value)) return state[name];
  state[name] = value;

  if (['waveHeight', 'waveSpeed', 'waveDensity', 'waveDirection', 'waterLevel'].includes(name)) {
    applyWaveSettings();
  } else if (name === 'wind') {
    env?.setWind?.(value / 100);
  } else if (name === 'pixelScale') {
    post?.setPixelScale(value);
    state.quality = null;
    ui?.setQualityActive(null);
  } else if (name === 'sunset') {
    applySunAndWaterPalette();
  } else if (name === 'brightness') {
    post?.setExposure(value);
  } else if (name === 'glassOpacity') {
    bottle?.setGlassOpacity(value);
  }

  if (ui && source !== 'ui') ui.setControlValue(name, value, false);
  return state[name];
}

function setToggle(name, value, source = 'api') {
  if (!['lighthouse', 'spray', 'dust'].includes(name)) return;
  state[name] = Boolean(value);
  if (name === 'lighthouse') {
    env?.setLighthouse?.(state[name]);
  } else if (name === 'spray') {
    env?.setSprayEnabled?.(state[name]);
    water?.setFoamEnabled(state[name]);
  } else if (name === 'dust') {
    env?.setDustEnabled?.(state[name]);
  }
  if (source !== 'ui') ui?.setToggle(name, state[name]);
  return state[name];
}

function setPaused(paused, source = 'api') {
  const pausedNow = Boolean(paused);
  state.paused = pausedNow;
  ui?.setPaused(pausedNow);
  if (source !== 'api') {
    ui?.showToast(pausedNow ? '模拟已暂停 · 相机仍可自由观察' : '模拟继续 · 海浪重新流动');
  }
}

function setQuality(name, source = 'api') {
  const preset = QUALITY_PRESETS[name] ? name : 'fine';
  state.quality = preset;
  const info = post?.setQuality(preset) || QUALITY_PRESETS[preset];
  state.pixelScale = info.scale;
  ui?.setQualityActive(preset);
  ui?.setControlValue('pixelScale', state.pixelScale, false);
  applyShadowQuality(info.shadow);
  if (source !== 'api') ui?.showToast('画面预设 · ' + info.label);
}

function applyAllSettings() {
  applyWaveSettings();
  if (bottle) bottle.setGlassOpacity(state.glassOpacity);
  post?.setExposure(state.brightness);
  applySunAndWaterPalette();
  env?.setLighthouse?.(state.lighthouse);
  env?.setDustEnabled?.(state.dust);
  env?.setSprayEnabled?.(state.spray);
  env?.setWind?.(state.wind / 100);
  water?.setFoamEnabled(state.spray);
  applyShadowQuality(QUALITY_PRESETS[state.quality || 'fine']?.shadow || 2048);
}

function setEditMode(mode) {
  state.editMode = mode || null;
  ui?.setEditMode(state.editMode);
  const canvas = renderer?.domElement;
  if (canvas) canvas.style.cursor = state.editMode ? 'crosshair' : 'grab';
  if (state.editMode) {
    ui?.showToast(state.editMode === 'rock' ? '布置模式：点击沙地放置石头' : '布置模式：点击沙地放置贝壳', 2200);
  }
}

function resetAll() {
  if (!ready) return;
  Object.assign(state, DEFAULTS);
  simTime = 0;
  waveField?.setTime(0);
  applyAllSettings();
  boat?.reset();
  cameraRig?.reset();
  env?.resetProps?.();
  state.quality = 'fine';
  setQuality('fine');
  state.paused = false;
  ui?.syncAll();
  ui?.setQualityActive('fine');
  ui?.setCameraPresetActive('cinema');
  ui?.setEditMode(null);
  setEditMode(null);
  ui?.showToast('已恢复默认场景与参数');
}

function cameraPreset(name) {
  if (!cameraRig) return;
  cameraRig.setPreset(name);
  ui?.setCameraPresetActive(name);
}

function captureScreenshot(download = true) {
  if (!ready || !renderer) return null;
  post?.render(simTime);
  const source = renderer.domElement;
  const rect = source.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const capture = document.createElement('canvas');
  capture.width = Math.max(1, Math.round(rect.width * dpr));
  capture.height = Math.max(1, Math.round(rect.height * dpr));
  const captureCtx = capture.getContext('2d');
  captureCtx.imageSmoothingEnabled = false;
  captureCtx.drawImage(source, 0, 0, capture.width, capture.height);
  const dataUrl = capture.toDataURL('image/png');
  if (download) {
    const link = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    link.download = 'bottle-ocean-' + stamp + '.png';
    link.href = dataUrl;
    link.click();
  }
  ui?.showToast(download ? '画面已保存 · PNG 截图' : '截图已生成');
  return dataUrl;
}

function getDiagnostics() {
  const pixelInfo = post?.getState?.() || {};
  const diagnostics = {
    ready,
    simTime,
    paused: state.paused,
    state: { ...state },
    camera: cameraRig?.getState?.() || null,
    boat: boat?.getDiagnostics?.() || null,
    water: waveField ? {
      baseLevel: waveField.baseLevel,
      amplitude: waveField.amplitude,
      heightAtBoat: boat ? waveField.heightAt(boat.root.position.x, boat.root.position.z) : null,
      samples: boat?.getDiagnostics?.().sampleHeights || null
    } : null,
    renderer: renderer ? {
      calls: pixelInfo.sceneStats?.calls ?? renderer.info.render.calls,
      triangles: pixelInfo.sceneStats?.triangles ?? renderer.info.render.triangles,
      points: pixelInfo.sceneStats?.points ?? 0,
      lines: pixelInfo.sceneStats?.lines ?? 0,
      pixelWidth: pixelInfo.pixelWidth,
      pixelHeight: pixelInfo.pixelHeight,
      scale: pixelInfo.scale,
      levels: pixelInfo.levels
    } : null,
    fps: Math.round(fps),
    cameraInsideBottle: bottle && camera ? bottle.isInsideCavity(camera.position, -0.04) : null,
    editMode: state.editMode
  };
  return diagnostics;
}

function isDescendantOf(object, ancestor) {
  let node = object;
  while (node) {
    if (node === ancestor) return true;
    node = node.parent;
  }
  return false;
}

function injectBottleClip(material, bottleRef) {
  if (!material) return;
  const original = material.onBeforeCompile;
  const clipGLSL = bottleRef.clipGLSL;
  material.onBeforeCompile = function (shader, rendererInstance) {
    if (typeof original === 'function') original.call(this, shader, rendererInstance);
    shader.uniforms.uBottleCavityInv = bottleRef.clipUniforms.uBottleCavityInv;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBottleClipWorld;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBottleClipWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBottleClipWorld;\nuniform mat4 uBottleCavityInv;\n' + clipGLSL)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nvec3 bottleLocal = (uBottleCavityInv * vec4(vBottleClipWorld, 1.0)).xyz;\nif (insideBottleCavity(bottleLocal, 0.012)) discard;');
  };
  material.customProgramCacheKey = () => 'bottle-cavity-terrain-v1';
  material.needsUpdate = true;
}

function createSandTextureVariant(source, repeatX, repeatY) {
  if (!source || !source.image) return null;
  const tex = new THREE.CanvasTexture(source.image);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = source.colorSpace;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = 4;
  return tex;
}

function addBurialDrift() {
  if (!env || !bottle) return;
  const colorTex = createSandTextureVariant(env.sandColorTexture, 1.7, 1.1);
  const normalTex = createSandTextureVariant(env.sandNormalTexture, 1.7, 1.1);
  if (normalTex) normalTex.colorSpace = THREE.NoColorSpace;
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    map: colorTex,
    normalMap: normalTex,
    normalScale: new THREE.Vector2(0.55, 0.55),
    roughness: 0.96,
    metalness: 0.0,
    envMapIntensity: 0.35,
    side: THREE.FrontSide
  });

  const width = 6.6;
  const depth = 3.2;
  const segX = 120;
  const segZ = 64;
  const geo = new THREE.PlaneGeometry(width, depth, segX, segZ);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const colors = new Float32Array(pos.count * 3);
  const cDry = new THREE.Color(0xd6ab7d);
  const cLight = new THREE.Color(0xefc998);
  const cWet = new THREE.Color(0x8d6b50);
  const cDark = new THREE.Color(0x6b503c);
  const color = new THREE.Color();
  const x0 = BOTTLE_CONFIG.center.x;
  const z0 = BOTTLE_CONFIG.center.z + 1.15;
  let seed = 9383;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + x0;
    const z = pos.getZ(i) + z0;
    const base = env.getSandHeight?.(x, z) ?? 0.2;
    const side = THREE.MathUtils.clamp((0.5 - x) / 3.2, 0, 1);
    const baseCrest = 0.14 + 0.25 * side + 0.10 * Math.exp(-Math.pow((x + 2.3) / 1.0, 2));
    const g = Math.exp(-Math.pow((z - (z0 + 0.08)) / 0.48, 2));
    const grain = 0.82 + 0.30 * (Math.sin(x * 2.1 + z * 1.3) * 0.5 + 0.5);
    const bump = baseCrest * g * grain;
    const feather = THREE.MathUtils.smoothstep(1.0 - Math.abs((x - x0) / (width * 0.5)), 0.0, 0.18);
    const y = base + bump * feather - 0.006;
    pos.setXYZ(i, x, y, z);
    uv.setXY(i, (x - (x0 - width * 0.5)) / width, (z - (z0 - depth * 0.5)) / depth);
    const nearBottle = Math.max(0, 1 - Math.hypot(x - x0, (z - z0) / 0.9) / 3.8);
    color.copy(cDry).lerp(cLight, grain * 0.35);
    color.lerp(cWet, nearBottle * 0.35 + g * 0.18);
    color.lerp(cDark, Math.max(0, y - base) * 0.35);
    const speck = 0.92 + rand() * 0.16;
    color.multiplyScalar(speck);
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  injectBottleClip(material, bottle);
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'BottleBurialDrift';
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  scene.add(mesh);
  return mesh;
}

function createContactShadowTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(14, 8, 5, 0.68)');
  grad.addColorStop(0.42, 'rgba(20, 11, 7, 0.42)');
  grad.addColorStop(0.75, 'rgba(28, 16, 9, 0.14)');
  grad.addColorStop(1, 'rgba(30, 18, 10, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function addContactShadows() {
  if (!env || !bottle) return;
  const texture = createContactShadowTexture();
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    color: 0x1a0d07
  });
  const group = new THREE.Group();
  group.name = 'BottleContactShadows';
  scene.add(group);
  const yaw = bottle.root.rotation.y;
  const axis = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  const center = bottle.root.position.clone();
  const positions = [-2.0, -1.15, -0.2, 0.8, 1.65, 2.25];
  const scales = [0.95, 1.35, 1.55, 1.35, 1.05, 0.72];
  for (let i = 0; i < positions.length; i++) {
    const p = center.clone().addScaledVector(axis, positions[i]);
    const ground = env.getSandHeight?.(p.x, p.z) ?? 0.1;
    const geo = new THREE.PlaneGeometry(2.2 * scales[i], 1.3 * scales[i]);
    const mesh = new THREE.Mesh(geo, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = -yaw;
    mesh.position.set(p.x, ground + 0.018, p.z);
    mesh.renderOrder = 1;
    group.add(mesh);
  }
  group.userData.texture = texture;
  group.userData.material = material;
  contactShadows = group;
}

function setupInteraction() {
  const canvas = renderer.domElement;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let downInfo = null;

  function rayFromEvent(event, targets) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    return raycaster.intersectObjects(targets, true);
  }

  function clickTargets(includeGround = true) {
    const list = [bottle.glassMesh, bottle.corkMesh, boat.root];
    if (env?.lighthouse?.hitObjects) list.push(...env.lighthouse.hitObjects);
    if (includeGround && env?.raycastTargets) list.push(...env.raycastTargets);
    return list;
  }

  function editGroundTargets() {
    if (!env) return [];
    const blocked = new Set([env.ocean, ...(env.lighthouse?.hitObjects || [])]);
    const targets = [];
    if (env.terrain) targets.push(env.terrain);
    if (env.rocks) targets.push(env.rocks);
    for (const obj of env.raycastTargets || []) {
      if (!obj || blocked.has(obj) || blocked.has(obj.parent)) continue;
      if (obj.name === 'birds' || obj.name === 'seaBirds') continue;
      if (obj.material && obj.material.transparent) continue;
      if (!targets.includes(obj)) targets.push(obj);
    }
    return targets;
  }

  function handleClickAt(event) {
    if (!ready) return;
    if (state.editMode && env?.addProp) {
      const groundHits = rayFromEvent(event, editGroundTargets());
      if (groundHits.length) {
        const hit = groundHits[0];
        if (bottle.isInsideCavity(hit.point, 0.02)) {
          ui?.showToast('玻璃瓶内部不能放置物件', 1600);
          return;
        }
        const prop = env.addProp(state.editMode, hit.point);
        if (prop) ui?.showToast(state.editMode === 'rock' ? '已放置一块石头' : '已放置一枚贝壳');
      }
      return;
    }
    const hits = rayFromEvent(event, clickTargets(false));
    if (!hits.length) return;
    const hit = hits[0];
    if (env?.lighthouse?.group && isDescendantOf(hit.object, env.lighthouse.group)) {
      setToggle('lighthouse', !state.lighthouse, 'ui');
      ui?.showToast(state.lighthouse ? '灯塔重新亮起' : '灯塔灯光熄灭');
    }
  }

  function handleDoubleClick(event) {
    if (!ready || state.editMode) return;
    const hits = rayFromEvent(event, clickTargets(true));
    if (!hits.length) return;
    // Prefer the first hit under the glass/boat, then terrain.
    for (const hit of hits) {
      if (isDescendantOf(hit.object, bottle.root) || isDescendantOf(hit.object, boat.root)) {
        cameraRig.focusBottle();
        return;
      }
      if (env?.lighthouse?.group && isDescendantOf(hit.object, env.lighthouse.group)) {
        setToggle('lighthouse', !state.lighthouse, 'ui');
        cameraRig.focusPoint(hit.point);
        return;
      }
    }
    const terrainHit = hits.find((h) => env?.raycastTargets?.some((t) => isDescendantOf(h.object, t)));
    if (terrainHit) cameraRig.focusPoint(terrainHit.point);
  }

  canvas.addEventListener('pointerdown', (event) => {
    canvas.classList.add('dragging');
    if (event.button !== 0) {
      downInfo = null;
      return;
    }
    downInfo = { x: event.clientX, y: event.clientY, at: performance.now() };
  });

  canvas.addEventListener('pointerup', (event) => {
    canvas.classList.remove('dragging');
    if (!downInfo || event.button !== 0) return;
    const dist = Math.hypot(event.clientX - downInfo.x, event.clientY - downInfo.y);
    const elapsed = performance.now() - downInfo.at;
    downInfo = null;
    if (dist < 6 && elapsed < 650) handleClickAt(event);
  });

  canvas.addEventListener('pointercancel', () => {
    canvas.classList.remove('dragging');
    downInfo = null;
  });

  canvas.addEventListener('dblclick', (event) => {
    event.preventDefault();
    handleDoubleClick(event);
  });

  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
}

async function boot() {
  try {
    clockLast = performance.now();
    ui = createUI({ state, actions });
    ui.setLoading(4, '正在唤醒 WebGL 渲染器…');
    await nextFrame();

    const canvas = document.getElementById('gl');
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
      stencil: false
    });
    renderer.setPixelRatio(1);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.setClearColor(0x0a0909, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.autoClear = true;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0909);
    camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.05, 900);
    camera.position.set(0.55, 2.15, 6.5);
    camera.lookAt(0.8, 1.92, 0.1);

    post = createPixelPipeline(renderer, scene, camera);

    ui.setLoading(16, '正在堆起黄昏海岸…');
    await nextFrame();

    env = createEnvironment({
      scene,
      renderer,
      state: envState(),
      quality: state.quality
    });
    scene.environment = env.envMap || null;
    scene.environmentIntensity = 0.9;
    if (env.sunLight?.shadow) {
      env.sunLight.shadow.mapSize.set(QUALITY_PRESETS.fine.shadow, QUALITY_PRESETS.fine.shadow);
      env.sunLight.shadow.bias = env.sunLight.shadow.bias ?? -0.0004;
    }

    await nextFrame();
    ui.setLoading(36, '正在吹制玻璃瓶…');

    const bed = env.getSandHeight?.(-0.15, 0.1) ?? 0.35;
    bottle = createBottle({ scene, renderer, state });
    const desiredCenterY = THREE.MathUtils.clamp(bed + 0.75, 0.95, 1.35);
    bottle.root.position.y = desiredCenterY;
    bottle.root.updateMatrixWorld(true);
    bottle.refreshCavityMatrix();
    bottle.setGlassOpacity(state.glassOpacity);
    bottle.setSunDirection(env.sunDirection);

    injectBottleClip(env.terrainMaterial, bottle);

    await nextFrame();
    ui.setLoading(54, '正在注入瓶中海浪…');

    waveField = new WaveField();
    applyWaveSettings();
    water = createBottleWater({ scene, bottle, waveField, state });
    water.setSun(env.sunDirection, env.sunLight?.color, state.sunset / 100);
    water.setFoamEnabled(state.spray);

    ui.setLoading(68, '正在让三桅帆船下水…');
    await nextFrame();
    boat = createBoat({ scene, waveField, state, bottle });
    addBurialDrift();

    cameraRig = createCameraRig({
      camera,
      domElement: canvas,
      controlsElement: canvas,
      bottle,
      environment: env,
      onPresetChanged: (name) => {
        if (name) ui.setCameraPresetActive(name);
        else ui.setCameraPresetActive(null, false);
      }
    });
    cameraRig.setPresetImmediate('cinema');

    applyAllSettings();
    setQuality('fine');
    setPaused(false);
    ui.syncAll();

    setupInteraction();

    ui.setLoading(88, '正在调校像素与光线…');
    await nextFrame();

    debug.ready = false;
    debug.boat = boat;
    debug.waterField = waveField;
    debug.bottle = bottle;
    debug.water = water;
    debug.environment = env;
    debug.scene = scene;
    debug.camera = camera;
    debug.renderer = renderer;
    debug.post = post;
    debug.cameraRig = cameraRig;

    window.addEventListener('resize', () => {
      post.updateSize(true);
      ui?.setUIHidden?.(document.body.classList.contains('ui-hidden'));
    }, { passive: true });
    document.addEventListener('visibilitychange', () => {
      clockLast = performance.now();
    });
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      ui?.showError('WebGL 上下文丢失，请刷新页面。');
    });

    window.addEventListener('error', (event) => {
      if (window.__bottleOcean && !window.__bottleOcean.ready) {
        window.__bottleError = String(event.error || event.message || 'Unknown error');
      }
    });

    post.render(0);
    ready = true;
    booted = true;
    debug.ready = true;
    ui.setLoading(100, '瓶中海洋已完成');
    window.dispatchEvent(new CustomEvent('bottle-ocean-ready'));
    await nextFrame();
    ui.hideLoading();
    ui.showToast('拖动视角，调整海浪，看帆船被波浪托起', 2800);
    requestAnimationFrame(tick);
  } catch (error) {
    console.error(error);
    window.__bottleError = String(error && error.stack || error);
    ui?.showError('场景初始化失败：\n' + String(error && error.message || error));
  }
}

function tick(now) {
  rafId = requestAnimationFrame(tick);
  const rawDelta = clockLast ? (now - clockLast) / 1000 : 0.016;
  const delta = Math.min(0.05, Math.max(0.0001, rawDelta));
  const measuredDelta = Math.min(0.5, Math.max(0.0001, rawDelta));
  clockLast = now;

  if (booted) {
    if (!state.paused) {
      simTime += delta;
      waveField.setTime(simTime);
      boat.update(delta, simTime, state);
      water.update(simTime, delta, state);
      env.update?.(simTime, delta, envState());
    }
    cameraRig.update(delta);
    post.render(simTime);

    frameCount++;
    fpsTimer += measuredDelta;
    if (fpsTimer >= 0.55) {
      fps = frameCount / fpsTimer;
      frameCount = 0;
      fpsTimer = 0;
      const p = post.getState();
      ui.setStats({
        fps,
        width: p.pixelWidth,
        height: p.pixelHeight,
        waveHeight: state.waveHeight
      });
    }
  }
}

const actions = {
  onParam(name, value) {
    setParam(name, value, 'ui');
  },
  onToggle(name, value) {
    setToggle(name, value, 'ui');
  },
  onQuality(name) {
    setQuality(name, 'ui');
  },
  onCameraPreset(name) {
    cameraPreset(name);
  },
  onEditMode(mode) {
    state.editMode = mode;
    setEditMode(mode);
  },
  onPauseToggle() {
    setPaused(!state.paused, 'ui');
  },
  onReset() {
    resetAll();
  },
  onResetCamera() {
    cameraRig?.reset();
    ui?.setCameraPresetActive('cinema');
    ui?.showToast('镜头已回到电影主视角');
  },
  onScreenshot() {
    captureScreenshot(true);
  },
  onUndoProp() {
    if (!ready) return;
    env?.undoProp?.();
    ui?.showToast('已撤销最近放置的物件');
  },
  onResetProps() {
    if (!ready) return;
    env?.resetProps?.();
    ui?.showToast('沙地装饰已恢复');
  },
  onCanvasCursor(cursor) {
    if (renderer) renderer.domElement.style.cursor = cursor;
  }
};

boot();
