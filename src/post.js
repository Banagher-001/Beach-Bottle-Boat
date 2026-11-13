import * as THREE from 'three';

export const QUALITY_PRESETS = {
  fine: { label: '精致像素', scale: 2.0, levels: 48, dither: 0.9, shadow: 2048 },
  standard: { label: '标准像素', scale: 2.85, levels: 26, dither: 1.05, shadow: 1024 },
  retro: { label: '复古像素', scale: 3.8, levels: 12, dither: 1.2, shadow: 512 }
};

const POST_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const POST_FRAGMENT = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tDiffuse;
  uniform vec2 uResolution;
  uniform float uExposure;
  uniform float uLevels;
  uniform float uDither;
  uniform float uVignette;
  uniform float uGrain;
  uniform float uTime;
  uniform float uPixelScale;
  uniform float uBloomStrength;
  uniform float uBloomThreshold;

  float bayer4(vec2 p) {
    const float m[16] = float[16](
       0.0,  8.0,  2.0, 10.0,
      12.0,  4.0, 14.0,  6.0,
       3.0, 11.0,  1.0,  9.0,
      15.0,  7.0, 13.0,  5.0
    );
    ivec2 ip = ivec2(mod(p, 4.0));
    int index = ip.y * 4 + ip.x;
    return m[index] / 16.0 + 1.0 / 32.0;
  }

  vec3 acesFilm(vec3 x) {
    x = max(vec3(0.0), x);
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  }

  vec3 linearToSRGB(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    vec3 lo = c * 12.92;
    vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
    return mix(hi, lo, step(c, vec3(0.0031308)));
  }

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  void main() {
    vec2 uv = vUv;
    vec3 color = texture2D(tDiffuse, uv).rgb;
    vec2 px = 1.0 / uResolution;
    vec3 bloom = vec3(0.0);
    vec2 o1 = vec2(6.0, 0.0) * px;
    vec2 o2 = vec2(0.0, 6.0) * px;
    vec2 o3 = vec2(-6.0, 0.0) * px;
    vec2 o4 = vec2(0.0, -6.0) * px;
    vec2 o5 = vec2(15.0, 0.0) * px;
    vec2 o6 = vec2(-15.0, 0.0) * px;
    vec2 o7 = vec2(0.0, 15.0) * px;
    vec2 o8 = vec2(0.0, -15.0) * px;
    bloom += max(texture2D(tDiffuse, uv + o1).rgb - uBloomThreshold, 0.0);
    bloom += max(texture2D(tDiffuse, uv + o2).rgb - uBloomThreshold, 0.0);
    bloom += max(texture2D(tDiffuse, uv + o3).rgb - uBloomThreshold, 0.0);
    bloom += max(texture2D(tDiffuse, uv + o4).rgb - uBloomThreshold, 0.0);
    bloom += max(texture2D(tDiffuse, uv + o5).rgb - uBloomThreshold, 0.0) * 0.45;
    bloom += max(texture2D(tDiffuse, uv + o6).rgb - uBloomThreshold, 0.0) * 0.45;
    bloom += max(texture2D(tDiffuse, uv + o7).rgb - uBloomThreshold, 0.0) * 0.45;
    bloom += max(texture2D(tDiffuse, uv + o8).rgb - uBloomThreshold, 0.0) * 0.45;
    bloom /= 5.8;
    color += bloom * uBloomStrength;
    color *= uExposure;
    color = acesFilm(color);
    color = linearToSRGB(color);

    // Slight cool-shadow / warm-highlight grade reinforces the sunset mood.
    float luma = dot(color, vec3(0.299, 0.587, 0.114));
    vec3 shadowTint = vec3(0.86, 0.97, 1.045);
    vec3 highlightTint = vec3(1.035, 1.005, 0.94);
    color *= mix(mix(vec3(1.0), shadowTint, (1.0 - luma) * 0.14), highlightTint, smoothstep(0.3, 1.0, luma) * 0.12);
    color = mix(vec3(luma), color, 1.24);
    color = (color - 0.5) * 1.035 + 0.5;
    color = max(color, 0.0);
    color += vec3(0.002, 0.004, 0.007);

    float dither = bayer4(gl_FragCoord.xy);
    dither = (dither - 0.5) * (uDither / max(uLevels, 4.0));
    color += dither;
    color = floor(clamp(color, 0.0, 1.0) * uLevels + 0.5) / uLevels;

    // A whisper of animated film grain, quantized onto the pixel lattice.
    float grain = (hash12(gl_FragCoord.xy + floor(uTime * 7.0)) - 0.5) * uGrain / uLevels;
    color += grain;

    vec2 centered = uv - 0.5;
    float vignette = smoothstep(0.83, 0.28, length(centered * vec2(1.02, 0.94)));
    color *= 1.0 - uVignette * (1.0 - vignette);
    color *= 0.994 + 0.006 * smoothstep(0.0, 1.0, uv.y);

    gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
  }
`;

export function createPixelPipeline(renderer, scene, camera) {
  const target = new THREE.WebGLRenderTarget(2, 2, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
    stencilBuffer: false
  });
  target.texture.colorSpace = THREE.LinearSRGBColorSpace;
  target.texture.generateMipmaps = false;

  const postScene = new THREE.Scene();
  const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const uniforms = {
    tDiffuse: { value: target.texture },
    uResolution: { value: new THREE.Vector2(2, 2) },
    uExposure: { value: 1.0 },
    uLevels: { value: 48 },
    uDither: { value: 0.9 },
    uVignette: { value: 0.2 },
    uGrain: { value: 0.35 },
    uTime: { value: 0 },
    uPixelScale: { value: 2.0 },
    uBloomStrength: { value: 0.34 },
    uBloomThreshold: { value: 0.88 }
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: POST_VERTEX,
    fragmentShader: POST_FRAGMENT,
    depthTest: false,
    depthWrite: false,
    transparent: false
  });
  material.toneMapped = false;
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  postScene.add(quad);

  const state = {
    quality: 'fine',
    scale: 2.0,
    levels: 48,
    dither: 0.9,
    cssWidth: 1,
    cssHeight: 1,
    pixelWidth: 1,
    pixelHeight: 1
  };

  function updateSize(force = false) {
    const canvas = renderer.domElement;
    const cssWidth = Math.max(2, canvas.clientWidth || window.innerWidth);
    const cssHeight = Math.max(2, canvas.clientHeight || window.innerHeight);
    if (!force && cssWidth === state.cssWidth && cssHeight === state.cssHeight && state.lastScale === state.scale) {
      return;
    }
    state.cssWidth = cssWidth;
    state.cssHeight = cssHeight;
    state.lastScale = state.scale;
    const pixelWidth = Math.max(240, Math.round(cssWidth / state.scale));
    const pixelHeight = Math.max(135, Math.round(cssHeight / state.scale));
    state.pixelWidth = pixelWidth;
    state.pixelHeight = pixelHeight;
    renderer.setPixelRatio(1);
    renderer.setSize(pixelWidth, pixelHeight, false);
    target.setSize(pixelWidth, pixelHeight);
    uniforms.uResolution.value.set(pixelWidth, pixelHeight);
    uniforms.uPixelScale.value = state.scale;
    camera.aspect = cssWidth / cssHeight;
    camera.updateProjectionMatrix();
  }

  function setQuality(name) {
    const preset = QUALITY_PRESETS[name] || QUALITY_PRESETS.fine;
    state.quality = name;
    state.scale = preset.scale;
    state.levels = preset.levels;
    state.dither = preset.dither;
    uniforms.uLevels.value = preset.levels;
    uniforms.uDither.value = preset.dither;
    updateSize(true);
    return preset;
  }

  function setPixelScale(scale) {
    state.scale = THREE.MathUtils.clamp(scale, 1.0, 5.0);
    updateSize(true);
  }

  function setExposure(value) {
    uniforms.uExposure.value = THREE.MathUtils.clamp(value, 0.35, 2.4);
  }

  function setVignette(value) {
    uniforms.uVignette.value = THREE.MathUtils.clamp(value, 0, 0.45);
  }

  const lastSceneStats = { calls: 0, triangles: 0, points: 0, lines: 0 };

  function render(time) {
    updateSize(false);
    uniforms.uTime.value = time;
    renderer.setRenderTarget(target);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);
    lastSceneStats.calls = renderer.info.render.calls;
    lastSceneStats.triangles = renderer.info.render.triangles;
    lastSceneStats.points = renderer.info.render.points;
    lastSceneStats.lines = renderer.info.render.lines;
    renderer.setRenderTarget(null);
    renderer.clear(true, true, true);
    renderer.render(postScene, postCamera);
  }

  function getState() {
    return { ...state, uniforms, sceneStats: { ...lastSceneStats } };
  }

  function dispose() {
    target.dispose();
    material.dispose();
    quad.geometry.dispose();
  }

  return {
    render,
    updateSize,
    setQuality,
    setPixelScale,
    setExposure,
    setVignette,
    getState,
    uniforms,
    target,
    dispose
  };
}
