import * as THREE from 'three';

/**
 * Development placeholder environment. The production world lives in src/world.js.
 * This file only exists so the core bottle/water/boat/UI can be integrated and
 * visually tested while the detailed art pass is being authored.
 */
export function createEnvironment({ scene, renderer, state, quality }) {
  const group = new THREE.Group();
  group.name = 'EnvironmentStub';
  scene.add(group);

  const sunDirection = new THREE.Vector3(0.1, 0.09, -0.99).normalize();
  scene.fog = new THREE.FogExp2(0x8b625f, 0.0085);

  const hemi = new THREE.HemisphereLight(0xffd0a2, 0x352528, 1.35);
  group.add(hemi);
  const ambient = new THREE.AmbientLight(0x5a5d76, 0.45);
  group.add(ambient);

  const sunLight = new THREE.DirectionalLight(0xffc184, 3.1);
  sunLight.position.copy(sunDirection).multiplyScalar(45);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.camera.left = -10;
  sunLight.shadow.camera.right = 12;
  sunLight.shadow.camera.top = 9;
  sunLight.shadow.camera.bottom = -5;
  sunLight.shadow.camera.near = 1;
  sunLight.shadow.camera.far = 90;
  sunLight.shadow.bias = -0.0005;
  sunLight.shadow.normalBias = 0.025;
  group.add(sunLight);
  group.add(sunLight.target);

  const skyUniforms = {
    uTop: { value: new THREE.Color(0x2c2440).convertSRGBToLinear() },
    uMid: { value: new THREE.Color(0x7e4f6e).convertSRGBToLinear() },
    uHorizon: { value: new THREE.Color(0xff9c59).convertSRGBToLinear() },
    uSunColor: { value: new THREE.Color(0xffd9a4).convertSRGBToLinear() },
    uSunDir: { value: sunDirection.clone() },
    uTime: { value: 0 }
  };
  const skyMat = new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }
    `,
    fragmentShader: `
      varying vec3 vDir;
      uniform vec3 uTop;
      uniform vec3 uMid;
      uniform vec3 uHorizon;
      uniform vec3 uSunColor;
      uniform vec3 uSunDir;
      uniform float uTime;
      void main() {
        vec3 d = normalize(vDir);
        float elev = clamp(d.y, -0.1, 1.0);
        vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.24, elev));
        col = mix(col, uTop, smoothstep(0.2, 0.8, elev));
        float sunDot = max(dot(d, normalize(uSunDir)), 0.0);
        col += uSunColor * pow(sunDot, 350.0) * 7.0;
        col += uSunColor * pow(sunDot, 16.0) * 0.32;
        float cloud = smoothstep(0.64, 0.85, sin(d.x * 23.0 + d.z * 18.0 + sin(d.z * 40.0) * 1.2) * 0.5 + 0.5) * smoothstep(0.02, 0.25, elev) * (1.0 - smoothstep(0.4, 0.7, elev));
        col = mix(col, uSunColor * 0.55, cloud * 0.24);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false
  });
  const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(300, 40, 24), skyMat);
  skyMesh.name = 'StubSky';
  group.add(skyMesh);

  const environmentMap = makeEnvMap(renderer, sunDirection);
  scene.environment = environmentMap;

  function sandHeight(x, z) {
    let h = 0.18 + 0.055 * Math.sin(x * 0.62 + 1.3) + 0.04 * Math.sin(z * 0.7 - 0.4);
    h += 0.032 * Math.sin(x * 1.8 + z * 0.8);
    const bed = Math.exp(-Math.pow((x + 0.25) / 3.5, 2) - Math.pow((z - 0.05) / 1.55, 2));
    h += bed * 0.24 * (0.8 + 0.15 * Math.sin(x * 0.7));
    const shore = THREE.MathUtils.smoothstep(z, -2.0, -9.0);
    h -= shore * 1.0;
    const leftDune = Math.exp(-Math.pow((x + 4.6) / 3.2, 2) - Math.pow((z - 2.2) / 3.0, 2));
    h += leftDune * 0.6;
    return h;
  }

  const NX = 150;
  const NZ = 110;
  const terrainWidth = 62;
  const terrainDepth = 38;
  const terrainGeo = new THREE.PlaneGeometry(terrainWidth, terrainDepth, NX, NZ);
  terrainGeo.rotateX(-Math.PI / 2);
  const pos = terrainGeo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const cDry = new THREE.Color(0xc79763).convertSRGBToLinear();
  const cWet = new THREE.Color(0x7a5b48).convertSRGBToLinear();
  const cDark = new THREE.Color(0x4d3a35).convertSRGBToLinear();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = sandHeight(x, z);
    pos.setY(i, y);
    const wet = THREE.MathUtils.smoothstep(z, -2.5, -5.5);
    const c = cDry.clone().lerp(cWet, wet).lerp(cDark, wet * 0.42);
    const grain = 0.92 + 0.16 * Math.sin(x * 8.7 + z * 3.1) * Math.sin(x * 3.2 - z * 9.1);
    c.multiplyScalar(grain);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  terrainGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  terrainGeo.computeVertexNormals();
  const terrainMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.96,
    metalness: 0,
    color: 0xffffff
  });
  const terrain = new THREE.Mesh(terrainGeo, terrainMaterial);
  terrain.name = 'StubTerrain';
  terrain.receiveShadow = true;
  group.add(terrain);

  const oceanUniforms = {
    uTime: { value: 0 },
    uSunDir: { value: sunDirection.clone() },
    uDeep: { value: new THREE.Color(0x07242e).convertSRGBToLinear() },
    uShallow: { value: new THREE.Color(0x165b5a).convertSRGBToLinear() },
    uSun: { value: new THREE.Color(0xffbd7c).convertSRGBToLinear() },
    uHorizon: { value: new THREE.Color(0xffa267).convertSRGBToLinear() }
  };
  const oceanGeometry = new THREE.PlaneGeometry(320, 260, 130, 80);
  oceanGeometry.rotateX(-Math.PI / 2);
  const oceanMaterial = new THREE.ShaderMaterial({
    uniforms: oceanUniforms,
    vertexShader: `
      uniform float uTime;
      varying vec3 vWorld;
      varying float vH;
      void main() {
        vec3 p = (modelMatrix * vec4(position, 1.0)).xyz;
        float h = sin(p.x * 0.18 + uTime * 0.8) * 0.05 + sin(p.z * 0.12 - uTime * 0.6) * 0.04 + sin((p.x + p.z) * 0.4 + uTime) * 0.018;
        p.y += h;
        vWorld = p;
        vH = h;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vWorld;
      varying float vH;
      uniform vec3 uDeep;
      uniform vec3 uShallow;
      uniform vec3 uSun;
      uniform vec3 uHorizon;
      uniform vec3 uSunDir;
      void main() {
        vec3 v = normalize(cameraPosition - vWorld);
        vec3 n = normalize(vec3(-cos(vWorld.x * 0.18) * 0.018, 1.0, -cos(vWorld.z * 0.12) * 0.012));
        float fres = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 3.0);
        vec3 col = mix(uDeep, uShallow, 0.35 + fres * 0.3);
        col = mix(col, uHorizon, fres * 0.55);
        vec3 h = normalize(uSunDir + v);
        col += uSun * pow(max(dot(n, h), 0.0), 200.0) * 3.0;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    fog: false
  });
  const ocean = new THREE.Mesh(oceanGeometry, oceanMaterial);
  ocean.position.set(0, -0.24, -140);
  group.add(ocean);

  const raycastTargets = [terrain];
  const rockGroup = new THREE.Group();
  group.add(rockGroup);
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x4b3d39, roughness: 0.95, flatShading: true });
  [[-4.5, 2.4, -0.5], [4.6, -1.6, -0.4], [-3.8, -7.5, -0.2], [7.2, -9, -0.5]].forEach(([x, z, s]) => {
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.6 + Math.abs(s) * 0.4, 0), rockMat);
    rock.position.set(x, sandHeight(x, z) + 0.12, z);
    rock.rotation.set(0.4, x * 1.7, 0.2);
    rock.scale.set(1.3, 0.65, 0.95);
    rock.castShadow = true;
    rock.receiveShadow = true;
    rockGroup.add(rock);
    raycastTargets.push(rock);
  });

  const lighthouseGroup = new THREE.Group();
  lighthouseGroup.name = 'Lighthouse';
  group.add(lighthouseGroup);
  const cliffX = 9.7;
  const cliffZ = -24.5;
  const cliff = new THREE.Mesh(new THREE.DodecahedronGeometry(2.6, 0), new THREE.MeshStandardMaterial({ color: 0x3b302f, roughness: 1, flatShading: true }));
  cliff.position.set(cliffX, 0.6, cliffZ);
  cliff.scale.set(1.45, 1.4, 1.2);
  cliff.receiveShadow = true;
  lighthouseGroup.add(cliff);
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.44, 4.8, 12), new THREE.MeshStandardMaterial({ color: 0xe9e2d2, roughness: 0.65 }));
  tower.position.set(cliffX, 3.4, cliffZ);
  tower.castShadow = true;
  lighthouseGroup.add(tower);
  const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.42, 10), new THREE.MeshStandardMaterial({ color: 0x17181a, roughness: 0.45 }));
  lamp.position.set(cliffX, 5.95, cliffZ);
  lighthouseGroup.add(lamp);
  const lampGlow = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffc36d).convertSRGBToLinear() }));
  lampGlow.position.set(cliffX, 5.95, cliffZ);
  lighthouseGroup.add(lampGlow);
  const lampLight = new THREE.PointLight(0xffb35c, 18, 25, 2);
  lampLight.position.copy(lampGlow.position);
  lighthouseGroup.add(lampLight);
  const beam = new THREE.Mesh(new THREE.ConeGeometry(1.3, 15, 24, 1, true), new THREE.MeshBasicMaterial({
    color: new THREE.Color(0xffc47a).convertSRGBToLinear(),
    transparent: true,
    opacity: 0.06,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    depthWrite: false
  }));
  beam.rotation.z = Math.PI / 2;
  beam.position.set(cliffX, 5.95, cliffZ);
  lighthouseGroup.add(beam);
  const hitObjects = [tower, lamp, lampGlow];

  const dustGeometry = new THREE.BufferGeometry();
  const dustCount = 130;
  const dustPos = new Float32Array(dustCount * 3);
  for (let i = 0; i < dustCount; i++) {
    dustPos[i * 3] = (Math.random() - 0.5) * 15;
    dustPos[i * 3 + 1] = 0.3 + Math.random() * 2.6;
    dustPos[i * 3 + 2] = (Math.random() - 0.5) * 10;
  }
  dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dustMaterial = new THREE.PointsMaterial({ color: 0xffd4a0, size: 0.025, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending });
  const dust = new THREE.Points(dustGeometry, dustMaterial);
  group.add(dust);

  const props = [];
  function addProp(kind, point) {
    const geo = kind === 'shell' ? new THREE.TorusGeometry(0.14, 0.035, 6, 14, Math.PI * 1.4) : new THREE.DodecahedronGeometry(0.16, 0);
    const mat = kind === 'shell' ? new THREE.MeshStandardMaterial({ color: 0xf1d8ba, roughness: 0.45 }) : rockMat;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(point.x, sandHeight(point.x, point.z) + 0.05, point.z);
    mesh.rotation.set(kind === 'shell' ? -Math.PI / 2 : Math.random(), Math.random() * 3, Math.random());
    mesh.castShadow = true;
    group.add(mesh);
    props.push(mesh);
    return mesh;
  }

  function update(time, delta, stateNow) {
    oceanUniforms.uTime.value = time;
    skyUniforms.uTime.value = time;
    dust.rotation.y = time * 0.015 * (stateNow?.wind || 0.2);
    beam.rotation.x = time * 0.16;
    beam.visible = stateNow?.lighthouse !== false;
    lampLight.intensity = stateNow?.lighthouse !== false ? 18 : 0;
    lampGlow.visible = stateNow?.lighthouse !== false;
    dust.visible = stateNow?.dust !== false;
  }

  function setLighthouse(on) {
    lampLight.intensity = on ? 18 : 0;
    lampGlow.visible = on;
    beam.visible = on;
  }

  function applySunset(value) {
    const t = THREE.MathUtils.clamp(value, 0, 1);
    skyUniforms.uHorizon.value.setHSL(0.055 + t * 0.02, 0.76, 0.53 - t * 0.07).convertSRGBToLinear();
    skyUniforms.uMid.value.setHSL(0.78, 0.24, 0.34 - t * 0.1).convertSRGBToLinear();
    skyUniforms.uTop.value.setHSL(0.69, 0.3, 0.2 - t * 0.05).convertSRGBToLinear();
  }

  const env = {
    group,
    sunDirection,
    sunLight,
    envMap: environmentMap,
    skyMesh,
    terrain,
    terrainMaterial,
    sandHeight,
    getSandHeight: sandHeight,
    ocean,
    lighthouse: {
      group: lighthouseGroup,
      setEnabled: setLighthouse,
      isEnabled: () => lampGlow.visible,
      update: () => {},
      hitObjects
    },
    raycastTargets,
    update,
    applySunset,
    applyBrightness: () => {},
    setLighthouse,
    setDustEnabled: (on) => { dust.visible = on; },
    setSprayEnabled: () => {},
    setWind: () => {},
    addProp,
    undoProp: () => {
      const p = props.pop();
      if (p) group.remove(p);
    },
    resetProps: () => {
      while (props.length) group.remove(props.pop());
    },
    getTerrainPoint: (p) => new THREE.Vector3(p.x, sandHeight(p.x, p.z), p.z),
    dispose: () => {}
  };
  setLighthouse(state.lighthouse !== false);
  applySunset(state.sunset || 0.45);
  return env;
}

function makeEnvMap(renderer, sunDirection) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#4d4168');
  grad.addColorStop(0.36, '#9a5f76');
  grad.addColorStop(0.5, '#ffad6b');
  grad.addColorStop(0.53, '#b97454');
  grad.addColorStop(0.7, '#382926');
  grad.addColorStop(1, '#241b1b');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 512, 256);
  const sx = 256 + Math.atan2(sunDirection.x, -sunDirection.z) / Math.PI * 256;
  const sy = 128 - sunDirection.y * 256;
  const sun = ctx.createRadialGradient(sx, sy, 2, sx, sy, 55);
  sun.addColorStop(0, 'rgba(255,248,218,1)');
  sun.addColorStop(0.12, 'rgba(255,210,141,0.9)');
  sun.addColorStop(0.5, 'rgba(255,155,87,0.28)');
  sun.addColorStop(1, 'rgba(255,130,60,0)');
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, 512, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envMap = pmrem.fromEquirectangular(texture).texture;
  texture.dispose();
  pmrem.dispose();
  return envMap;
}
