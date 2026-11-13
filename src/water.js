import * as THREE from 'three';
import { CAVITY_GLSL } from './bottle.js';
import { WaveField } from './waves.js';

const toLinear = (hex) => new THREE.Color(hex).convertSRGBToLinear();

const SURFACE_VERTEX = /* glsl */ `
  ${WaveField.glsl()}
  varying vec3 vWorldPos;
  varying float vWaveOffset;
  void main() {
    vec3 world = (modelMatrix * vec4(position, 1.0)).xyz;
    vec2 slope;
    float offset = waveOffset(world.xz, slope);
    world.y = uBaseLevel + offset;
    vWorldPos = world;
    vWaveOffset = offset;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const SURFACE_FRAGMENT = /* glsl */ `
  ${WaveField.glsl()}
  ${CAVITY_GLSL}
  varying vec3 vWorldPos;
  varying float vWaveOffset;
  uniform mat4 uBottleCavityInv;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uSkyColor;
  uniform vec3 uHorizonColor;
  uniform vec3 uDeepColor;
  uniform vec3 uShallowColor;
  uniform vec3 uFoamColor;
  uniform float uFoamStrength;
  uniform float uOpacity;

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  void main() {
    vec3 localPoint = (uBottleCavityInv * vec4(vWorldPos, 1.0)).xyz;
    if (!insideBottleCavity(localPoint, 0.052)) discard;

    float edge = bottleCavityEdge(localPoint, 0.19);
    vec3 normal = waveNormal(vWorldPos.xz);
    normal = normalize(vec3(normal.x * 1.55, 1.0, normal.z * 1.55));
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float fresnel = pow(1.0 - clamp(dot(normal, viewDir), 0.0, 1.0), 2.4);
    float heightN = vWaveOffset / max(uAmplitude, 0.008);

    float depthBlend = smoothstep(-0.9, 1.05, heightN);
    vec3 color = mix(uDeepColor, uShallowColor, depthBlend * 0.58 + fresnel * 0.28);

    // Broad, stepped colour bands make the waves read like refined pixel art.
    float bands = sin(heightN * 6.8 + edge * 4.0 + uTime * 0.22) * 0.5 + 0.5;
    color *= 0.94 + bands * 0.12;

    vec3 reflected = reflect(-viewDir, normal);
    vec3 skyReflection = mix(uHorizonColor, uSkyColor, clamp(reflected.y * 1.3 + 0.12, 0.0, 1.0));
    color = mix(color, skyReflection, fresnel * 0.30 + 0.012);

    vec3 halfDir = normalize(uSunDir + viewDir);
    float spec = pow(max(dot(normal, halfDir), 0.0), 150.0);
    float sparkle = hash12(floor(vWorldPos.xz * 42.0) + floor(uTime * 2.1));
    spec *= 0.35 + step(0.58, sparkle) * 1.8;
    color += uSunColor * spec * 2.0;

    float crestFoam = smoothstep(0.58, 1.02, heightN);
    float edgeFoam = smoothstep(0.45, 0.92, edge);
    float foamNoise = hash12(floor(vWorldPos.xz * 47.0) + vec2(floor(uTime * 3.0)));
    float foam = (crestFoam * 0.32 + edgeFoam * 0.34) * uFoamStrength;
    foam *= 0.16 + foamNoise * 0.9;
    foam = clamp(foam, 0.0, 0.52);
    color = mix(color, uFoamColor, foam * 0.58);

    float alpha = mix(0.93, 0.992, fresnel);
    alpha *= mix(1.0, 0.74, edgeFoam * 0.7);
    alpha *= uOpacity;
    gl_FragColor = vec4(color, alpha);
  }
`;

const VOLUME_VERTEX = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPos = world.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const VOLUME_FRAGMENT = /* glsl */ `
  ${WaveField.glsl()}
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  uniform vec3 uDeepColor;
  uniform vec3 uShallowColor;
  uniform vec3 uSunColor;
  uniform float uOpacity;

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  void main() {
    vec2 p = vWorldPos.xz;
    float surface = waveHeight(p);
    if (vWorldPos.y > surface - 0.004) discard;

    float depth = clamp((surface - vWorldPos.y) / 0.62, 0.0, 1.0);
    vec3 color = mix(uShallowColor * 0.55, uDeepColor * 0.8, smoothstep(0.0, 0.9, depth));
    float caustic = sin(vWorldPos.x * 19.0 + sin(vWorldPos.z * 12.0 + uTime * 0.6) * 1.2 + uTime * 0.35);
    caustic = smoothstep(0.55, 1.0, caustic);
    color += uSunColor * caustic * (0.035 + depth * 0.06);

    float fuzz = hash12(floor(p * 36.0)) * 0.012;
    float alpha = (0.10 + depth * 0.30 + fuzz) * uOpacity;
    gl_FragColor = vec4(color, alpha);
  }
`;

export function createBottleWater({ scene, bottle, waveField, state }) {
  const waveUniforms = waveField.shaderUniforms;
  const sunDir = new THREE.Vector3(0.1, 0.18, -0.98).normalize();
  const sunColor = toLinear(0xffc97f);
  const skyColor = toLinear(0x665875);
  const horizonColor = toLinear(0xf08a58);
  const deepColor = toLinear(0x021f24);
  const shallowColor = toLinear(0x0d7773);
  const foamColor = toLinear(0xffedcf);

  const surfaceUniforms = {
    ...waveUniforms,
    uBottleCavityInv: bottle.clipUniforms.uBottleCavityInv,
    uSunDir: { value: sunDir },
    uSunColor: { value: sunColor },
    uSkyColor: { value: skyColor },
    uHorizonColor: { value: horizonColor },
    uDeepColor: { value: deepColor },
    uShallowColor: { value: shallowColor },
    uFoamColor: { value: foamColor },
    uFoamStrength: { value: state.spray ? 1 : 0 },
    uOpacity: { value: 0.99 }
  };

  const surfaceGeometry = new THREE.PlaneGeometry(7.2, 4.0, 112, 64);
  surfaceGeometry.rotateX(-Math.PI / 2);
  const surfaceMaterial = new THREE.ShaderMaterial({
    uniforms: surfaceUniforms,
    vertexShader: SURFACE_VERTEX,
    fragmentShader: SURFACE_FRAGMENT,
    defines: {
      WAVE_COUNT: 4
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide
  });
  surfaceMaterial.renderOrder = 4;
  const surface = new THREE.Mesh(surfaceGeometry, surfaceMaterial);
  surface.name = 'BottleOceanSurface';
  surface.frustumCulled = false;
  surface.castShadow = false;
  surface.receiveShadow = false;
  scene.add(surface);

  const volumeUniforms = {
    ...waveUniforms,
    uDeepColor: { value: deepColor },
    uShallowColor: { value: shallowColor },
    uSunColor: { value: sunColor },
    uOpacity: { value: 1.0 }
  };
  const volumeMaterial = new THREE.ShaderMaterial({
    uniforms: volumeUniforms,
    vertexShader: VOLUME_VERTEX,
    fragmentShader: VOLUME_FRAGMENT,
    defines: { WAVE_COUNT: 4 },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending
  });
  volumeMaterial.renderOrder = 3;
  const volume = new THREE.Mesh(bottle.cavityGeometry, volumeMaterial);
  volume.name = 'BottleWaterVolume';
  volume.renderOrder = 3;
  volume.frustumCulled = false;
  bottle.tilt.add(volume);

  const foamBits = makeFoamBits(bottle, waveField, foamColor);
  scene.add(foamBits.group);

  function setSun(direction, colorHexOrColor, sunset = 0.45) {
    if (direction) {
      sunDir.copy(direction).normalize();
    }
    if (colorHexOrColor) {
      sunColor.copy(colorHexOrColor);
    }
    // Reflection palette follows the time-of-day without changing the physical wave field.
    const t = THREE.MathUtils.clamp(sunset, 0, 1);
    horizonColor.copy(new THREE.Color().setHSL(0.055 + t * 0.02, 0.82 - t * 0.2, 0.55 + t * 0.12).convertSRGBToLinear());
    skyColor.copy(new THREE.Color().setHSL(0.69, 0.26, 0.32 - t * 0.08).convertSRGBToLinear());
    shallowColor.copy(new THREE.Color().setHSL(0.47 - t * 0.01, 0.56, 0.35 + t * 0.04).convertSRGBToLinear());
  }

  function setFoamEnabled(enabled) {
    surfaceUniforms.uFoamStrength.value = enabled ? 1 : 0.15;
    foamBits.setEnabled(enabled);
  }

  function setFoamStrength(value) {
    surfaceUniforms.uFoamStrength.value = value;
  }

  function update(time, delta) {
    volumeMaterial.uniforms.uTime.value = time;
    foamBits.update(time, delta);
  }

  function setWaterLevel(percent) {
    // Dim the volume a little when the bottle is only a shallow puddle.
    const f = THREE.MathUtils.clamp(percent / 100, 0, 1);
    volumeUniforms.uOpacity.value = THREE.MathUtils.lerp(0.7, 1.1, f);
  }

  function dispose() {
    scene.remove(surface);
    surfaceGeometry.dispose();
    surfaceMaterial.dispose();
    bottle.tilt.remove(volume);
    volumeMaterial.dispose();
    scene.remove(foamBits.group);
    foamBits.dispose();
  }

  return {
    surface,
    surfaceMaterial,
    volume,
    volumeMaterial,
    foamBits,
    setSun,
    setFoamEnabled,
    setFoamStrength,
    setWaterLevel,
    update,
    dispose
  };
}

function makeFoamBits(bottle, waveField, foamColor) {
  const count = 34;
  const positions = new Float32Array(count * 3);
  const seeds = [];
  let seed = 9327;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < count; i++) {
    const angle = rand() * Math.PI * 2;
    const radius = 0.12 + Math.pow(rand(), 0.55) * 0.68;
    const local = new THREE.Vector3(
      Math.cos(angle) * radius,
      -1.85 + rand() * 3.65,
      Math.sin(angle) * radius * 0.94
    );
    const world = bottle.cavityToWorld(local);
    positions[i * 3] = world.x;
    positions[i * 3 + 1] = world.y;
    positions[i * 3 + 2] = world.z;
    seeds.push({
      phase: rand() * Math.PI * 2,
      speed: 0.25 + rand() * 0.55,
      frequency: 1.2 + rand() * 1.8,
      baseY: rand() * 0.05,
      wobble: 0.03 + rand() * 0.05
    });
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: foamColor.clone(),
    size: 0.022,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  material.renderOrder = 5;
  const points = new THREE.Points(geometry, material);
  points.name = 'BottleFoamMotes';
  points.frustumCulled = false;
  const group = new THREE.Group();
  group.add(points);
  const base = positions.slice();
  let enabled = true;

  function update(time) {
    if (!enabled) return;
    for (let i = 0; i < count; i++) {
      const s = seeds[i];
      const wave = waveField.rawHeightAt(base[i * 3], base[i * 3 + 2]);
      positions[i * 3] = base[i * 3] + Math.sin(time * s.speed + s.phase) * s.wobble;
      positions[i * 3 + 1] = waveField.baseLevel + wave + 0.006 + s.baseY + Math.sin(time * s.frequency + s.phase) * 0.018;
      positions[i * 3 + 2] = base[i * 3 + 2] + Math.cos(time * s.speed * 0.7 + s.phase) * s.wobble;
    }
    geometry.attributes.position.needsUpdate = true;
  }

  function setEnabled(value) {
    enabled = value;
    points.visible = value;
  }

  function dispose() {
    group.remove(points);
    geometry.dispose();
    material.dispose();
  }

  return { group, points, update, setEnabled, dispose };
}
