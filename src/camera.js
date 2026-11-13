import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const PRESETS = {
  cinema: {
    label: '电影主视角',
    position: new THREE.Vector3(0.55, 2.15, 6.5),
    target: new THREE.Vector3(0.8, 1.92, 0.1),
    fov: 42
  },
  side: {
    label: '瓶身侧视角',
    position: new THREE.Vector3(0.35, 1.98, 5.05),
    target: new THREE.Vector3(-0.08, 1.16, 0.12),
    fov: 39
  },
  top: {
    label: '俯视沙盘',
    position: new THREE.Vector3(0.4, 7.15, 4.0),
    target: new THREE.Vector3(-0.05, 0.75, 0.45),
    fov: 44
  },
  closeup: {
    label: '帆船特写',
    position: new THREE.Vector3(-0.28, 1.92, 4.05),
    target: new THREE.Vector3(-0.22, 1.22, 0.10),
    fov: 36
  },
  panorama: {
    label: '环境全景',
    position: new THREE.Vector3(4.1, 4.6, 13.8),
    target: new THREE.Vector3(1.4, 2.35, -7.2),
    fov: 47
  }
};

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function createCameraRig({ camera, domElement, controlsElement, bottle, environment, onUserInteract, onPresetChanged }) {
  const controls = new OrbitControls(camera, controlsElement || domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.072;
  controls.rotateSpeed = 0.58;
  controls.zoomSpeed = 0.82;
  controls.panSpeed = 0.62;
  controls.screenSpacePanning = true;
  controls.minDistance = 2.15;
  controls.maxDistance = 27;
  controls.minPolarAngle = 0.16;
  controls.maxPolarAngle = 1.505;
  controls.enablePan = true;
  controls.autoRotate = false;
  controls.zoomToCursor = false;
  controls.target.copy(PRESETS.cinema.target);
  camera.position.copy(PRESETS.cinema.position);
  camera.fov = PRESETS.cinema.fov;
  camera.near = 0.05;
  camera.far = 900;
  camera.updateProjectionMatrix();
  controls.update();

  let tween = null;
  let activePreset = 'cinema';
  let lastInteraction = 0;

  function cancelTween() {
    tween = null;
    controls.enabled = true;
  }

  function beginTween(position, target, fov, duration = 1.25) {
    tween = {
      start: performance.now(),
      duration: duration * 1000,
      fromPosition: camera.position.clone(),
      toPosition: position.clone(),
      fromTarget: controls.target.clone(),
      toTarget: target.clone(),
      fromFov: camera.fov,
      toFov: fov
    };
    controls.enabled = false;
  }

  function setPreset(name, duration = 1.25) {
    const preset = PRESETS[name] || PRESETS.cinema;
    cancelTween();
    beginTween(preset.position, preset.target, preset.fov, duration);
    activePreset = name;
    onPresetChanged?.(name);
    lastInteraction = performance.now();
  }

  function setPresetImmediate(name) {
    const preset = PRESETS[name] || PRESETS.cinema;
    cancelTween();
    camera.position.copy(preset.position);
    controls.target.copy(preset.target);
    camera.fov = preset.fov;
    camera.updateProjectionMatrix();
    controls.update();
    activePreset = name;
    onPresetChanged?.(name);
  }

  function handleTween(now) {
    if (!tween) return false;
    const raw = Math.min(1, (now - tween.start) / tween.duration);
    const t = easeInOutCubic(raw);
    camera.position.lerpVectors(tween.fromPosition, tween.toPosition, t);
    controls.target.lerpVectors(tween.fromTarget, tween.toTarget, t);
    camera.fov = THREE.MathUtils.lerp(tween.fromFov, tween.toFov, t);
    camera.updateProjectionMatrix();
    camera.lookAt(controls.target);
    if (raw >= 1) {
      tween = null;
      controls.enabled = true;
      controls.update();
    }
    return true;
  }

  function bottleCenter() {
    return bottle.root.position.clone().add(new THREE.Vector3(0, 0.05, 0));
  }

  function focusBottle(duration = 1.0) {
    const target = bottleCenter();
    const offset = camera.position.clone().sub(controls.target);
    let distance = offset.length();
    if (distance < 0.1) {
      offset.set(0.35, 0.55, 1).normalize();
      distance = 4.5;
    } else {
      offset.normalize();
    }
    distance = THREE.MathUtils.clamp(distance, 3.5, 7.6);
    if (offset.y < 0.05) offset.y = 0.12;
    offset.normalize();
    beginTween(target.clone().addScaledVector(offset, distance), target, Math.min(camera.fov, 42), duration);
    lastInteraction = performance.now();
    activePreset = null;
    onPresetChanged?.(null);
  }

  function focusPoint(point, duration = 1.0) {
    const target = point.clone();
    const offset = camera.position.clone().sub(controls.target);
    let distance = offset.length();
    if (distance < 0.1) {
      offset.set(0.4, 0.8, 1.4);
      distance = 4;
    } else {
      offset.normalize();
    }
    distance = THREE.MathUtils.clamp(distance, 2.8, 14);
    if (offset.y < 0.02) offset.y = 0.18;
    offset.normalize();
    // The point is on the ground; back the camera out a touch.
    const destinationTarget = new THREE.Vector3(target.x, Math.max(target.y, 0.35), target.z);
    beginTween(destinationTarget.clone().addScaledVector(offset, distance), destinationTarget, camera.fov, duration);
    lastInteraction = performance.now();
    activePreset = null;
    onPresetChanged?.(null);
  }

  function notifyInteraction() {
    lastInteraction = performance.now();
    if (activePreset) {
      activePreset = null;
      onPresetChanged?.(null);
    }
    onUserInteract?.();
  }

  const pointerHandler = () => {
    if (tween) {
      cancelTween();
    }
    notifyInteraction();
  };
  const wheelHandler = () => {
    if (tween) cancelTween();
    notifyInteraction();
  };
  controlsElement?.addEventListener('pointerdown', pointerHandler, { passive: true });
  controlsElement?.addEventListener('wheel', wheelHandler, { passive: true });

  function enforceBounds() {
    const target = controls.target;
    target.x = THREE.MathUtils.clamp(target.x, -14, 14);
    target.z = THREE.MathUtils.clamp(target.z, -22, 10);
    target.y = THREE.MathUtils.clamp(target.y, 0.22, 6.5);

    const ground = environment?.getSandHeight ? environment.getSandHeight(camera.position.x, camera.position.z) : 0;
    const minY = Math.max(0.32, ground + 0.26);
    if (camera.position.y < minY) {
      camera.position.y = minY;
      camera.lookAt(controls.target);
    }
    // Never let the camera settle inside the glass. A gentle radial push is
    // enough because the orbit distance already keeps it outside.
    if (bottle?.isInsideCavity && bottle.isInsideCavity(camera.position, -0.06)) {
      const away = camera.position.clone().sub(bottle.root.position);
      if (away.lengthSq() < 0.0001) away.set(0, 0.6, 1);
      away.normalize();
      camera.position.copy(bottle.root.position).addScaledVector(away, 1.55);
      camera.lookAt(controls.target);
    }
    if (camera.position.distanceTo(controls.target) > 27) {
      const dir = camera.position.clone().sub(controls.target).normalize();
      camera.position.copy(controls.target).addScaledVector(dir, 27);
    }
  }

  function update(delta) {
    const now = performance.now();
    if (tween) {
      handleTween(now);
    } else {
      controls.update();
    }
    enforceBounds();
  }

  function reset(duration = 1.2) {
    setPreset('cinema', duration);
  }

  function getState() {
    return {
      position: camera.position.toArray(),
      target: controls.target.toArray(),
      fov: camera.fov,
      preset: activePreset,
      distance: camera.position.distanceTo(controls.target)
    };
  }

  function dispose() {
    controlsElement?.removeEventListener('pointerdown', pointerHandler);
    controlsElement?.removeEventListener('wheel', wheelHandler);
    controls.dispose();
  }

  setPresetImmediate('cinema');

  return {
    controls,
    setPreset,
    setPresetImmediate,
    focusBottle,
    focusPoint,
    update,
    reset,
    getState,
    dispose,
    presets: PRESETS
  };
}
