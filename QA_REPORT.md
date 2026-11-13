# QA Report -- Bottle Ocean Sandbox

**Overall verdict: PASS**  
Generated: 2026-10-28T09:57:57.887Z  
Artifact: `bottle_ocean_sandbox.html`  
Checks: 83 total, 81 PASS, 0 FAIL, 0 WARN, 0 SKIP

## Acceptance summary (A-H)

| Cat | Area | Verdict | PASS/total | FAIL | WARN | SKIP |
| --- | --- | --- | --- | --- | --- | --- |
| A | Offline single-file loading, API, console/network hygiene | PASS | 12/12 | 0 | 0 | 0 |
| B | Visual/render integrity, canvas & UI fidelity | PASS | 13/13 | 0 | 0 | 0 |
| C | Wave height control & wave -> boat coupling | PASS | 11/11 | 0 | 0 | 0 |
| D | Wave direction control & motion signature | PASS | 8/8 | 0 | 0 | 0 |
| E | Camera presets, orbit drag & wheel zoom | PASS | 11/11 | 0 | 0 | 0 |
| F | Pause/resume, reset, screenshot, lighthouse, editing | PASS | 14/14 | 0 | 0 | 0 |
| G | Performance/FPS & quality presets | PASS | 7/7 | 0 | 0 | 0 |
| H | Responsive 1280x720 layout | PASS | 5/5 | 0 | 0 | 0 |

## Environment & method

- Host: win32 x64, Node v24.21.0
- Browser: Google Chrome 156.0.8078.48 (headless=true, mode=hardware)
- WebGL probe: {"ok":true,"webgl2":true,"renderer":"ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)","vendor":"Google Inc. (NVIDIA)","version":"WebGL 2.0 (OpenGL ES 3.0 Chromium)","readback":[64,127,191,255],"error":null}
- Viewport: 1920x1080 @ dsf=1; tablet/narrow pass at 1280x720
- Targets: file:// +  http://127.0.0.1:8123 (local static server, zero external network allowed)
- Harness: Playwright drives the real DOM; pixel statistics from PNG screenshots decoded in-page; motion from sampled `getDiagnostics()` + live boat object.
- Warmup 1500 ms, wave settle 3000 ms; diagnostics sampled 64x over 3.6s per stable wave setting (>=40 samples / >=2s as specified, window widened to cover full wave periods), 56x over 3s per wave direction.

## Artifact facts

| Metric | Value |
| --- | --- |
| Size | 1932.9 KiB (1979264 bytes) |
| Inline <script> blocks | 1 (1944427 bytes) |
| External <script src> | none |
| External <link href> | none |
| External script/link refs | 0 |
| Import map count / external | 0 / false |
| Bundled Three.js markers | REVISION180=true, WebGLRenderer=true, ShaderMaterial=true |
| HTML open external URL strings | 25 |
| CSP meta | false |
| sha256 (tested build) | 941feb2ea6ddd3cc93aad5b0b92dbca52ee66a3e1098fee0dbf16f01ca63d1ef |
| mtime / size | 2026-10-28T09:49:54.977Z / 1979264 bytes |
| stable during run | yes |

External URL strings found in HTML (may be inert namespace/docs strings; network guard verifies no fetch): `https://en.wikipedia.org/wiki/Universally_unique_identifier}`, `http://www.rorydriscoll.com/2016/03/07/frame-rate-independent-damping-using-lerp/}.`, `http://en.wikipedia.org/wiki/Smoothstep}`, `https://en.wikipedia.org/wiki/Smoothstep#Variations}`, `https://en.wikipedia.org/wiki/Euler_angles}`, `https://en.wikipedia.org/wiki/Invertible_matrix#Analytic_solution}.`, `http://www.w3.org/1999/xhtml`, `https://www.russellcottrell.com/photo/matrixCalculator.htm`

## Load, network & console

| Target | Ready | Console errors | Page errors | Failed requests | HTTP >=400 | Console messages |
| --- | --- | --- | --- | --- | --- | --- |
| file | ready in 1742ms | 0 | 0 | 0 | 0 | 0 |
| http | ready in 201ms | 0 | 0 | 0 | 0 | 0 |

- External network attempts during the whole run: **0** (must be 0).
- Console warnings: none.

## Render & canvas fidelity

| Frame | Mean brightness | Std brightness | Dark fraction | Colorful fraction | Unique colors | rAF FPS |
| --- | --- | --- | --- | --- | --- | --- |
| file | 97.35 | 47.69 | 0.0104 | 0.8365 | 2597 | 60.4 |
| http | 97.36 | 47.69 | 0.0103 | 0.8363 | 2587 | 60.4 |

- Canvas buffer: 960x540 displayed at 1920x1080 (coverage 100% x 100%).
- image-rendering: `crisp-edges`; context: webgl2; dpr: 1.
- DOM UI: 12 range inputs, 9 data-action buttons, 5 camera presets, 3 quality buttons, 12 readouts.
- [B11] hide UI (eye button) hides panel/brand/hint/stats and reveals restore control: **PASS** — {"hideClick":{"ok":true},"hiddenElementsOk":true,"restoreVisible":true,"before":{"bodyClass":"","uiHiddenFlag":false,"panel":{"visibility":"visible","opacity":1,"display":"flex","width":348,"height":931,"x":1552,"y":20},"brand":{"visibility":"visible","opacity":1,"display":"block","width":312,"height":99,"x":26,"y":24},"hint":{"visibility":"visible","opacity":1,"display":"flex","width":189,"height":46,"x":26,"y":1010},"stats":{"visibility":"visible","opacity":1,"display":"flex","width":176,"height":21,"x":26,"y":977},"restore":{"visibility":"visible","opacity":0,"display":"flex","width":34,"height":34,"x":1866,"y":20},"canvas":{"visibility":"...
- [B12] restore UI (keyboard H) brings the panel back: **PASS** — {"restored":{"bodyClass":"","uiHiddenFlag":false,"panel":{"visibility":"visible","opacity":0.950514,"display":"flex","width":348,"height":931,"x":1553,"y":20},"brand":{"visibility":"visible","opacity":1,"display":"block","width":312,"height":99,"x":26,"y":24},"hint":{"visibility":"visible","opacity":1,"display":"flex","width":189,"height":46,"x":26,"y":1010},"stats":{"visibility":"visible","opacity":1,"display":"flex","width":176,"height":21,"x":26,"y":977},"restore":{"visibility":"visible","opacity":0,"display":"flex","width":34,"height":34,"x":1866,"y":20},"canvas":{"visibility":"visible","opacity":1,"display":"block","width":1920,"height":...
- [B13] control panel fits 1920x1080: sections, camera presets and sandbox buttons all visible without scrolling: **PASS** — {"panelFits":true,"noScrollNeeded":true,"sectionsVisible":true,"presetsVisible":true,"sandboxVisible":true,"pauseVisible":true,"scroll":{"top":91,"bottom":889.84375,"left":1553,"right":1899,"width":346,"height":798.84375,"visibility":"visible","display":"block","opacity":1,"scrollHeight":799,"clientHeight":799,"scrollTop":0},"sections":[{"text":"01","visible":true,"inScrollWindow":true},{"text":"02","visible":true,"inScrollWindow":true},{"text":"03","visible":true,"inScrollWindow":true},{"text":"04","visible":true,"inScrollWindow":true},{"text":"05","visible":true,"inScrollWindow":true}],"presets":[{"name":"cinema","visible":true,"inScrollWin...

## C. Wave height -> boat coupling

| UI setting | Boat heave amp | Pitch amp | Roll amp | Wave telemetry mean | Samples | Non-finite | Screenshot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| calm (0) | 0 | 0.00002 | 0 | 0 | 64 | 0 | 10-calm.png |
| medium (50) | 0.06515 | 0.09066 | 0.10608 | 0.0869 | 64 | 0 | 11-medium.png |
| strong (100) | 0.13034 | 0.1839 | 0.20836 | 0.16 | 64 | 0 | 12-strong.png |

| setParam value | Hook | Boat heave amp | Pitch amp |
| --- | --- | --- | --- |
| calm (0) | ok | 0.00006 | 0.00128 |
| medium (50) | ok | 0.03932 | 0.1274 |
| strong (100) | ok | 0.13545 | 0.22122 |

Containment/clipping check: **PASS** — {"containmentInsideFraction":1,"mastTipInsideFraction":1,"mastTipsInsideFraction":1,"safety":[{"path":"boat.safety.withinBottle","trueSamples":48,"falseSamples":0},{"path":"boat.safety.checks.mastTips.0","trueSamples":48,"falseSamples":0},{"path":"boat.safety.checks.mastTips.1","trueSamples":48,"falseSamples":0},{"path":"boat.safety.checks.mastTips.2","trueSamples":48,"falseSamples":0},{"path":"boat.safety.checks.hull","trueSamples":48,"falseSamples":0}],"clippingFields":["boat.safety.withinBottle","boat.safety.checks.mastTips.0","boat.safety.checks.mastTips.1","boat.safety.checks.mastTips.2","boat.safety.checks.hull","cameraInsideBottle"],"clippingViolations":[],"note":"boat root/mast-tip world positions tested against the real bottle cavity via bottle.isInsideCavity(); artefact boat.safety booleans (withinBottle / checks.mastTips / checks.hull) are validated as clipping telemetry"}

## D. Wave direction signatures

| Direction | Boat heave amp | Pitch amp | Roll amp | Direction telemetry | Screenshot |
| --- | --- | --- | --- | --- | --- |
| 0 deg | 0.08286 | 0.14199 | 0.05746 | 0 | 20-dir-0.png |
| 90 deg | 0.04511 | 0.21876 | 0.11168 | 90 | 20-dir-90.png |
| 180 deg | 0.06661 | 0.20673 | 0.08195 | 180 | 20-dir-180.png |

Pairwise y/pitch/roll correlation of motion series: [{"pair":"0->90","channels":[{"channel":"boatY","correlation":0.2059,"bestLag":{"lag":12,"r":-0.9081992419894491},"amplitudeA":0.08286,"amplitudeB":0.04511,"amplitudeRelDiff":-0.59,"phaseShifted":true},{"channel":"pitch","correlation":0.0756,"bestLag":{"lag":-11,"r":0.7044592224689472},"amplitudeA":0.14199,"amplitudeB":0.21876,"amplitudeRelDiff":0.4256,"phaseShifted":true},{"channel":"roll","correlation":0.844,"bestLag":{"lag":-1,"r":0.8688663938517366},"amplitudeA":0.05746,"amplitudeB":0.11168,"amplitudeRelDiff":0.6411,"phaseShifted":true}],"differs":true},{"pair":"90->180","channels":[{"channel":"boatY","correlation":0.5066,"bestLag":{"lag":-7,"r":0.8817374110813724},"amplitudeA":0.04511,"amplitudeB":0.06661,"amplitudeRelDiff":0.3849,"phaseShifted":true},{"channel":"pitch","correlation":-0.711,"bestLag":{"lag":4,"r":-0.8034608610689267},"amplitudeA":0.21876,"amplitudeB":0.20673,"amplitudeRelDiff":-0.0565,"phaseShifted":true},{"channel":"roll","correlation":-0.633,"bestLag":{"lag":12,"r":0.8028982100517824},"amplitudeA":0.11168,"amplitudeB":0.08195,"amplitudeRelDiff":-0.3071,"phaseShifted":true}],"differs":true},{"pair":"0->180","channels":[{"channel":"boatY","correlation":-0.5095...

## E. Camera presets & orbit

| Preset | Camera position | Camera delta | Visual diff | Result | Screenshot |
| --- | --- | --- | --- | --- | --- |
| cinema | 0.55, 2.34, 6.49 | 0 | - | already active | 30-preset-cinema.png |
| side | 0.35, 1.98, 5.05 | 1.4984 | 24.615 | changed | 30-preset-side.png |
| top | 0.4, 7.15, 4 | 5.2758 | 25 | changed | 30-preset-top.png |
| closeup | -0.28, 1.92, 4.05 | 5.2743 | 29.875 | changed | 30-preset-closeup.png |
| panorama | 4.1, 4.6, 13.8 | 11.0195 | 29.682 | changed | 30-preset-panorama.png |

| Required screenshot | Preset | Source | Hook fallback |
| --- | --- | --- | --- |
| 40-panorama.png | panorama | ui | - |
| 41-closeup.png | closeup | ui | - |
| 42-top.png | top | ui | - |

- Orbit drag: 2.92334; wheel zoom: 1.34049

## F. Interactions

| Interaction | Detail |
| --- | --- |
| Pause freezes sim | {"simTimeDelta":0,"poseMaxStep":0,"pausedFlag":{"path":"paused","value":true}} |
| Resume smooth | {"simTimeDelta":0.6338000000001074,"firstFrameDelta":{"positionY":0,"maxRotation":0},"maxPerSampleStep":{"positionY":0.002871995046304643,"maxRotation":0.00956562200655877},"noNonFiniteValues":true} |
| Reset slider defaults | [] |
| Screenshot capture | {"kind":"download","dimensions":{"width":1920,"height":1080},"validPng":true} |
| Lighthouse toggle | {"stateChanged":true,"visualDiff":1.005} |
| Editing interaction | {"ok":true,"modeAfter":"rock"} |

## G. Performance / quality

| Quality preset | FPS | Max frame gap (ms) | Frames | Console errors | Screenshot |
| --- | --- | --- | --- | --- | --- |
| fine | 60.4 | 16.8 | 109 | 0 | 70-quality-fine.png |
| standard | 60.5 | 16.9 | 109 | 0 | 70-quality-standard.png |
| retro | 60.4 | 16.9 | 109 | 0 | 70-quality-retro.png |

- Default FPS: {"frames":121,"durationMs":2003.4,"fps":60.4,"maxGapMs":16.9,"meanGapMs":16.7}
- Renderer/perf counters from getDiagnostics(): [{"path":"renderer.calls","value":74},{"path":"renderer.triangles","value":193219},{"path":"renderer.points","value":774},{"path":"renderer.lines","value":29},{"path":"renderer.pixelWidth","value":960},{"path":"renderer.pixelHeight","value":540},{"path":"renderer.scale","value":2},{"path":"renderer.levels","value":48},{"path":"fps","value":60}]

## H. Responsive 1280x720

| Metric | Value |
| --- | --- |
| Screenshot | 50-narrow.png (1280x720) |
| Canvas coverage | 100% x 100% |
| Render buffer / displayed aspect | 1.7778 / 1.7778 |
| Overflow problems | none |
| Pixel stats | {"mean":91.66,"std":49.37,"colors":2736} |
| FPS at 1280x720 | 60.5 |

## Offline reload (file://)

{"ready":true,"navigationError":null,"pixel":{"mean":97.43,"std":47.58}}

## Defects / follow-ups

- None observed by the automated checks.

## Evidence screenshots

| File | Dimensions | Size (KiB) |
| --- | --- | --- |
| qa-shots/00-default-file.png | 1920x1080 | 1095 |
| qa-shots/01-default-http.png | 1920x1080 | 1095 |
| qa-shots/65-ui-hidden.png | 1920x1080 | 885 |
| qa-shots/66-ui-restored.png | 1920x1080 | 1110 |
| qa-shots/10-calm.png | 1920x1080 | 1093 |
| qa-shots/11-medium.png | 1920x1080 | 1095 |
| qa-shots/12-strong.png | 1920x1080 | 1097 |
| qa-shots/20-dir-0.png | 1920x1080 | 1094 |
| qa-shots/20-dir-90.png | 1920x1080 | 1098 |
| qa-shots/20-dir-180.png | 1920x1080 | 1100 |
| qa-shots/30-preset-cinema.png | 1920x1080 | 1099 |
| qa-shots/30-preset-side.png | 1920x1080 | 1099 |
| qa-shots/30-preset-top.png | 1920x1080 | 1086 |
| qa-shots/30-preset-closeup.png | 1920x1080 | 1114 |
| qa-shots/30-preset-panorama.png | 1920x1080 | 1093 |
| qa-shots/40-panorama.png | 1920x1080 | 1094 |
| qa-shots/41-closeup.png | 1920x1080 | 1115 |
| qa-shots/42-top.png | 1920x1080 | 1085 |
| qa-shots/43-orbit-drag.png | 1920x1080 | 1119 |
| qa-shots/44-wheel-zoom.png | 1920x1080 | 1116 |
| qa-shots/60-paused.png | 1920x1080 | 1118 |
| qa-shots/61-reset.png | 1920x1080 | 1090 |
| qa-shots/62-lighthouse-on.png | 1920x1080 | 1098 |
| qa-shots/63-lighthouse-off.png | 1920x1080 | 1094 |
| qa-shots/64-editing.png | 1920x1080 | 1098 |
| qa-shots/70-quality-fine.png | 1920x1080 | 1094 |
| qa-shots/70-quality-standard.png | 1920x1080 | 851 |
| qa-shots/70-quality-retro.png | 1920x1080 | 700 |
| qa-shots/50-narrow.png | 1280x720 | 571 |
| qa-shots/80-offline-file.png | 1920x1080 | 1097 |

## Limitations

- Headless Chrome may use hardware ANGLE or SwiftShader depending on host; measured FPS is indicative only and can differ from an interactive desktop session.
- Clipping containment is only as strong as the telemetry the artifact exposes (`getDiagnostics()`, bottle bounds, boat pose). If no bounds are exposed, the check is reported as WARN/PARTIAL rather than silently passing.
- Aesthetic quality (composition, lighting, reference fidelity) is judged from screenshots; automated checks only verify measurable properties.
- Peak memory/GPU load, long-session stability (>30s) and audio were not part of this pass unless noted.
- The QA harness never modifies the artifact; all UI actions and hook calls are read/drive only.

---
_Generated by tools/qa.mjs; raw data: qa-shots/results.json._