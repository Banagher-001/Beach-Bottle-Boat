import * as THREE from 'three';

/**
 * One analytic wave field shared by the GPU water surface, CPU buoyancy sampler,
 * foam distribution and safety checks. Waves are world-space and the surface is
 * horizontal on average even though the bottle is tilted.
 */
export const WAVE_COUNT = 4;
export const WATER_LEVEL_MIN = 0.58;
export const WATER_LEVEL_MAX = 1.0;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;

export class WaveField {
  constructor() {
    this.time = 0;
    this.params = {
      height: 35,
      speed: 1,
      density: 1.25,
      direction: 28,
      waterLevel: 42
    };
    this.baseLevel = 0.807;
    this.amplitude = 0.05;
    this.waves = [];
    this._lastKey = '';
    this.uniforms = {
      uTime: { value: 0 },
      uWaveA: { value: Array.from({ length: WAVE_COUNT }, () => new THREE.Vector4()) },
      uWaveB: { value: Array.from({ length: WAVE_COUNT }, () => new THREE.Vector2()) },
      uAmplitude: { value: 0.05 },
      uBaseLevel: { value: 0.807 }
    };
    this.configure(this.params);
  }

  mapWaterLevel(percent) {
    return lerp(WATER_LEVEL_MIN, WATER_LEVEL_MAX, clamp(percent, 0, 100) / 100);
  }

  configure(params) {
    Object.assign(this.params, params);
    const key = [
      this.params.height,
      this.params.speed,
      this.params.density,
      this.params.direction,
      this.params.waterLevel
    ].map((n) => Number(n).toFixed(4)).join('|');
    if (key === this._lastKey) return;
    this._lastKey = key;

    const p = this.params;
    this.baseLevel = this.mapWaterLevel(p.waterLevel);
    const height01 = clamp(p.height, 0, 100) / 100;
    // Safe room inside the bottle: total crest amplitude stays below the glass wall.
    this.amplitude = lerp(0, 0.16, Math.pow(height01, 0.88));

    const density = clamp(p.density, 0.5, 3.0);
    const speed = clamp(p.speed, 0.2, 3.0);
    const baseAngle = THREE.MathUtils.degToRad(clamp(p.direction, 0, 360));
    const weights = [0.36, 0.28, 0.215, 0.145];
    const angleOffsets = [-0.46, 0.14, 0.55, -0.16];
    const wavelengths = [1.75, 1.13, 0.78, 0.52];
    const phases = [0.65, 2.2, 4.35, 1.15];
    this.waves = wavelengths.map((wl, i) => {
      const wavelength = wl / density;
      const k = (Math.PI * 2) / wavelength;
      const omega = speed * (1.05 + 0.52 * i) * 1.55;
      const angle = baseAngle + angleOffsets[i];
      return {
        dx: Math.cos(angle),
        dz: Math.sin(angle),
        k,
        omega,
        amplitude: this.amplitude * weights[i],
        phase: phases[i],
        wavelength
      };
    });

    for (let i = 0; i < WAVE_COUNT; i++) {
      const w = this.waves[i];
      this.uniforms.uWaveA.value[i].set(w.dx, w.dz, w.amplitude, w.k);
      this.uniforms.uWaveB.value[i].set(w.omega, w.phase);
    }
    this.uniforms.uAmplitude.value = this.amplitude;
    this.uniforms.uBaseLevel.value = this.baseLevel;
  }

  setTime(time) {
    this.time = time;
    this.uniforms.uTime.value = time;
  }

  /** World-space wave elevation, excluding the mean water level. */
  rawHeightAt(x, z, time = this.time) {
    let h = 0;
    for (let i = 0; i < this.waves.length; i++) {
      const w = this.waves[i];
      h += w.amplitude * Math.sin((w.dx * x + w.dz * z) * w.k - w.omega * time + w.phase);
    }
    return h;
  }

  /** World-space water height. */
  heightAt(x, z, time = this.time) {
    return this.baseLevel + this.rawHeightAt(x, z, time);
  }

  /** Height, slope and crest value for buoyancy / foam. */
  sample(x, z, time = this.time) {
    let h = 0;
    let sx = 0;
    let sz = 0;
    for (let i = 0; i < this.waves.length; i++) {
      const w = this.waves[i];
      const ph = (w.dx * x + w.dz * z) * w.k - w.omega * time + w.phase;
      const s = Math.sin(ph);
      const c = Math.cos(ph);
      h += w.amplitude * s;
      sx += w.amplitude * w.k * w.dx * c;
      sz += w.amplitude * w.k * w.dz * c;
    }
    return {
      height: this.baseLevel + h,
      offset: h,
      slopeX: sx,
      slopeZ: sz,
      crest: this.amplitude > 1e-5 ? clamp(h / this.amplitude, -1.2, 1.2) : 0
    };
  }

  get shaderUniforms() {
    return this.uniforms;
  }

  static glsl() {
    return /* glsl */ `
uniform float uTime;
uniform vec4 uWaveA[${WAVE_COUNT}];
uniform vec2 uWaveB[${WAVE_COUNT}];
uniform float uAmplitude;
uniform float uBaseLevel;

float waveOffset(vec2 p, out vec2 slope) {
  float h = 0.0;
  slope = vec2(0.0);
  for (int i = 0; i < ${WAVE_COUNT}; i++) {
    vec4 a = uWaveA[i];
    vec2 b = uWaveB[i];
    float phase = dot(a.xy, p) * a.w - b.x * uTime + b.y;
    h += a.z * sin(phase);
    slope += a.z * a.w * a.xy * cos(phase);
  }
  return h;
}

float waveHeight(vec2 p) {
  vec2 s;
  return uBaseLevel + waveOffset(p, s);
}

vec3 waveNormal(vec2 p) {
  vec2 s;
  waveOffset(p, s);
  return normalize(vec3(-s.x, 1.0, -s.y));
}
`;
  }
}
