#!/usr/bin/env node
/**
 * tools/qa.mjs -- end-to-end browser QA harness for the "bottle ocean sandbox" build.
 *
 * What it does (offline only, no external URLs):
 *   1. launches system Chrome via playwright-core (hardware WebGL, SwiftShader fallback);
 *   2. loads the artifact over file:// and http://127.0.0.1 (tools/serve.mjs);
 *   3. captures console / pageerror / failed-request / external-network telemetry;
 *   4. waits for window.__bottleOcean.ready, warms up, screenshots and pixel-inspects the canvas;
 *   5. drives the real DOM UI (sliders/buttons/presets) and also exercises the JS hooks;
 *   6. measures wave->boat motion coupling, wave-direction signatures, camera presets/orbit,
 *      pause/resume/reset/screenshot/lighthouse/quality/responsive behaviour;
 *   7. writes qa-shots/*.png, qa-shots/results.json and (for the real artifact) QA_REPORT.md.
 *
 * Usage:
 *   node tools/qa.mjs                  # full QA of bottle_ocean_sandbox.html
 *   node tools/qa.mjs --fixture        # self-test harness against qa-shots/fixture.html
 *   node tools/qa.mjs --headed         # show browser
 *   node tools/qa.mjs --port 8123 --no-report --exit-zero
 *
 * The harness never edits implementation files; it only reads the artifact and writes qa-shots/.
 */
import { chromium } from 'playwright-core';
import { startServer } from './serve.mjs';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const SHOTS_DIR = path.join(ROOT, 'qa-shots');
const ARTIFACT_PATH = path.join(ROOT, 'bottle_ocean_sandbox.html');
const FIXTURE_PATH = path.join(SHOTS_DIR, 'fixture.html');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const VIEWPORT = { width: 1920, height: 1080 };
const NARROW_VIEWPORT = { width: 1280, height: 720 };
const READY_TIMEOUT_MS = 30000;
const WARMUP_MS = 1500;
const SETTLE_MS = 3000;
const RESULTS_PATH = path.join(SHOTS_DIR, 'results.json');
const REPORT_PATH = path.join(ROOT, 'QA_REPORT.md');

const LAUNCH_ARGS_COMMON = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--allow-file-access-from-files',
  '--force-device-scale-factor=1',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-features=Translate,MediaRouter',
  '--autoplay-policy=no-user-gesture-required',
];
const LAUNCH_ARGS_HARDWARE = [...LAUNCH_ARGS_COMMON, '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--enable-zero-copy'];
const LAUNCH_ARGS_SWIFTSHADER = [...LAUNCH_ARGS_COMMON, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'];

// ---------------------------------------------------------------------------
// CLI + logging
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const options = { fixture: false, headed: false, port: 8123, quick: false, report: true, exitZero: false, url: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--fixture') options.fixture = true;
    else if (arg === '--headed') options.headed = true;
    else if (arg === '--quick') options.quick = true;
    else if (arg === '--no-report') options.report = false;
    else if (arg === '--exit-zero') options.exitZero = true;
    else if (arg === '--port' || arg === '-p') options.port = Number(argv[++i]);
    else if (arg.startsWith('--port=')) options.port = Number(arg.slice(7));
    else if (arg === '--url') options.url = argv[++i];
    else if (arg.startsWith('--url=')) options.url = arg.slice(6);
    else if (arg === '--help' || arg === '-h') { console.log('usage: node tools/qa.mjs [--fixture] [--headed] [--quick] [--no-report] [--exit-zero] [--port N] [--url URL]'); process.exit(0); }
    else throw new Error('unknown argument: ' + arg);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('invalid --port');
  return options;
}

const runLogLines = [];
function log(line) {
  const text = String(line);
  runLogLines.push(text);
  console.log(text);
}
function logBlank() { log(''); }

const results = [];
const RESULT_RANK = { FAIL: 3, WARN: 2, SKIP: 1, INFO: 0, PASS: 0 };
function record(id, category, status, name, details = null) {
  if (status === true) status = 'PASS';
  else if (status === false) status = 'FAIL';
  const entry = { id, category, status, name, details };
  results.push(entry);
  let suffix = '';
  if (details !== null && details !== undefined) {
    const compact = typeof details === 'string' ? details : JSON.stringify(details);
    suffix = ' :: ' + (compact.length > 420 ? compact.slice(0, 420) + '...' : compact);
  }
  log('  [' + status + '] ' + id + ' ' + name + suffix);
  return entry;
}
function statusOf(idPrefix) {
  const relevant = results.filter((entry) => entry.id.startsWith(idPrefix));
  if (!relevant.length) return 'SKIP';
  if (relevant.some((entry) => entry.status === 'FAIL')) return 'FAIL';
  if (relevant.some((entry) => entry.status === 'WARN' || entry.status === 'SKIP')) return 'PARTIAL';
  return 'PASS';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value, digits = 3) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : value);
const fmt = (value, digits = 3) => (Number.isFinite(value) ? Number(value.toFixed(digits)).toString() : String(value));
function slug(value) { return String(value ?? 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'preset'; }
function arrayMax(values) { let max = -Infinity; for (const value of values) if (Number.isFinite(value) && value > max) max = value; return Number.isFinite(max) ? max : null; }
function arrayMin(values) { let min = Infinity; for (const value of values) if (Number.isFinite(value) && value < min) min = value; return Number.isFinite(min) ? min : null; }

// ---------------------------------------------------------------------------
// Small statistics helpers used on sampled diagnostics
// ---------------------------------------------------------------------------
function seriesStats(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (!finite.length) return { count: values.length, finiteCount: 0, mean: null, min: null, max: null, range: null, amplitude: null, rms: null, std: null, first: null, last: null, nonFiniteCount: values.length };
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const variance = finite.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) / finite.length;
  return {
    count: values.length,
    finiteCount: finite.length,
    nonFiniteCount: values.length - finite.length,
    mean: round(mean, 5),
    min: round(min, 5),
    max: round(max, 5),
    range: round(max - min, 5),
    amplitude: round((max - min) / 2, 5),
    rms: round(Math.sqrt(finite.reduce((sum, value) => sum + value * value, 0) / finite.length), 5),
    std: round(Math.sqrt(variance), 5),
    first: round(finite[0], 5),
    last: round(finite[finite.length - 1], 5),
  };
}
function pearson(a, b) {
  const pairs = [];
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) pairs.push([a[i], b[i]]);
  }
  if (pairs.length < 4) return null;
  const meanA = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length;
  const meanB = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length;
  let numerator = 0, varA = 0, varB = 0;
  for (const [x, y] of pairs) {
    numerator += (x - meanA) * (y - meanB);
    varA += (x - meanA) ** 2;
    varB += (y - meanB) ** 2;
  }
  if (varA <= 1e-12 || varB <= 1e-12) return null;
  return numerator / Math.sqrt(varA * varB);
}
function bestLagPearson(a, b, maxLag = 12) {
  let best = { lag: 0, r: pearson(a, b) };
  for (let lag = 1; lag <= maxLag; lag += 1) {
    const r1 = pearson(a.slice(lag), b.slice(0, b.length - lag));
    if (r1 !== null && (best.r === null || Math.abs(r1) > Math.abs(best.r))) best = { lag, r: r1 };
    const r2 = pearson(a.slice(0, a.length - lag), b.slice(lag));
    if (r2 !== null && (best.r === null || Math.abs(r2) > Math.abs(best.r))) best = { lag: -lag, r: r2 };
  }
  return best;
}
function relativeDifference(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const scale = Math.max(1e-9, (Math.abs(a) + Math.abs(b)) / 2);
  return (b - a) / scale;
}
function thumbDiff(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return null;
  const count = Math.min(a.length, b.length);
  let sum = 0, max = 0, cells = 0;
  for (let i = 0; i < count; i += 1) {
    const cellA = a[i], cellB = b[i];
    if (!Array.isArray(cellA) || !Array.isArray(cellB)) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      const diff = Math.abs((cellA[channel] ?? 0) - (cellB[channel] ?? 0));
      sum += diff;
      if (diff > max) max = diff;
      cells += 1;
    }
  }
  if (!cells) return null;
  return { meanAbsDiff: round(sum / cells, 3), maxAbsDiff: max, cells: count };
}

// ---------------------------------------------------------------------------
// Flattening of sanitized diagnostics objects
// ---------------------------------------------------------------------------
function flattenNumbers(object, prefix = '', out = [], depth = 0, seen = new WeakSet()) {
  if (object === null || typeof object !== 'object' || depth > 8 || seen.has(object)) return out;
  seen.add(object);
  if (Array.isArray(object)) {
    for (let i = 0; i < Math.min(object.length, 64); i += 1) {
      const value = object[i];
      const nextPrefix = prefix ? prefix + '.' + i : String(i);
      if (typeof value === 'number' && Number.isFinite(value)) out.push({ path: nextPrefix, value });
      else if (typeof value === 'object') flattenNumbers(value, nextPrefix, out, depth + 1, seen);
    }
    seen.delete(object);
    return out;
  }
  for (const key of Object.keys(object)) {
    const value = object[key];
    const nextPrefix = prefix ? prefix + '.' + key : key;
    if (typeof value === 'number' && Number.isFinite(value)) out.push({ path: nextPrefix, value });
    else if (typeof value === 'object') flattenNumbers(value, nextPrefix, out, depth + 1, seen);
  }
  seen.delete(object);
  return out;
}
function flattenSignals(object, prefix = '', out = [], depth = 0, seen = new WeakSet()) {
  if (object === null || typeof object !== 'object' || depth > 8 || seen.has(object)) return out;
  seen.add(object);
  if (Array.isArray(object)) {
    for (let i = 0; i < Math.min(object.length, 32); i += 1) {
      const value = object[i];
      const nextPrefix = prefix ? prefix + '.' + i : String(i);
      if (typeof value === 'number' || typeof value === 'boolean') out.push({ path: nextPrefix, value });
      else if (typeof value === 'object') flattenSignals(value, nextPrefix, out, depth + 1, seen);
    }
    seen.delete(object);
    return out;
  }
  for (const key of Object.keys(object)) {
    const value = object[key];
    const nextPrefix = prefix ? prefix + '.' + key : key;
    if (typeof value === 'number' || typeof value === 'boolean') out.push({ path: nextPrefix, value });
    else if (typeof value === 'object') flattenSignals(value, nextPrefix, out, depth + 1, seen);
  }
  seen.delete(object);
  return out;
}

function buildChannelMap(samples) {
  const map = new Map();
  samples.forEach((sample, index) => {
    for (const { path: channelPath, value } of flattenNumbers(sample?.diag ?? {})) {
      let series = map.get(channelPath);
      if (!series) { series = new Array(samples.length).fill(null); map.set(channelPath, series); }
      series[index] = value;
    }
  });
  return map;
}
function pickSeries(map, tiers, options = {}) {
  const minCoverage = options.minCoverage ?? 0.9;
  const reject = options.reject ?? [];
  const paths = [...map.keys()];
  for (const tier of tiers) {
    const patterns = Array.isArray(tier) ? tier : [tier];
    const candidates = [];
    for (const channelPath of paths) {
      if (reject.some((re) => re.test(channelPath))) continue;
      if (!patterns.some((pattern) => pattern.test(channelPath))) continue;
      const values = map.get(channelPath);
      const coverage = values.filter((value) => Number.isFinite(value)).length / Math.max(1, values.length);
      if (coverage >= minCoverage) candidates.push({ path: channelPath, values, coverage });
    }
    if (candidates.length) {
      candidates.sort((a, b) => b.coverage - a.coverage || a.path.length - b.path.length);
      return candidates[0];
    }
  }
  return null;
}
function pickSimTime(map) {
  const candidates = [];
  for (const [channelPath, values] of map) {
    if (!/(^|\.)(simtime|sim_time|simulationtime|simulation_time|elapsedtime|elapsed_time|elapsed|clocktime|time)$/i.test(channelPath)) continue;
    if (/fps|frame|delta|render|load|startup|wall|date|now|duration/i.test(channelPath)) continue;
    const finite = values.filter((value) => Number.isFinite(value));
    if (finite.length < values.length * 0.9) continue;
    let monotonic = true;
    for (let i = 1; i < values.length; i += 1) {
      if (values[i] === null || values[i - 1] === null) continue;
      if (values[i] < values[i - 1] - 1e-6) { monotonic = false; break; }
    }
    candidates.push({ path: channelPath, values, monotonic, range: (arrayMax(finite) ?? 0) - (arrayMin(finite) ?? 0), coverage: finite.length / values.length });
  }
  candidates.sort((a, b) => Number(b.monotonic) - Number(a.monotonic) || b.range - a.range || a.path.length - b.path.length);
  return candidates[0] ?? null;
}

// ---------------------------------------------------------------------------
// PNG / file helpers
// ---------------------------------------------------------------------------
async function sha256File(filePath) {
  try {
    const buffer = await readFile(filePath);
    return createHash('sha256').update(buffer).digest('hex');
  } catch (error) {
    return null;
  }
}
async function fileStamp(filePath) {
  try {
    const info = await stat(filePath);
    return { bytes: info.size, mtimeIso: info.mtime.toISOString(), sha256: await sha256File(filePath) };
  } catch (error) {
    return null;
  }
}

async function readPngInfo(filePath) {
  const buffer = await readFile(filePath);
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) return { width: null, height: null, bytes: buffer.length, validPng: false };
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), bytes: buffer.length, validPng: true };
}
async function inspectArtifact(filePath) {
  const buffer = await readFile(filePath);
  const html = buffer.toString('utf8');
  const scriptSrc = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]);
  const linkHref = [...html.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]);
  const externalRefs = [...scriptSrc, ...linkHref].filter((ref) => /^(https?:)?\/\//i.test(ref));
  const resourceHints = [...html.matchAll(/<script\b[^>]*\btype\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  const inlineScripts = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  const inlineScriptBytes = inlineScripts.reduce((sum, match) => sum + match[1].length, 0);
  const httpUrls = [...new Set([...html.matchAll(/https?:\/\/[^\s"'<>)\\]+/g)].map((match) => match[0]))].slice(0, 40);
  return {
    bytes: buffer.length,
    kib: round(buffer.length / 1024, 1),
    scriptSrc,
    linkHref,
    externalRefs,
    importMapCount: resourceHints.length,
    importMapExternal: resourceHints.some((text) => /https?:\/\//i.test(text)),
    inlineScriptCount: inlineScripts.length,
    inlineScriptBytes,
    hasThreeRevision: /REVISION\s*[:=]\s*["']?180/.test(html),
    hasWebGLRenderer: /WebGLRenderer/.test(html),
    hasShaderMaterial: /ShaderMaterial/.test(html),
    httpUrlStrings: httpUrls,
    metaCsp: /http-equiv=["']Content-Security-Policy["']/i.test(html),
  };
}

// ---------------------------------------------------------------------------
// Browser launch + WebGL probing
// ---------------------------------------------------------------------------
async function probeWebGL(browser) {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
  try {
    return await page.evaluate(() => {
      const out = { ok: false, webgl2: false, renderer: '', vendor: '', version: '', readback: null, error: null };
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        const gl2 = canvas.getContext('webgl2');
        const gl = gl2 || canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (!gl) { out.error = 'no WebGL context available'; return out; }
        out.webgl2 = Boolean(gl2);
        out.version = String(gl.getParameter(gl.VERSION) || '');
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        out.renderer = String(debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || '');
        out.vendor = String(debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR) || '');
        gl.clearColor(0.25, 0.5, 0.75, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        const pixels = new Uint8Array(4);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        out.readback = Array.from(pixels);
        out.ok = pixels[0] > 0 && pixels[1] > 0 && pixels[2] > 0 && pixels[3] > 0;
      } catch (error) {
        out.error = String(error);
      }
      return out;
    });
  } finally {
    await page.close().catch(() => {});
  }
}
async function launchBrowser(options) {
  if (!existsSync(CHROME_PATH)) throw new Error('Chrome not found at ' + CHROME_PATH);
  const attempts = [
    { mode: 'hardware', args: LAUNCH_ARGS_HARDWARE },
    { mode: 'swiftshader', args: LAUNCH_ARGS_SWIFTSHADER },
  ];
  const failures = [];
  for (const attempt of attempts) {
    let browser = null;
    try {
      log('  launching Chrome (' + attempt.mode + ') ...');
      browser = await chromium.launch({ executablePath: CHROME_PATH, headless: !options.headed, args: attempt.args, timeout: 60000 });
      const probe = await probeWebGL(browser);
      if (probe.ok) {
        log('  WebGL: ' + (probe.webgl2 ? 'WebGL2' : 'WebGL1') + ' | ' + probe.renderer + ' | ' + probe.version);
        return { browser, mode: attempt.mode, probe, failures };
      }
      failures.push({ mode: attempt.mode, probe });
      await browser.close().catch(() => {});
    } catch (error) {
      failures.push({ mode: attempt.mode, error: String(error?.message ?? error) });
      if (browser) await browser.close().catch(() => {});
    }
  }
  throw new Error('no usable WebGL browser; attempts=' + JSON.stringify(failures));
}

// ---------------------------------------------------------------------------
// Page telemetry
// ---------------------------------------------------------------------------
const externalAttempts = [];
function createPageLog() {
  return { consoleMessages: [], consoleErrors: [], consoleWarnings: [], pageErrors: [], failedRequests: [], badResponses: [], dialogs: [], downloads: [], resourceEntries: [] };
}
function attachPageLogging(page, pageLog) {
  page.on('console', (message) => {
    const location = message.location();
    const entry = { type: message.type(), text: message.text().slice(0, 2000), url: location?.url ?? '', line: location?.lineNumber ?? -1 };
    pageLog.consoleMessages.push(entry);
    if (entry.type === 'error') pageLog.consoleErrors.push(entry);
    if (entry.type === 'warning') pageLog.consoleWarnings.push(entry);
  });
  page.on('pageerror', (error) => {
    pageLog.pageErrors.push({ message: String(error?.message ?? error).slice(0, 2000), stack: String(error?.stack ?? '').slice(0, 3000) });
  });
  page.on('requestfailed', (request) => {
    const url = request.url();
    pageLog.failedRequests.push({ url, method: request.method(), failure: request.failure()?.errorText ?? 'unknown', external: externalAttempts.some((attempt) => attempt.url === url) });
  });
  page.on('response', (response) => {
    if (response.status() >= 400) pageLog.badResponses.push({ url: response.url(), status: response.status() });
  });
  page.on('dialog', async (dialog) => {
    pageLog.dialogs.push({ type: dialog.type(), message: dialog.message() });
    await dialog.dismiss().catch(() => {});
  });
  page.on('download', (download) => {
    pageLog.downloads.push({ suggestedFilename: download.suggestedFilename(), url: download.url() });
  });
}
function isAllowedUrl(rawUrl, port) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return true; }
  if (['file:', 'data:', 'blob:'].includes(parsed.protocol)) return true;
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    const localHost = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1' || parsed.hostname === '[::1]';
    return localHost && String(parsed.port) === String(port);
  }
  return false;
}
async function installNetworkGuards(context, getPort) {
  await context.route(/.*/, async (route) => {
    const request = route.request();
    const url = request.url();
    if (isAllowedUrl(url, getPort())) { await route.continue(); return; }
    externalAttempts.push({ url, method: request.method(), resourceType: request.resourceType() });
    await route.abort('blockedbyclient').catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// In-page QA helpers (read-only instrumentation; installed in the page)
// ---------------------------------------------------------------------------
async function pageWaitForUi(page) {
  await page.waitForTimeout(600);
  const visible = await page.evaluate(() => {
    const panel = document.getElementById('control-panel');
    return Boolean(panel && getComputedStyle(panel).visibility !== 'hidden' && Number(getComputedStyle(panel).opacity) > 0.5);
  }).catch(() => false);
  if (!visible) {
    await page.keyboard.press('h').catch(() => {});
    await page.waitForTimeout(600);
  }
}

async function installPageHelpers(page) {
  await page.evaluate(() => {
    if (window.__qa) return;
    const sanitize = (value, depth = 0, seen = new WeakSet()) => {
      if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
      if (typeof value === 'string') return value.length > 160 ? value.slice(0, 160) + '...' : value;
      if (typeof value === 'undefined') return null;
      if (typeof value === 'function') return '[function]';
      if (typeof value === 'symbol') return String(value);
      if (typeof value !== 'object') return String(value).slice(0, 160);
      if (depth >= 5) return '[max-depth]';
      if (seen.has(value)) return '[circular]';
      seen.add(value);
      if (Array.isArray(value)) {
        const out = [];
        for (let i = 0; i < Math.min(value.length, 48); i += 1) out.push(sanitize(value[i], depth + 1, seen));
        seen.delete(value);
        return out;
      }
      const out = {};
      let count = 0;
      for (const key of Object.keys(value)) {
        if (count++ >= 80) { out.__truncated = true; break; }
        try { out[key] = sanitize(value[key], depth + 1, seen); } catch (error) { out[key] = '[throws:' + String(error) + ']'; }
      }
      seen.delete(value);
      return out;
    };
    const collectNonFinite = (value, prefix = '', out = [], depth = 0, seen = new WeakSet()) => {
      if (value === null || value === undefined || depth > 6 || typeof value !== 'object') return out;
      if (seen.has(value)) return out;
      seen.add(value);
      if (Array.isArray(value)) {
        for (let i = 0; i < Math.min(value.length, 32); i += 1) collectNonFinite(value[i], prefix + '.' + i, out, depth + 1, seen);
        seen.delete(value);
        return out;
      }
      for (const key of Object.keys(value)) {
        if (out.length >= 25) break;
        const next = value[key];
        const nextPrefix = prefix ? prefix + '.' + key : key;
        if (typeof next === 'number' && !Number.isFinite(next)) out.push(nextPrefix);
        else if (typeof next === 'object') collectNonFinite(next, nextPrefix, out, depth + 1, seen);
      }
      seen.delete(value);
      return out;
    };
    const pose = (object) => {
      try {
        if (!object) return null;
        const position = object.position;
        const rotation = object.rotation;
        const quaternion = object.quaternion;
        if (!position && !rotation) return null;
        const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
        let world = null;
        try {
          const elements = object.matrixWorld?.elements;
          if (elements && elements.length >= 16 && Number.isFinite(elements[12]) && Number.isFinite(elements[13]) && Number.isFinite(elements[14])) {
            world = { x: elements[12], y: elements[13], z: elements[14] };
          }
        } catch (error) {}
        return {
          x: num(position?.x), y: num(position?.y), z: num(position?.z),
          rx: num(rotation?.x), ry: num(rotation?.y), rz: num(rotation?.z),
          qx: num(quaternion?.x), qy: num(quaternion?.y), qz: num(quaternion?.z), qw: num(quaternion?.w),
          world,
          visible: object.visible === undefined ? null : Boolean(object.visible),
        };
      } catch (error) { return null; }
    };
    const cameraPositions = (diag) => {
      const hook = window.__bottleOcean || {};
      const list = [];
      const add = (label, holder) => {
        try {
          const position = holder?.position;
          if (position && typeof position.x === 'number' && typeof position.y === 'number' && typeof position.z === 'number') {
            list.push({ label, x: position.x, y: position.y, z: position.z, target: holder.target && typeof holder.target.x === 'number' ? { x: holder.target.x, y: holder.target.y, z: holder.target.z } : null });
            return true;
          }
        } catch (error) {}
        return false;
      };
      const candidates = [
        ['hook.camera', hook.camera], ['hook.activeCamera', hook.activeCamera], ['hook.mainCamera', hook.mainCamera],
        ['diag.camera', diag?.camera], ['diag.activeCamera', diag?.activeCamera], ['diag.cameraState', diag?.cameraState],
        ['hook.world.camera', hook.world?.camera], ['hook.environment.camera', hook.environment?.camera],
        ['hook.controls.object', hook.controls?.object], ['hook.orbit.object', hook.orbit?.object],
      ];
      for (const [label, holder] of candidates) if (add(label, holder)) break;
      try {
        if (Array.isArray(diag?.cameraPosition) && diag.cameraPosition.length >= 3) {
          list.push({ label: 'diag.cameraPosition', x: diag.cameraPosition[0], y: diag.cameraPosition[1], z: diag.cameraPosition[2], target: null });
        }
      } catch (error) {}
      try {
        const controlsTarget = hook.controls?.target || diag?.cameraTarget;
        if (controlsTarget && typeof controlsTarget.x === 'number') {
          list.push({ label: 'controls.target', x: controlsTarget.x, y: controlsTarget.y, z: controlsTarget.z, target: null, isTarget: true });
        }
      } catch (error) {}
      return list;
    };
    window.__qa = {
      sanitize,
      pose,
      cameraPositions,
      stateSnapshot() {
        const hook = window.__bottleOcean || {};
        let diag = null, diagError = null, state = null, stateError = null, nonFinite = [];
        try { diag = hook.getDiagnostics?.() ?? null; nonFinite = collectNonFinite(diag); } catch (error) { diagError = String(error?.message ?? error); }
        try { state = hook.state ?? null; } catch (error) { stateError = String(error?.message ?? error); }
        const boatObject = hook.boat?.root ?? hook.boat;
        const boatPose = pose(boatObject);
        let containment = null;
        try {
          const bottle = hook.bottle;
          const elements = boatObject?.matrixWorld?.elements;
          if (bottle && typeof bottle.isInsideCavity === 'function' && elements && elements.length >= 16 && Number.isFinite(elements[12])) {
            const world = { x: elements[12], y: elements[13], z: elements[14] };
            containment = {
              world,
              margin0: Boolean(bottle.isInsideCavity(world, 0)),
              margin035: Boolean(bottle.isInsideCavity(world, 0.035)),
              margin08: Boolean(bottle.isInsideCavity(world, 0.08)),
            };
            try {
              const toPoint = (triple) => (Array.isArray(triple) && triple.length >= 3 && triple.slice(0, 3).every((value) => typeof value === 'number' && Number.isFinite(value)))
                ? { x: triple[0], y: triple[1], z: triple[2] }
                : null;
              const tip = toPoint(diag?.boat?.mastTip);
              if (tip) {
                containment.mastTip = {
                  world: tip,
                  margin0: Boolean(bottle.isInsideCavity(tip, 0)),
                  margin022: Boolean(bottle.isInsideCavity(tip, 0.022)),
                  margin035: Boolean(bottle.isInsideCavity(tip, 0.035)),
                  margin08: Boolean(bottle.isInsideCavity(tip, 0.08)),
                };
              }
              const tips = Array.isArray(diag?.boat?.mastTips) ? diag.boat.mastTips.map(toPoint).filter(Boolean) : [];
              if (tips.length) {
                containment.mastTips = {
                  samples: tips.length,
                  insideMargin0: tips.filter((point) => bottle.isInsideCavity(point, 0)).length,
                  insideMargin022: tips.filter((point) => bottle.isInsideCavity(point, 0.022)).length,
                };
              }
            } catch (tipError) {}
          }
        } catch (containmentError) { containment = { error: String(containmentError) }; }
        return {
          hookPresent: Boolean(window.__bottleOcean),
          ready: hook.ready === true ? true : String(typeof hook.ready),
          diag: sanitize(diag),
          diagError,
          state: sanitize(state),
          stateError,
          nonFinite,
          boat: boatPose,
          boatWorld: containment?.world ?? boatPose?.world ?? null,
          containment,
          cameras: cameraPositions(diag),
          viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        };
      },
      async sampleSeries(count, durationMs) {
        const qa = window.__qa;
        const out = [];
        const start = performance.now();
        for (let i = 0; i < count; i += 1) {
          let snapshot;
          try { snapshot = qa.stateSnapshot(); } catch (error) { snapshot = { error: String(error?.message ?? error) }; }
          snapshot.t = Math.round((performance.now() - start) * 10) / 10;
          out.push(snapshot);
          const target = start + (durationMs * (i + 1)) / Math.max(1, count);
          const wait = target - performance.now();
          if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        }
        return out;
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Ready wait / navigation
// ---------------------------------------------------------------------------
async function captureBootSnapshot(page, pageLog = null) {
  const dom = await page.evaluate(() => {
    const loader = document.getElementById('loader');
    const loaderError = document.getElementById('loader-error');
    const hook = window.__bottleOcean;
    const canvas = document.querySelector('canvas');
    const loaderStyle = loader ? getComputedStyle(loader) : null;
    return {
      hasHook: Boolean(hook),
      hookType: typeof hook,
      hookKeys: hook && typeof hook === 'object' ? Object.keys(hook).slice(0, 60) : [],
      readyType: hook ? typeof hook.ready : 'none',
      readyString: hook && typeof hook.ready !== 'object' ? String(hook.ready) : 'object/promise',
      documentReadyState: document.readyState,
      title: document.title,
      loader: loader ? {
        visible: loaderStyle.display !== 'none' && loaderStyle.visibility !== 'hidden' && Number(loaderStyle.opacity) > 0.01,
        text: String(loader.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 500),
        errorText: String(loaderError?.innerText || loaderError?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500),
      } : null,
      canvas: canvas ? { width: canvas.width, height: canvas.height, clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight } : null,
      bodyText: String(document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 1500),
      errorOverlay: document.querySelector('#error, .error, [data-error], #loader-error')?.textContent?.slice(0, 600) ?? null,
    };
  });
  return {
    ...dom,
    consoleErrors: (pageLog?.consoleErrors ?? []).slice(0, 6).map((entry) => ({ text: entry.text, url: entry.url, line: entry.line })),
    pageErrors: (pageLog?.pageErrors ?? []).slice(0, 6),
    failedRequests: (pageLog?.failedRequests ?? []).filter((request) => !request.external).slice(0, 6),
    consoleWarnings: [...new Set((pageLog?.consoleWarnings ?? []).map((entry) => entry.text))].slice(0, 6),
  };
}

async function waitForReady(page, timeout = READY_TIMEOUT_MS, pageLog = null) {
  const startedAt = Date.now();
  let stopPolling = false;
  const pollFailure = (async () => {
    while (!stopPolling && Date.now() - startedAt < timeout) {
      await sleep(300);
      if (stopPolling) return null;
      if (Date.now() - startedAt < 2000) continue;
      if (pageLog && pageLog.pageErrors.length > 0) return { kind: 'failure', reason: 'pageerror during boot', detail: pageLog.pageErrors[0].message };
      if (pageLog && pageLog.consoleErrors.length > 0) return { kind: 'failure', reason: 'console.error during boot', detail: pageLog.consoleErrors[0].text };
      try {
        const dom = await page.evaluate(() => {
          const loader = document.getElementById('loader');
          const text = String(loader?.innerText || document.body?.innerText || '').slice(0, 1200);
          return { failed: /初始化失败|初始化错误|场景初始化失败|加载失败|failed to (load|initialize|boot)|fatal error|uncaught/i.test(text), text: text.slice(0, 300) };
        });
        if (dom.failed) return { kind: 'failure', reason: 'failure message in UI', detail: dom.text };
      } catch (probeError) { /* page may be navigating/closing */ }
    }
    return null;
  })();
  const readyPromise = page.waitForFunction(() => {
    const hook = window.__bottleOcean;
    if (!hook) return false;
    const ready = hook.ready;
    if (ready === true) return true;
    if (typeof ready === 'number' && Number.isFinite(ready) && ready >= 1) return true;
    if (ready && typeof ready.then === 'function') {
      if (!window.__qaReadyTracked) {
        window.__qaReadyTracked = true;
        window.__qaReadyResult = null;
        Promise.resolve(ready).then(() => { window.__qaReadyResult = 'resolved'; }, (error) => { window.__qaReadyResult = 'rejected:' + String(error); });
      }
      return window.__qaReadyResult === 'resolved';
    }
    return false;
  }, undefined, { timeout, polling: 100 }).then(() => ({ kind: 'ready' })).catch((error) => ({ kind: 'timeout', error }));
  const outcome = await Promise.race([readyPromise, pollFailure]);
  stopPolling = true;
  if (outcome && outcome.kind === 'ready') return { ok: true, elapsedMs: Date.now() - startedAt };
  const snapshot = await captureBootSnapshot(page, pageLog).catch((probeError) => ({ evaluateError: String(probeError?.message ?? probeError) }));
  const error = outcome?.kind === 'failure'
    ? 'boot failure (' + outcome.reason + '): ' + String(outcome.detail || '').split('\n')[0].slice(0, 500)
    : String(outcome?.error?.message ?? 'page never reported ready');
  return { ok: false, elapsedMs: Date.now() - startedAt, error, snapshot };
}

async function loadAndSettle(context, url, options = {}) {
  const label = options.label ?? 'page';
  const page = await context.newPage();
  const pageLog = createPageLog();
  attachPageLogging(page, pageLog);
  let navigationError = null;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  } catch (error) {
    navigationError = String(error?.message ?? error);
  }
  let helpersInstalled = false;
  if (!navigationError) {
    try { await installPageHelpers(page); helpersInstalled = true; } catch (error) { helpersInstalled = false; }
  }
  const ready = navigationError ? { ok: false, error: navigationError, snapshot: null } : await waitForReady(page, READY_TIMEOUT_MS, pageLog);
  let bootShot = null;
  if (ready.ok) {
    await page.waitForTimeout(options.warmupMs ?? WARMUP_MS);
    try { await installPageHelpers(page); helpersInstalled = true; } catch (error) {}
  } else {
    log('    [boot-failure] ' + label + ': ' + ready.error);
    for (const entry of ready.snapshot?.consoleErrors ?? []) log('      console.error: ' + String(entry.text).split('\n')[0].slice(0, 500));
    for (const entry of ready.snapshot?.pageErrors ?? []) log('      pageerror: ' + String(entry.message).split('\n')[0].slice(0, 500));
    if (ready.snapshot?.loader) log('      loader: ' + JSON.stringify(ready.snapshot.loader).slice(0, 600));
    try { bootShot = await takeScreenshot(page, '00-boot-failure-' + label + '.png'); } catch (error) { log('      [warn] boot-failure screenshot failed: ' + String(error?.message ?? error)); }
  }
  let state = null;
  if (ready.ok && helpersInstalled) {
    try { state = await page.evaluate(() => window.__qa.stateSnapshot()); } catch (error) { state = { error: String(error?.message ?? error) }; }
  }
  return { page, pageLog, ready, state, helpersInstalled, navigationError, bootShot };
}

// ---------------------------------------------------------------------------
// Screenshot + pixel analysis
// ---------------------------------------------------------------------------
async function takeScreenshot(page, fileName) {
  await mkdir(SHOTS_DIR, { recursive: true });
  const filePath = path.join(SHOTS_DIR, fileName);
  await page.screenshot({ path: filePath, type: 'png', animations: 'allow' });
  const info = await readPngInfo(filePath);
  log('    [shot] qa-shots/' + fileName + ' ' + info.width + 'x' + info.height + ' ' + round(info.bytes / 1024, 0) + 'KB');
  return { name: fileName, path: 'qa-shots/' + fileName, width: info.width, height: info.height, bytes: info.bytes };
}
async function collectPixelStats(page, clip = null) {
  const screenshotOptions = { type: 'png', animations: 'allow' };
  if (clip) screenshotOptions.clip = { x: Math.max(0, Math.floor(clip.x)), y: Math.max(0, Math.floor(clip.y)), width: Math.max(1, Math.floor(clip.width)), height: Math.max(1, Math.floor(clip.height)) };
  const buffer = await page.screenshot(screenshotOptions);
  const base64 = buffer.toString('base64');
  return page.evaluate(async (payload) => {
    const image = new Image();
    await new Promise((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('screenshot decode failed')); image.src = 'data:image/png;base64,' + payload.base64; });
    const scale = Math.min(1, 480 / Math.max(1, image.width));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const scratch = document.createElement('canvas');
    scratch.width = width;
    scratch.height = height;
    const context = scratch.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    const gridX = 8, gridY = 8;
    const grid = [];
    for (let i = 0; i < gridX * gridY; i += 1) grid.push([0, 0, 0, 0]);
    const colors = new Set();
    let sumLum = 0, sumLumSq = 0, dark = 0, nearBlack = 0, colorful = 0, sumR = 0, sumG = 0, sumB = 0, minLum = 255, maxLum = 0;
    const total = width * height;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        const r = pixels[offset], g = pixels[offset + 1], b = pixels[offset + 2];
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        sumLum += lum; sumLumSq += lum * lum;
        sumR += r; sumG += g; sumB += b;
        if (lum < 24) dark += 1;
        if (lum < 8) nearBlack += 1;
        if (Math.max(r, g, b) - Math.min(r, g, b) > 30) colorful += 1;
        if (lum < minLum) minLum = lum;
        if (lum > maxLum) maxLum = lum;
        if (colors.size < 4096) colors.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
        const cellX = Math.min(gridX - 1, Math.floor((x / width) * gridX));
        const cellY = Math.min(gridY - 1, Math.floor((y / height) * gridY));
        const cell = grid[cellY * gridX + cellX];
        cell[0] += r; cell[1] += g; cell[2] += b; cell[3] += 1;
      }
    }
    const mean = sumLum / total;
    const variance = Math.max(0, sumLumSq / total - mean * mean);
    const thumb = grid.map((cell) => { const n = Math.max(1, cell[3]); return [Math.round(cell[0] / n), Math.round(cell[1] / n), Math.round(cell[2] / n)]; });
    return {
      width, height,
      meanBrightness: Math.round(mean * 100) / 100,
      stdBrightness: Math.round(Math.sqrt(variance) * 100) / 100,
      darkFraction: Math.round((dark / total) * 10000) / 10000,
      nearBlackFraction: Math.round((nearBlack / total) * 10000) / 10000,
      colorfulFraction: Math.round((colorful / total) * 10000) / 10000,
      uniqueColors: colors.size,
      uniqueColorsCapped: colors.size >= 4096,
      meanRGB: [Math.round((sumR / total) * 10) / 10, Math.round((sumG / total) * 10) / 10, Math.round((sumB / total) * 10) / 10],
      minLuma: Math.round(minLum * 10) / 10,
      maxLuma: Math.round(maxLum * 10) / 10,
      thumb,
    };
  }, { base64 });
}
async function analyzeDataUrl(page, dataUrl) {
  return page.evaluate(async (payload) => {
    const image = new Image();
    await new Promise((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('data URL decode failed')); image.src = payload.dataUrl; });
    const scratch = document.createElement('canvas');
    scratch.width = image.width;
    scratch.height = image.height;
    const context = scratch.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    let sum = 0, dark = 0;
    const total = image.width * image.height;
    const colors = new Set();
    for (let i = 0; i < pixels.length; i += 4) {
      const lum = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
      sum += lum;
      if (lum < 8) dark += 1;
      if (colors.size < 2048) colors.add(((pixels[i] >> 3) << 10) | ((pixels[i + 1] >> 3) << 5) | (pixels[i + 2] >> 3));
    }
    return { width: image.width, height: image.height, meanBrightness: Math.round((sum / total) * 100) / 100, nearBlackFraction: Math.round((dark / total) * 10000) / 10000, uniqueColors: colors.size };
  }, { dataUrl });
}

// ---------------------------------------------------------------------------
// FPS / canvas / UI introspection + interaction helpers
// ---------------------------------------------------------------------------
async function measureFps(page, durationMs = 2000) {
  return page.evaluate(async (ms) => {
    let frames = 0;
    let start = 0;
    let last = 0;
    let maxGap = 0;
    let totalGap = 0;
    await new Promise((resolve) => {
      const tick = (now) => {
        if (!start) { start = now; last = now; } else { const gap = now - last; maxGap = Math.max(maxGap, gap); totalGap += gap; last = now; }
        frames += 1;
        if (now - start >= ms) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const duration = performance.now() - start;
    return {
      frames,
      durationMs: Math.round(duration * 10) / 10,
      fps: Math.round((frames / (duration / 1000)) * 10) / 10,
      maxGapMs: Math.round(maxGap * 10) / 10,
      meanGapMs: frames > 1 ? Math.round(((totalGap / (frames - 1)) * 10)) / 10 : null,
    };
  }, durationMs);
}
async function probeCanvas(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return { found: false, canvasCount: 0, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio } };
    const rect = canvas.getBoundingClientRect();
    const style = getComputedStyle(canvas);
    const ancestorRenderings = [];
    let node = canvas.parentElement;
    let guard = 0;
    while (node && guard < 5) {
      const nodeStyle = getComputedStyle(node);
      if (nodeStyle.imageRendering && nodeStyle.imageRendering !== 'auto') ancestorRenderings.push({ tag: node.tagName, className: String(node.className).slice(0, 60), imageRendering: nodeStyle.imageRendering });
      node = node.parentElement;
      guard += 1;
    }
    let contextType = null;
    for (const type of ['webgl2', 'webgl', '2d']) {
      try { if (canvas.getContext(type)) { contextType = type; break; } } catch (error) {}
    }
    return {
      found: true,
      canvasCount: document.querySelectorAll('canvas').length,
      widthAttr: canvas.width,
      heightAttr: canvas.height,
      clientWidth: canvas.clientWidth,
      clientHeight: canvas.clientHeight,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
      imageRendering: style.imageRendering,
      ancestorRenderings,
      objectFit: style.objectFit,
      position: style.position,
      zIndex: style.zIndex,
      contextType,
      bufferedAspect: canvas.width && canvas.height ? Math.round((canvas.width / canvas.height) * 10000) / 10000 : null,
      displayedAspect: rect.width && rect.height ? Math.round((rect.width / rect.height) * 10000) / 10000 : null,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      scroll: { scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight },
    };
  });
}
async function introspectUi(page) {
  return page.evaluate(() => {
    const query = (selector) => [...document.querySelectorAll(selector)];
    const labelFor = (element) => {
      const label = element.closest('label');
      const control = element.closest('[class*="control"], [class*="row"], [class*="slider"], fieldset');
      const text = (label?.innerText || control?.innerText || element.parentElement?.innerText || '');
      return String(text).replace(/\s+/g, ' ').trim().slice(0, 160);
    };
    const controls = query('[data-control]').map((element) => ({
      name: element.getAttribute('data-control'),
      tag: element.tagName.toLowerCase(),
      inputType: element.type ?? null,
      min: element.min ?? null,
      max: element.max ?? null,
      step: element.step ?? null,
      value: element.value ?? null,
      label: labelFor(element),
      attrs: [...element.attributes].reduce((out, attribute) => { out[attribute.name] = attribute.value.slice(0, 80); return out; }, {}),
    }));
    const actions = query('[data-action]').map((element) => ({
      name: element.getAttribute('data-action'),
      tag: element.tagName.toLowerCase(),
      text: String(element.innerText || element.getAttribute('aria-label') || element.title || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      ariaPressed: element.getAttribute('aria-pressed'),
      disabled: Boolean(element.disabled),
    }));
    const presets = query('[data-preset]').map((element) => ({
      name: element.getAttribute('data-preset'),
      text: String(element.innerText || element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      tag: element.tagName.toLowerCase(),
      ariaPressed: element.getAttribute('aria-pressed'),
    }));
    const quality = query('[data-quality]').map((element) => ({
      name: element.getAttribute('data-quality'),
      text: String(element.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      tag: element.tagName.toLowerCase(),
      ariaPressed: element.getAttribute('aria-pressed'),
    }));
    const toggles = query('[data-toggle]').map((element) => ({
      name: element.getAttribute('data-toggle'),
      tag: element.tagName.toLowerCase(),
      text: String(element.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      ariaPressed: element.getAttribute('aria-pressed'),
    }));
    const edits = query('[data-edit]').map((element) => ({
      mode: element.getAttribute('data-edit'),
      tag: element.tagName.toLowerCase(),
      text: String(element.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    }));
    const ranges = query('input[type="range"]').map((element) => ({
      dataControl: element.getAttribute('data-control'),
      id: element.id || null,
      name: element.getAttribute('name'),
      min: element.min, max: element.max, step: element.step, value: element.value,
      label: labelFor(element),
      visible: Boolean(element.offsetParent),
    }));
    const buttons = query('button, [role="button"]').map((element) => ({
      text: String(element.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 70),
      action: element.getAttribute('data-action'),
      preset: element.getAttribute('data-preset'),
      quality: element.getAttribute('data-quality'),
      ariaLabel: element.getAttribute('aria-label'),
      ariaPressed: element.getAttribute('aria-pressed'),
      disabled: Boolean(element.disabled),
    }));
    const outputs = query('output, [data-value], [data-readout]').slice(0, 60).map((element) => ({
      tag: element.tagName.toLowerCase(),
      dataValue: element.getAttribute('data-value'),
      dataControl: element.getAttribute('data-control'),
      text: String(element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    }));
    const hudCandidates = query('body *').filter((element) => {
      const style = getComputedStyle(element);
      return style.position === 'fixed' && element.offsetParent !== null && element.querySelector('button, input, [data-control]');
    }).slice(0, 10).map((element) => ({ tag: element.tagName, id: element.id || null, className: String(element.className).slice(0, 80), fontSize: getComputedStyle(element).fontSize, rect: element.getBoundingClientRect().toJSON() }));
    return {
      title: document.title,
      controls, actions, presets, quality, toggles, edits, ranges, buttons, outputs, hudCandidates,
      bodyText: String(document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 1500),
      scroll: { scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, innerWidth, innerHeight },
      devicePixelRatio,
    };
  });
}
async function setControlValue(page, controlName, value) {
  const escaped = String(controlName).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const locator = page.locator('[data-control="' + escaped + '"]').first();
  if (!(await locator.count())) return { ok: false, reason: 'control-not-found', control: controlName };
  return locator.evaluate((element, nextValue) => {
    const input = element.matches('input, select, textarea') ? element : element.querySelector('input, select, textarea');
    if (!input) return { ok: false, reason: 'no-form-element-inside-control' };
    const kind = input.tagName.toLowerCase() === 'select' ? 'select' : (input.type || 'range');
    try {
      if (kind === 'select') input.value = String(nextValue);
      else if (kind === 'checkbox' || kind === 'radio') input.checked = Boolean(nextValue) && String(nextValue) !== 'false' && String(nextValue) !== '0';
      else { input.focus(); input.value = String(nextValue); }
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      return { ok: true, value: input.value, kind };
    } catch (error) { return { ok: false, reason: String(error) }; }
  }, value);
}
async function readControlValue(page, controlName) {
  const escaped = String(controlName).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const locator = page.locator('[data-control="' + escaped + '"]').first();
  if (!(await locator.count())) return null;
  return locator.evaluate((element) => {
    const input = element.matches('input, select, textarea') ? element : element.querySelector('input, select, textarea');
    const name = element.getAttribute('data-control') || '';
    let output = null;
    try {
      output = document.querySelector('[data-value="' + name + '"]') || document.querySelector('[data-output="' + name + '"]');
    } catch (error) {}
    return { value: input?.value ?? null, outputText: output?.textContent?.trim() ?? null };
  });
}
async function clickAttribute(page, attribute, value, options = {}) {
  const escapedValue = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const locator = page.locator('[' + attribute + '="' + escapedValue + '"]').first();
  if (!(await locator.count())) return { ok: false, reason: 'element-not-found' };
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    const inner = locator.locator('button, input, a, [role="button"]').first();
    const target = (await inner.count()) ? inner : locator;
    await target.click({ timeout: 5000, force: Boolean(options.force) });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
}
async function clickAction(page, actionName) { return clickAttribute(page, 'data-action', actionName); }
function findAction(ui, patterns, options = {}) {
  const candidates = [];
  for (let patternIndex = 0; patternIndex < patterns.length; patternIndex += 1) {
    for (const action of ui.actions) {
      const nameMatch = patterns[patternIndex].test(action.name || '');
      const textMatch = !options.nameOnly && patterns[patternIndex].test(action.text || '');
      if (nameMatch || textMatch) candidates.push({ action, patternIndex, nameMatch });
    }
  }
  candidates.sort((a, b) => Number(b.nameMatch) - Number(a.nameMatch) || String(a.action.name || '').length - String(b.action.name || '').length || a.patternIndex - b.patternIndex);
  return candidates[0]?.action ?? null;
}
function findPreset(ui, patterns) {
  for (const pattern of patterns) {
    const found = ui.presets.find((preset) => pattern.test(preset.name || '') || pattern.test(preset.text || ''));
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Motion analysis: channels, clipping telemetry, bounds containment
// ---------------------------------------------------------------------------
function analyzeClipping(samples) {
  const fields = new Map();
  const violations = [];
  const safetySignals = new Map();
  const sources = [];
  for (const sample of samples) {
    sources.push(sample.diag, sample.state);
  }
  for (const source of sources) {
    for (const { path: signalPath, value } of flattenSignals(source ?? {})) {
      if (!/clip|bounds|violat|penetrat|outside|outof|collide|overflow|escape|inside|contain|intersect|safety|within/i.test(signalPath)) continue;
      const lower = signalPath.toLowerCase();
      let existing = fields.get(signalPath);
      if (!existing) { existing = { path: signalPath, types: new Set(), values: new Set(), samples: 0 }; fields.set(signalPath, existing); }
      existing.types.add(typeof value);
      if (existing.values.size < 12) existing.values.add(String(value));
      existing.samples += 1;
      const isSafetyPath = /safety|withinbottle|checks\./.test(lower);
      const positive = isSafetyPath || /(inside|contained|inbounds|within|safe|valid|allowed|ok)/.test(lower);
      const negative = /(violat|clip|penetrat|outside|outof|collide|overflow|escape|exceed|breach)/.test(lower);
      if (typeof value === 'boolean') {
        if (/camera/i.test(lower)) {
          // e.g. cameraInsideBottle: describes the camera, not prop/boat clipping.
        } else if (negative) {
          if (value === true) violations.push({ path: signalPath, kind: 'boolean-true', value });
        } else if (positive) {
          if (value === false) violations.push({ path: signalPath, kind: 'boolean-false', value });
        }
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        if (/(clearance|margin|gap|distance)/.test(lower)) {
          if (value < 0) violations.push({ path: signalPath, kind: 'clearance-negative', value });
        } else if (value > 0 && negative) {
          violations.push({ path: signalPath, kind: 'count-positive', value });
        }
      }
      if (/safety/.test(lower) && typeof value === 'boolean') {
        let signal = safetySignals.get(signalPath);
        if (!signal) { signal = { path: signalPath, trueSamples: 0, falseSamples: 0 }; safetySignals.set(signalPath, signal); }
        if (value) signal.trueSamples += 1; else signal.falseSamples += 1;
      }
    }
  }
  const uniqueViolations = [];
  const seenViolations = new Set();
  for (const violation of violations) {
    const key = violation.path + '|' + violation.kind + '|' + String(violation.value);
    if (seenViolations.has(key)) continue;
    seenViolations.add(key);
    uniqueViolations.push(violation);
  }
  return {
    fields: [...fields.values()].map((field) => ({ path: field.path, types: [...field.types], values: [...field.values], samples: field.samples })),
    violations: uniqueViolations.slice(0, 12),
    violationCount: uniqueViolations.length,
    safety: [...safetySignals.values()],
  };
}

function normalizeBox(candidate) {
  if (!candidate) return null;
  const isNum = (value) => typeof value === 'number' && Number.isFinite(value);
  if (Array.isArray(candidate) && candidate.length >= 6) {
    return { min: { x: candidate[0], y: candidate[1], z: candidate[2] }, max: { x: candidate[3], y: candidate[4], z: candidate[5] } };
  }
  if (candidate.min && candidate.max && isNum(candidate.min.x) && isNum(candidate.min.y) && isNum(candidate.min.z) && isNum(candidate.max.x) && isNum(candidate.max.y) && isNum(candidate.max.z)) {
    return { min: { x: candidate.min.x, y: candidate.min.y, z: candidate.min.z }, max: { x: candidate.max.x, y: candidate.max.y, z: candidate.max.z } };
  }
  return null;
}

async function probeBoatBounds(page) {
  return page.evaluate(() => {
    const hook = window.__bottleOcean || {};
    const normalize = (candidate) => {
      if (!candidate) return null;
      const isNum = (value) => typeof value === 'number' && Number.isFinite(value);
      if (Array.isArray(candidate) && candidate.length >= 6) return { min: { x: candidate[0], y: candidate[1], z: candidate[2] }, max: { x: candidate[3], y: candidate[4], z: candidate[5] } };
      if (candidate.min && candidate.max && isNum(candidate.min.x) && isNum(candidate.min.y) && isNum(candidate.min.z) && isNum(candidate.max.x) && isNum(candidate.max.y) && isNum(candidate.max.z)) {
        return { min: { x: candidate.min.x, y: candidate.min.y, z: candidate.min.z }, max: { x: candidate.max.x, y: candidate.max.y, z: candidate.max.z } };
      }
      return null;
    };
    const localBounds = [];
    const worldBounds = [];
    const pushLocal = (label, candidate) => { const box = normalize(candidate); if (box) localBounds.push({ label, ...box }); };
    let diagnostics = null;
    try { diagnostics = hook.getDiagnostics?.() ?? null; } catch (error) {}
    try { pushLocal('hook.getBottleBounds()', hook.getBottleBounds?.()); } catch (error) {}
    try { pushLocal('diag.bottle.bounds', diagnostics?.bottle?.bounds); } catch (error) {}
    try { pushLocal('diag.bottleBounds', diagnostics?.bottleBounds); } catch (error) {}
    try { pushLocal('diag.bounds', diagnostics?.bounds); } catch (error) {}
    try { pushLocal('hook.bottle.userData.bounds', hook.bottle?.userData?.bounds); } catch (error) {}
    try { pushLocal('hook.bottle.userData.innerBounds', hook.bottle?.userData?.innerBounds); } catch (error) {}
    try { pushLocal('hook.bottle.innerBounds', hook.bottle?.innerBounds); } catch (error) {}
    try { pushLocal('hook.bottle.userData.cavity', hook.bottle?.userData?.cavity); } catch (error) {}
    try { pushLocal('hook.bottle.geometry.boundingBox', hook.bottle?.geometry?.boundingBox); } catch (error) {}
    try { pushLocal('hook.environment.bottleBounds', hook.environment?.bottleBounds); } catch (error) {}
    try {
      if (window.THREE && typeof window.THREE.Box3 === 'function' && hook.bottle) {
        const box = new window.THREE.Box3().setFromObject(hook.bottle);
        const normalized = normalize({ min: box.min, max: box.max });
        if (normalized) worldBounds.push({ label: 'THREE.Box3(bottle).setFromObject', ...normalized });
      }
    } catch (error) {}
    const boat = hook.boat || null;
    let parentIsBottle = false;
    try { parentIsBottle = Boolean(boat && hook.bottle && (boat.parent === hook.bottle || (boat.parent && hook.bottle.uuid && boat.parent.uuid === hook.bottle.uuid))); } catch (error) {}
    const boatLocal = boat?.position && Number.isFinite(boat.position.x) ? { x: boat.position.x, y: boat.position.y, z: boat.position.z } : null;
    let boatWorld = null;
    try {
      const elements = boat?.matrixWorld?.elements;
      if (elements && elements.length >= 16 && Number.isFinite(elements[12])) boatWorld = { x: elements[12], y: elements[13], z: elements[14] };
    } catch (error) {}
    return { localBounds, worldBounds, parentIsBottle, boatLocal, boatWorld, hasThree: Boolean(window.THREE) };
  });
}

function checkBoundsSamples(probe, samples) {
  if (!probe) return { verifiable: false, reason: 'bounds probe failed' };
  const boatPoses = samples.map((sample) => sample.boat).filter(Boolean);
  if (!boatPoses.length) return { verifiable: false, reason: 'no boat pose sampled' };
  const preferredLocal = probe.localBounds.find((box) => /diag\.bottle\.bounds|userData\.[a-z]*bounds|cavity|innerbounds/i.test(box.label)) ?? probe.localBounds[0] ?? null;
  const worldBox = probe.worldBounds[0] ?? null;
  const toleranceFor = (box) => 0.02 * Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z, 1e-6);
  const evaluate = (box, poses, space, ambiguous) => {
    const tolerance = toleranceFor(box);
    let maxExcursion = 0, worstPose = null, violations = 0;
    const violatingSamples = [];
    for (const pose of poses) {
      if (!pose || !Number.isFinite(pose.x) || !Number.isFinite(pose.y) || !Number.isFinite(pose.z)) continue;
      const excursion = Math.max(
        0,
        box.min.x - pose.x, pose.x - box.max.x,
        box.min.y - pose.y, pose.y - box.max.y,
        box.min.z - pose.z, pose.z - box.max.z,
      );
      if (excursion > maxExcursion) { maxExcursion = excursion; worstPose = { x: round(pose.x, 5), y: round(pose.y, 5), z: round(pose.z, 5) }; }
      if (excursion > tolerance) {
        violations += 1;
        if (violatingSamples.length < 5) violatingSamples.push({ x: round(pose.x, 5), y: round(pose.y, 5), z: round(pose.z, 5), excursion: round(excursion, 5) });
      }
    }
    return { verifiable: true, source: box.label, space, ambiguous, tolerance: round(tolerance, 5), checkedPoses: poses.length, violations, maxExcursion: round(maxExcursion, 5), worstPose, violatingSamples };
  };
  if (probe.parentIsBottle && preferredLocal) return evaluate(preferredLocal, boatPoses, 'bottle-local', false);
  if (worldBox) {
    const worldPoses = boatPoses.map((pose) => pose.world).filter(Boolean);
    if (worldPoses.length) return evaluate(worldBox, worldPoses, 'world', false);
  }
  if (preferredLocal) return evaluate(preferredLocal, boatPoses, 'assumed-bottle-local', !probe.parentIsBottle);
  return { verifiable: false, reason: probe.hasThree ? 'artifact exposes no bottle bounds' : 'no bottle bounds exposed and THREE is not global' };
}

function analyzeMotion(samples, boundsProbe = null) {
  const valid = samples.filter((sample) => sample && !sample.error);
  const map = buildChannelMap(valid);
  const coverage = (values) => values.filter((value) => Number.isFinite(value)).length / Math.max(1, values.length);
  const channels = {};
  const rejectMotion = [/pitch|roll|rot|camera|target|velocity|speed|visible|direction|clip|bounds/i];

  const directBoatY = valid.map((sample) => (Number.isFinite(sample.boat?.y) ? sample.boat.y : null));
  const directPitch = valid.map((sample) => (Number.isFinite(sample.boat?.rx) ? sample.boat.rx : null));
  const directRoll = valid.map((sample) => (Number.isFinite(sample.boat?.rz) ? sample.boat.rz : null));
  if (coverage(directBoatY) >= 0.9) channels.boatY = { source: 'hook.boat.position.y', values: directBoatY };
  else {
    const picked = pickSeries(map, [[/(^|\.)boat\.position\.(y|1)$/i], [/(^|\.)boat\.(y|height|elevation|bob)$/i], [/(boat|ship).*position\.(y|1)$/i]], { reject: rejectMotion });
    if (picked) channels.boatY = { source: 'diagnostics:' + picked.path, values: picked.values };
  }
  const namedPitch = pickSeries(map, [[/(^|\.)(boat|ship)\.(pitch|rotation\.x|rot\.x|rx)$/i], [/(^|\.)pitch$/i]], { reject: [/roll|yaw|target|camera|position/i] });
  if (namedPitch) channels.pitch = { source: 'diagnostics:' + namedPitch.path, values: namedPitch.values };
  else if (coverage(directPitch) >= 0.9) channels.pitch = { source: 'hook.boat.root.rotation.x', values: directPitch };
  const namedRoll = pickSeries(map, [[/(^|\.)(boat|ship)\.(roll|rotation\.z|rot\.z|rz)$/i], [/(^|\.)roll$/i]], { reject: [/pitch|yaw|target|camera|position/i] });
  if (namedRoll) channels.roll = { source: 'diagnostics:' + namedRoll.path, values: namedRoll.values };
  else if (coverage(directRoll) >= 0.9) channels.roll = { source: 'hook.boat.root.rotation.z', values: directRoll };
  const simTime = pickSimTime(map);
  if (simTime) channels.simTime = { source: 'diagnostics:' + simTime.path, values: simTime.values, monotonic: simTime.monotonic };
  const waveHeight = pickSeries(map, [
    [/(^|\.)(wave|waves|ocean|water)\.(height|amplitude|amp|sample_?amplitude|elevation|displacement)$/i],
    [/(^|\.)(waveHeight|waveAmplitude|waveSampleAmplitude|oceanHeight)$/i],
    [/(wave|ocean|water).*(amplitude|height|elevation|displacement)/i],
  ], { reject: [/direction|dir|period|speed|time|phase|freq|length|camera|boat|clip|bounds/i] });
  if (waveHeight) channels.waveHeight = { source: 'diagnostics:' + waveHeight.path, values: waveHeight.values };
  const waveDirection = pickSeries(map, [
    [/(^|\.)(wave|waves|ocean|water).*(direction|dir|angle)$/i],
    [/(^|\.)waveDirection$/i],
  ], { reject: [/camera|boat|clip|bounds|time/i] });
  if (waveDirection) channels.waveDirection = { source: 'diagnostics:' + waveDirection.path, values: waveDirection.values };
  const cameraSeries = valid.map((sample) => {
    const cameras = Array.isArray(sample.cameras) ? sample.cameras.filter((entry) => !entry.isTarget) : [];
    const first = cameras[0];
    return first && Number.isFinite(first.x) ? { x: first.x, y: first.y, z: first.z, label: first.label } : null;
  });
  if (cameraSeries.some(Boolean)) channels.camera = { source: 'page camera helper', values: cameraSeries };
  for (const channel of Object.values(channels)) {
    if (Array.isArray(channel.values) && channel.values.length && typeof channel.values[0] === 'number') channel.stats = seriesStats(channel.values);
  }
  const nonFinite = [...new Set(valid.flatMap((sample) => Array.isArray(sample.nonFinite) ? sample.nonFinite : []))].slice(0, 25);
  const clipping = analyzeClipping(valid);
  const bounds = boundsProbe ? checkBoundsSamples(boundsProbe, valid) : null;
  const containmentEntries = valid.map((sample) => (sample.containment && typeof sample.containment.margin0 === 'boolean' ? sample.containment : null)).filter(Boolean);
  const mastTipEntries = containmentEntries.map((entry) => entry.mastTip).filter(Boolean);
  const mastTipsEntries = containmentEntries.map((entry) => entry.mastTips).filter(Boolean);
  const containment = containmentEntries.length ? {
    source: 'bottle.isInsideCavity(boat world pos, margin)',
    samples: containmentEntries.length,
    insideMargin0: containmentEntries.filter((entry) => entry.margin0).length,
    insideMargin035: containmentEntries.filter((entry) => entry.margin035).length,
    insideMargin08: containmentEntries.filter((entry) => entry.margin08).length,
    outsideMargin0Samples: containmentEntries.filter((entry) => !entry.margin0).slice(0, 5).map((entry) => entry.world),
    mastTip: mastTipEntries.length ? {
      samples: mastTipEntries.length,
      insideMargin0: mastTipEntries.filter((entry) => entry.margin0).length,
      insideMargin035: mastTipEntries.filter((entry) => entry.margin035).length,
      insideMargin08: mastTipEntries.filter((entry) => entry.margin08).length,
      outsideMargin0Samples: mastTipEntries.filter((entry) => !entry.margin0).slice(0, 5).map((entry) => entry.world),
    } : null,
    mastTips: mastTipsEntries.length ? {
      samples: mastTipsEntries.reduce((sum, entry) => sum + entry.samples, 0),
      insideMargin0: mastTipsEntries.reduce((sum, entry) => sum + entry.insideMargin0, 0),
      insideMargin022: mastTipsEntries.reduce((sum, entry) => sum + entry.insideMargin022, 0),
    } : null,
    safety: clipping.safety ?? [],
  } : null;
  return { sampleCount: valid.length, channels, nonFinite, clipping, bounds, containment };
}

function channelStat(motion, name, metric) {
  const channel = motion?.channels?.[name];
  if (!channel?.stats) return null;
  return channel.stats[metric] ?? null;
}
function channelValues(motion, name) { return motion?.channels?.[name]?.values ?? null; }
function firstCameraPosition(cameras) {
  if (!Array.isArray(cameras)) return null;
  const entry = cameras.find((candidate) => !candidate.isTarget && Number.isFinite(candidate.x) && Number.isFinite(candidate.y) && Number.isFinite(candidate.z));
  return entry ? { x: entry.x, y: entry.y, z: entry.z, label: entry.label } : null;
}
function positionDistance(a, b) {
  if (!a || !b) return null;
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

// ---------------------------------------------------------------------------
// Phase C -- wave height UI + hook + boat coupling
// ---------------------------------------------------------------------------
async function runWavePhase(page, ui, shared) {
  logBlank();
  log('-- C. wave height: UI slider + hook + boat coupling --');
  const phase = { settings: {}, hookSettings: {}, controlName: null, defaults: null, shotNames: ['10-calm.png', '11-medium.png', '12-strong.png'] };
  const waveControl = ui.controls.find((control) => /^waveheight$/i.test(control.name))
    ?? ui.controls.find((control) => /wave/i.test(control.name) && /height|amp/i.test(control.name))
    ?? null;
  phase.controlName = waveControl?.name ?? 'waveHeight';
  phase.defaults = waveControl ? { value: waveControl.value, min: waveControl.min, max: waveControl.max, label: waveControl.label } : null;
  record('C1', 'C', Boolean(waveControl), 'waveHeight UI slider exists', waveControl
    ? { name: waveControl.name, tag: waveControl.tag, min: waveControl.min, max: waveControl.max, step: waveControl.step, defaultValue: waveControl.value, label: waveControl.label }
    : { controls: ui.controls.map((control) => control.name), ranges: ui.ranges.map((range) => range.dataControl) });
  if (!waveControl) {
    record('C2', 'C', 'SKIP', 'wave-height motion sampling skipped (no slider)');
    return phase;
  }

  const sequence = [
    { value: 0, key: 'calm', shot: '10-calm.png' },
    { value: 50, key: 'medium', shot: '11-medium.png' },
    { value: 100, key: 'strong', shot: '12-strong.png' },
  ];

  phase.boundsProbe = await probeBoatBounds(page);
  for (const item of sequence) {
    log('  set ' + waveControl.name + '=' + item.value + ' via UI slider ...');
    item.set = await setControlValue(page, waveControl.name, item.value);
    await page.waitForTimeout(150);
    item.readback = await readControlValue(page, waveControl.name);
    await page.waitForTimeout(SETTLE_MS);
    item.shot = await takeScreenshot(page, item.shot);
    item.pixel = await collectPixelStats(page);
    const samples = await page.evaluate(({ count, durationMs }) => window.__qa.sampleSeries(count, durationMs), { count: 64, durationMs: 3600 });
    item.samples = samples.length;
    item.motion = analyzeMotion(samples, phase.boundsProbe);
    phase.settings[item.key] = { value: item.value, set: item.set, readback: item.readback, shot: item.shot, pixel: item.pixel, samples: item.samples, motion: item.motion };
    log('    motion: boatY amp=' + fmt(channelStat(item.motion, 'boatY', 'amplitude'), 4) + ' pitch amp=' + fmt(channelStat(item.motion, 'pitch', 'amplitude'), 4) + ' roll amp=' + fmt(channelStat(item.motion, 'roll', 'amplitude'), 4) + ' waveH mean=' + fmt(channelStat(item.motion, 'waveHeight', 'mean'), 4));
  }

  const readbackValues = sequence.map((item) => String(item.readback?.value ?? item.set?.value ?? ''));
  const setOk = sequence.every((item) => item.set?.ok && String(item.readback?.value ?? '') === String(item.value));
  record('C2', 'C', setOk ? 'PASS' : 'FAIL', 'waveHeight slider applies 0/50/100 values', { requested: sequence.map((item) => item.value), readbacks: readbackValues, setResults: sequence.map((item) => item.set) });

  const outputTexts = sequence.map((item) => item.readback?.outputText ?? '');
  const anyOutput = outputTexts.some((text) => text && text.length);
  if (!anyOutput) {
    record('C3', 'C', 'WARN', 'numeric readout for waveHeight', { note: 'no [data-value="waveHeight"] / output text found; slider value itself tracked', labels: sequence.map((item) => waveControl.label) });
  } else {
    const match = sequence.every((item, index) => String(outputTexts[index]).includes(String(item.value)));
    record('C3', 'C', match ? 'PASS' : 'FAIL', 'waveHeight label/readout matches slider values', { outputTexts });
  }

  // Hook path: window.__bottleOcean.setParam('waveHeight', 0/50/100)
  const hookProbe = await page.evaluate(() => {
    const hook = window.__bottleOcean || {};
    return { hasSetParam: typeof hook.setParam === 'function', hasGetParam: typeof hook.getParam === 'function', hookKeys: Object.keys(hook) };
  });
  if (!hookProbe.hasSetParam) {
    record('C4', 'C', 'FAIL', 'window.__bottleOcean.setParam exists', { hookKeys: hookProbe.hookKeys });
  } else {
    for (const item of sequence) {
      const hookSet = await page.evaluate(({ name, value }) => {
        const hook = window.__bottleOcean;
        try {
          const result = hook.setParam(name, value);
          let serialized = null;
          try { serialized = JSON.parse(JSON.stringify(result)); } catch (error) { serialized = String(result); }
          return { ok: true, result: serialized };
        } catch (error) { return { ok: false, reason: String(error?.message ?? error) }; }
      }, { name: waveControl.name, value: item.value });
      await page.waitForTimeout(1800);
      const samples = await page.evaluate(({ count, durationMs }) => window.__qa.sampleSeries(count, durationMs), { count: 48, durationMs: 3000 });
      const motion = analyzeMotion(samples, phase.boundsProbe);
      phase.hookSettings[item.key] = { value: item.value, hookSet, motion };
      log('    hook set ' + item.value + ': boatY amp=' + fmt(channelStat(motion, 'boatY', 'amplitude'), 4) + (hookSet.ok ? '' : ' (set failed: ' + hookSet.reason + ')'));
    }
    const hookCalm = channelStat(phase.hookSettings.calm?.motion, 'boatY', 'amplitude');
    const hookMedium = channelStat(phase.hookSettings.medium?.motion, 'boatY', 'amplitude');
    const hookStrong = channelStat(phase.hookSettings.strong?.motion, 'boatY', 'amplitude');
    const hookOrdered = hookCalm !== null && hookMedium !== null && hookStrong !== null && hookStrong > hookMedium && hookMedium > hookCalm;
    const uiCalm = channelStat(phase.settings.calm.motion, 'boatY', 'amplitude');
    const uiMedium = channelStat(phase.settings.medium.motion, 'boatY', 'amplitude');
    const uiStrong = channelStat(phase.settings.strong.motion, 'boatY', 'amplitude');
    const parityStrong = relativeDifference(uiStrong, hookStrong);
    const parityMedium = relativeDifference(uiMedium, hookMedium);
    const hookOk = phase.hookSettings.calm?.hookSet?.ok && phase.hookSettings.medium?.hookSet?.ok && phase.hookSettings.strong?.hookSet?.ok;
    const parityOk = parityStrong !== null && Math.abs(parityStrong) < 0.5 && parityMedium !== null && Math.abs(parityMedium) < 0.5;
    record('C4', 'C', hookOk && hookOrdered && parityOk ? 'PASS' : (hookOk ? 'WARN' : 'FAIL'), 'setParam(waveHeight) drives same coupling as UI', { hookSetOk: hookOk, hookOrdered, hookAmplitudes: { calm: hookCalm, medium: hookMedium, strong: hookStrong }, uiAmplitudes: { calm: uiCalm, medium: uiMedium, strong: uiStrong }, relDiffStrong: round(parityStrong, 4), relDiffMedium: round(parityMedium, 4) });
  }

  // Coupling/ordering assertions.
  const uiCalm = channelStat(phase.settings.calm.motion, 'boatY', 'amplitude');
  const uiMedium = channelStat(phase.settings.medium.motion, 'boatY', 'amplitude');
  const uiStrong = channelStat(phase.settings.strong.motion, 'boatY', 'amplitude');
  const yOrdered = uiCalm !== null && uiMedium !== null && uiStrong !== null && uiStrong > uiMedium && uiMedium > uiCalm;
  const strongVsMedium = relativeDifference(uiMedium, uiStrong);
  const materialYMotion = yOrdered && strongVsMedium !== null && Math.abs(strongVsMedium) >= 0.12;
  const calmRatio = uiStrong && uiStrong > 0 ? uiCalm / uiStrong : null;
  record('C5', 'C', materialYMotion ? 'PASS' : 'FAIL', 'boat heave amplitude scales materially with waveHeight (strong > medium > calm)', { boatYAmplitude: { calm: round(uiCalm, 5), medium: round(uiMedium, 5), strong: round(uiStrong, 5) }, ordered: yOrdered, strongVsMediumRel: round(strongVsMedium, 4), calmOverStrong: round(calmRatio, 4), materialDifference: materialYMotion });

  const pitchAmps = sequence.map((item) => channelStat(item.motion, 'pitch', 'amplitude'));
  const rollAmps = sequence.map((item) => channelStat(item.motion, 'roll', 'amplitude'));
  const pitchOrdered = pitchAmps.every((value) => value !== null) && pitchAmps[2] > pitchAmps[1] && pitchAmps[1] > pitchAmps[0];
  const rollOrdered = rollAmps.every((value) => value !== null) && rollAmps[2] > rollAmps[1] && rollAmps[1] > rollAmps[0];
  const rotationMaterial = (pitchOrdered && relativeDifference(pitchAmps[1], pitchAmps[2]) !== null && Math.abs(relativeDifference(pitchAmps[1], pitchAmps[2])) >= 0.1)
    || (rollOrdered && relativeDifference(rollAmps[1], rollAmps[2]) !== null && Math.abs(relativeDifference(rollAmps[1], rollAmps[2])) >= 0.1);
  record('C6', 'C', rotationMaterial ? 'PASS' : 'WARN', 'pitch/roll respond to waveHeight', { pitchAmplitude: pitchAmps.map((value) => round(value, 5)), rollAmplitude: rollAmps.map((value) => round(value, 5)), pitchOrdered, rollOrdered });

  const waveMeans = sequence.map((item) => channelStat(item.motion, 'waveHeight', 'mean'));
  const waveHeightExposed = waveMeans.every((value) => value !== null);
  if (!waveHeightExposed) {
    record('C7', 'C', 'WARN', 'wave-height telemetry exposed in getDiagnostics()', { note: 'no wave height/amplitude number found; heave coupling is the primary evidence' });
  } else {
    const waveOrdered = waveMeans[2] > waveMeans[1] && waveMeans[1] > waveMeans[0];
    record('C7', 'C', waveOrdered ? 'PASS' : 'FAIL', 'wave telemetry scales with waveHeight setting', { waveHeightMeans: waveMeans.map((value) => round(value, 5)), ordered: waveOrdered, channels: Object.keys(phase.settings.strong.motion.channels) });
  }

  const allRuns = [...sequence.map((item) => ({ label: 'ui:' + item.key, motion: item.motion })), ...Object.entries(phase.hookSettings).map(([key, entry]) => ({ label: 'hook:' + key, motion: entry.motion }))];
  const nonFinite = [...new Set(allRuns.flatMap((run) => run.motion?.nonFinite ?? []))];
  const finiteOk = nonFinite.length === 0 && allRuns.every((run) => (run.motion?.sampleCount ?? 0) > 0);
  record('C8', 'C', finiteOk ? 'PASS' : 'FAIL', 'all diagnostics values finite while waves change', { nonFinitePaths: nonFinite.slice(0, 12), runs: allRuns.map((run) => ({ label: run.label, sampleCount: run.motion?.sampleCount ?? 0 })) });

  const clippingFields = [...new Set(allRuns.flatMap((run) => run.motion?.clipping?.fields?.map((field) => field.path) ?? []))];
  const clippingViolations = [...new Set(allRuns.flatMap((run) => (run.motion?.clipping?.violations ?? []).map((violation) => violation.path + '=' + violation.value)))];
  const boundsResults = allRuns.map((run) => run.motion?.bounds).filter(Boolean);
  const boundsViolations = boundsResults.flatMap((bounds) => bounds.violatingSamples ?? []);
  const boundsVerifiable = boundsResults.some((bounds) => bounds.verifiable && !bounds.ambiguous);
  const boundsAmbiguous = boundsResults.some((bounds) => bounds.ambiguous);
  const containmentRuns = allRuns.map((run) => ({ label: run.label, containment: run.motion?.containment })).filter((entry) => entry.containment);
  const containmentSamples = containmentRuns.reduce((sum, entry) => sum + entry.containment.samples, 0);
  const containmentInside = containmentRuns.reduce((sum, entry) => sum + entry.containment.insideMargin0, 0);
  const containmentVerifiable = containmentSamples > 0;
  const mastTipSamples = containmentRuns.reduce((sum, entry) => sum + (entry.containment.mastTip?.samples ?? 0), 0);
  const mastTipInside = containmentRuns.reduce((sum, entry) => sum + (entry.containment.mastTip?.insideMargin0 ?? 0), 0);
  const mastTipVerifiable = mastTipSamples > 0;
  const mastTipOk = !mastTipVerifiable || mastTipInside === mastTipSamples;
  const mastTipsSamples = containmentRuns.reduce((sum, entry) => sum + (entry.containment.mastTips?.samples ?? 0), 0);
  const mastTipsInside = containmentRuns.reduce((sum, entry) => sum + (entry.containment.mastTips?.insideMargin0 ?? 0), 0);
  const mastTipsVerifiable = mastTipsSamples > 0;
  const mastTipsOk = !mastTipsVerifiable || mastTipsInside === mastTipsSamples;
  const safetySignals = [...new Map(containmentRuns.flatMap((entry) => (entry.containment.safety ?? []).map((signal) => [signal.path, signal]))).values()];
  const safetyVerifiable = safetySignals.length > 0;
  const safetyOk = !safetyVerifiable || safetySignals.every((signal) => signal.falseSamples === 0);
  const containmentOk = !containmentVerifiable || containmentInside === containmentSamples;
  const boundsOk = boundsViolations.length === 0 && containmentOk && mastTipOk && mastTipsOk && safetyOk;
  let clippingStatus;
  if (clippingViolations.length || !boundsOk) clippingStatus = 'FAIL';
  else if (boundsVerifiable || containmentVerifiable || clippingFields.length) clippingStatus = 'PASS';
  else clippingStatus = 'WARN';
  record('C9', 'C', clippingStatus, 'no boat/bottle clipping or bounds violations', {
    clippingFields: clippingFields.slice(0, 12),
    clippingViolations: clippingViolations.slice(0, 8),
    bounds: boundsResults.map((bounds) => ({ verifiable: bounds.verifiable, ambiguous: Boolean(bounds.ambiguous), source: bounds.source ?? bounds.reason, space: bounds.space ?? null, violations: bounds.violations ?? null, maxExcursion: bounds.maxExcursion ?? null, checkedPoses: bounds.checkedPoses ?? null })),
    containment: containmentRuns.map((entry) => ({ label: entry.label, ...entry.containment, outsideMargin0Samples: entry.containment.outsideMargin0Samples })),
    containmentInsideFraction: containmentSamples ? round(containmentInside / containmentSamples, 4) : null,
    mastTipInsideFraction: mastTipSamples ? round(mastTipInside / mastTipSamples, 4) : null,
    mastTipsInsideFraction: mastTipsSamples ? round(mastTipsInside / mastTipsSamples, 4) : null,
    mastTipVerifiable,
    mastTipsVerifiable,
    safety: safetySignals.map((signal) => ({ path: signal.path, trueSamples: signal.trueSamples, falseSamples: signal.falseSamples })),
    safetyVerifiable,
    boundsAmbiguous,
    note: containmentVerifiable ? 'boat root/mast-tip world positions tested against the real bottle cavity via bottle.isInsideCavity(); artefact boat.safety booleans (withinBottle / checks.mastTips / checks.hull) are validated as clipping telemetry' : (boundsVerifiable ? 'boat center tested against exposed bottle bounds' : 'bounds containment not fully verifiable from exposed telemetry'),
  });

  const calmStrongVisual = thumbDiff(phase.settings.calm.pixel?.thumb, phase.settings.strong.pixel?.thumb);
  record('C10', 'C', calmStrongVisual && calmStrongVisual.meanAbsDiff > 0.5 ? 'PASS' : 'WARN', 'ocean render visibly changes between calm and strong', { calmVsStrongMeanAbsDiff: calmStrongVisual?.meanAbsDiff ?? null, threshold: 0.5 });

  const shotsOk = sequence.every((item) => item.shot && item.shot.width > 0);
  record('C11', 'C', shotsOk ? 'PASS' : 'FAIL', 'wave screenshots 10/11/12 captured', sequence.map((item) => item.shot?.name ?? null));
  phase.readbackValues = readbackValues;
  return phase;
}

// ---------------------------------------------------------------------------
// Phase D -- wave direction signatures
// ---------------------------------------------------------------------------
async function runDirectionPhase(page, ui, wavePhase, shared) {
  logBlank();
  log('-- D. wave direction: 0/90/180 motion signatures --');
  const phase = { runs: {}, controlName: null, fixedHeight: null };
  const directionControl = ui.controls.find((control) => /dir/i.test(control.name))
    ?? ui.controls.find((control) => /direction|angle/i.test(control.name))
    ?? ui.ranges.find((range) => /dir/i.test(range.dataControl || '') || /direction/i.test(range.label || ''));
  phase.controlName = directionControl?.name ?? directionControl?.dataControl ?? 'waveDirection';
  const hookCapability = await page.evaluate(() => {
    const hook = window.__bottleOcean || {};
    return { hasSetParam: typeof hook.setParam === 'function', hasPreset: typeof hook.setPreset === 'function' };
  });
  record('D1', 'D', Boolean(directionControl) || hookCapability.hasSetParam, 'wave direction control exists (UI slider or setParam)', directionControl ? { name: phase.controlName, min: directionControl.min, max: directionControl.max, step: directionControl.step, label: directionControl.label } : hookCapability);

  // Fix wave height at medium for a stable comparison.
  const heightControlName = wavePhase?.controlName ?? 'waveHeight';
  const setHeight = await setControlValue(page, heightControlName, 50);
  await page.waitForTimeout(200);
  phase.fixedHeight = await readControlValue(page, heightControlName);
  if (!setHeight.ok) {
    await page.evaluate((name) => { try { window.__bottleOcean?.setParam?.(name, 50); } catch (error) {} }, heightControlName);
  }

  const directions = [0, 90, 180];
  for (const direction of directions) {
    log('  direction=' + direction + ' ...');
    let setResult = null;
    let readback = null;
    if (directionControl) {
      setResult = await setControlValue(page, phase.controlName, direction);
      await page.waitForTimeout(150);
      readback = await readControlValue(page, phase.controlName);
      record('D2-' + direction, 'D', setResult.ok && String(readback?.value ?? '') === String(direction) ? 'PASS' : 'FAIL', 'UI direction set to ' + direction, { set: setResult, readback });
    } else {
      const hookSet = await page.evaluate(({ name, value }) => {
        try { const result = window.__bottleOcean.setParam(name, value); return { ok: true, result: typeof result === 'object' ? '[object]' : String(result) }; } catch (error) { return { ok: false, reason: String(error?.message ?? error) }; }
      }, { name: phase.controlName, value: direction });
      setResult = hookSet;
      record('D2-' + direction, 'D', hookSet.ok ? 'PASS' : 'FAIL', 'hook direction setParam to ' + direction, hookSet);
    }
    await page.waitForTimeout(1800);
    const shot = await takeScreenshot(page, '20-dir-' + direction + '.png');
    const pixel = await collectPixelStats(page);
    const samples = await page.evaluate(({ count, durationMs }) => window.__qa.sampleSeries(count, durationMs), { count: 56, durationMs: 3000 });
    const motion = analyzeMotion(samples);
    phase.runs[direction] = { direction, setResult, readback, shot, pixel, samples: samples.length, motion };
    log('    y amp=' + fmt(channelStat(motion, 'boatY', 'amplitude'), 4) + ' pitch amp=' + fmt(channelStat(motion, 'pitch', 'amplitude'), 4) + ' roll amp=' + fmt(channelStat(motion, 'roll', 'amplitude'), 4) + ' dir telemetry=' + fmt(channelStat(motion, 'waveDirection', 'mean'), 2));
  }

  const comparisons = [];
  for (const [a, b] of [[0, 90], [90, 180], [0, 180]]) {
    const motionA = phase.runs[a].motion;
    const motionB = phase.runs[b].motion;
    const channels = ['boatY', 'pitch', 'roll'].map((channelName) => {
      const valuesA = channelValues(motionA, channelName);
      const valuesB = channelValues(motionB, channelName);
      if (!valuesA || !valuesB) return null;
      const correlation = pearson(valuesA, valuesB);
      const bestLag = bestLagPearson(valuesA, valuesB);
      const amplitudeA = channelStat(motionA, channelName, 'amplitude');
      const amplitudeB = channelStat(motionB, channelName, 'amplitude');
      return {
        channel: channelName,
        correlation: round(correlation, 4),
        bestLag,
        amplitudeA: round(amplitudeA, 5),
        amplitudeB: round(amplitudeB, 5),
        amplitudeRelDiff: round(relativeDifference(amplitudeA, amplitudeB), 4),
        phaseShifted: correlation !== null ? Math.abs(correlation) < 0.95 : null,
      };
    }).filter(Boolean);
    const differs = channels.some((entry) => (entry.correlation !== null && Math.abs(entry.correlation) < 0.92) || (entry.amplitudeRelDiff !== null && Math.abs(entry.amplitudeRelDiff) > 0.15));
    comparisons.push({ pair: a + '->' + b, channels, differs });
  }
  const differingPairs = comparisons.filter((comparison) => comparison.differs).length;
  record('D3', 'D', differingPairs >= 2 ? 'PASS' : (differingPairs >= 1 ? 'WARN' : 'FAIL'), 'wave direction changes boat motion signature (>=2 of 3 direction pairs differ)', { differingPairs, comparisons });

  const directionTelemetry = directions.map((direction) => channelStat(phase.runs[direction].motion, 'waveDirection', 'mean'));
  const telemetryExposed = directionTelemetry.every((value) => value !== null);
  if (!telemetryExposed) {
    record('D4', 'D', 'WARN', 'wave direction telemetry exposed in getDiagnostics()', { note: 'motion signatures + UI readback used as evidence' });
  } else {
    const matches = directions.every((direction, index) => Math.abs(((directionTelemetry[index] % 360) + 360) % 360 - direction) < 5);
    record('D4', 'D', matches ? 'PASS' : 'FAIL', 'wave direction telemetry matches requested values', { requested: directions, telemetry: directionTelemetry.map((value) => round(value, 3)) });
  }

  const waveHeightMeans = directions.map((direction) => channelStat(phase.runs[direction].motion, 'waveHeight', 'mean'));
  const heightsConstant = waveHeightMeans.every((value) => value !== null) && Math.abs(relativeDifference(waveHeightMeans[0], waveHeightMeans[2])) < 0.05;
  record('D5', 'D', heightsConstant ? 'PASS' : 'WARN', 'wave height held constant during direction test', { waveHeightMeans: waveHeightMeans.map((value) => round(value, 5)), fixedHeightReadback: phase.fixedHeight?.value ?? null });

  const shotsOk = directions.every((direction) => phase.runs[direction].shot?.width > 0);
  record('D6', 'D', shotsOk ? 'PASS' : 'FAIL', 'direction screenshots 20-dir-*.png captured', directions.map((direction) => phase.runs[direction].shot?.name ?? null));
  return phase;
}

// ---------------------------------------------------------------------------
// Phase E -- camera presets, orbit drag, wheel zoom
// ---------------------------------------------------------------------------
async function runCameraPhase(page, ui) {
  logBlank();
  log('-- E. camera presets + orbit drag + wheel zoom --');
  const phase = { presets: [], required: [], orbit: null, wheel: null };
  record('E1', 'E', ui.presets.length >= 2, 'camera preset controls exist', { count: ui.presets.length, presets: ui.presets.map((preset) => preset.name) });

  const snapshotCameras = () => page.evaluate(() => window.__qa.cameraPositions());
  const previous = { thumb: null, position: firstCameraPosition(await snapshotCameras()) };
  let index = 0;
  for (const preset of ui.presets) {
    index += 1;
    const activeBefore = await page.evaluate((presetName) => {
      const element = [...document.querySelectorAll('[data-preset]')].find((node) => node.getAttribute('data-preset') === presetName);
      if (!element) return null;
      return { ariaPressed: element.getAttribute('aria-pressed'), activeClass: element.classList.contains('active') };
    }, preset.name).catch(() => null);
    const click = await clickAttribute(page, 'data-preset', preset.name);
    await page.waitForTimeout(1600);
    const cameras = await snapshotCameras();
    const position = firstCameraPosition(cameras);
    const shot = await takeScreenshot(page, '30-preset-' + slug(preset.name) + '.png');
    const pixel = await collectPixelStats(page);
    const visualDiff = previous.thumb ? thumbDiff(previous.thumb, pixel.thumb) : null;
    const cameraDistance = positionDistance(previous.position, position);
    const active = await page.evaluate((presetName) => {
      const element = [...document.querySelectorAll('[data-preset]')].find((node) => node.getAttribute('data-preset') === presetName);
      return element ? { ariaPressed: element.getAttribute('aria-pressed'), className: String(element.className).slice(0, 160) } : null;
    }, preset.name);
    const changed = Boolean(click.ok) && ((cameraDistance !== null && cameraDistance > 0.005) || (visualDiff !== null && visualDiff.meanAbsDiff > 0.5));
    const activeOk = Boolean(active) && (active.ariaPressed === 'true' || /\bactive\b|selected/i.test(active.className || ''));
    const alreadyActive = Boolean(activeBefore) && (activeBefore.ariaPressed === 'true' || activeBefore.activeClass === true);
    const presetStatus = changed ? 'PASS' : (alreadyActive && click.ok ? 'PASS' : (index === 1 && click.ok ? 'WARN' : (activeOk ? 'WARN' : 'FAIL')));
    phase.presets.push({ name: preset.name, text: preset.text, click, cameras, position, cameraDistance, visualDiff, active, activeOk, activeBefore, alreadyActive, shot, pixel, changed });
    record('E2.' + index, 'E', presetStatus, 'camera preset "' + preset.name + '" changes the view', {
      click,
      cameraExposed: Boolean(position),
      cameraDistance: round(cameraDistance, 5),
      cameraPosition: position ? { x: round(position.x, 3), y: round(position.y, 3), z: round(position.z, 3) } : null,
      visualMeanAbsDiff: visualDiff?.meanAbsDiff ?? null,
      activeState: active,
      activeOk,
      activeBefore,
      alreadyActive,
      note: alreadyActive && !changed ? 'preset was already active; no camera delta expected from re-clicking it' : (presetStatus === 'WARN' ? 'no measurable camera/visual change for this preset' : null),
    });
    if (pixel?.thumb) previous.thumb = pixel.thumb;
    if (position) previous.position = position;
  }

  const requiredShots = [
    { file: '40-panorama.png', pattern: [/panorama|pano|wide|establish|overview/i], hookNames: ['panorama', 'pano', 'wide', 'overview'] },
    { file: '41-closeup.png', pattern: [/close|closeup|macro|bow|detail|near|zoom/i], hookNames: ['closeup', 'close-up', 'close', 'macro', 'detail'] },
    { file: '42-top.png', pattern: [/top|overhead|aerial|bird|above|high/i], hookNames: ['top', 'overhead', 'aerial', 'birdseye', 'bird'] },
  ];
  for (const requirement of requiredShots) {
    const preset = findPreset(ui, requirement.pattern);
    const result = { file: requirement.file, presetName: preset?.name ?? null, source: null, shot: null, hookResult: null };
    if (preset) {
      result.click = await clickAttribute(page, 'data-preset', preset.name);
      await page.waitForTimeout(1600);
      result.source = result.click.ok ? 'ui' : null;
      result.shot = await takeScreenshot(page, requirement.file);
    } else {
      result.hookResult = await page.evaluate((names) => {
        const hook = window.__bottleOcean || {};
        const fn = hook.cameraPreset || hook.setPreset;
        if (typeof fn !== 'function') return { ok: false, reason: 'no cameraPreset/setPreset on window.__bottleOcean' };
        for (const name of names) {
          try {
            const value = fn.call(hook, name);
            let serialized = null;
            try { serialized = JSON.parse(JSON.stringify(value)); } catch (error) { serialized = String(value); }
            return { ok: true, name, result: serialized };
          } catch (error) { /* try next */ }
        }
        return { ok: false, reason: 'no matching preset name accepted', tried: names };
      }, requirement.hookNames);
      if (result.hookResult.ok) {
        await page.waitForTimeout(1600);
        result.source = 'hook';
        result.shot = await takeScreenshot(page, requirement.file);
      }
    }
    phase.required.push(result);
    record('E6.' + requirement.file.replace('.png', ''), 'E', result.shot ? (result.source === 'ui' ? 'PASS' : 'WARN') : 'FAIL', requirement.file + ' captured', result);
  }

  const canvasBox = await page.locator('canvas').first().boundingBox().catch(() => null);
  if (!canvasBox || canvasBox.width < 50 || canvasBox.height < 50) {
    record('E7', 'E', 'FAIL', 'mouse orbit drag changes camera', { why: 'canvas bounding box unavailable', canvasBox });
  } else {
    const centerX = canvasBox.x + canvasBox.width / 2;
    const centerY = canvasBox.y + canvasBox.height / 2;
    const beforeCameras = await snapshotCameras();
    const beforePixel = await collectPixelStats(page);
    await page.mouse.move(centerX, centerY);
    await page.mouse.down();
    await page.mouse.move(centerX + Math.min(260, canvasBox.width * 0.18), centerY + Math.min(90, canvasBox.height * 0.1), { steps: 18 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    const afterCameras = await snapshotCameras();
    const afterPixel = await collectPixelStats(page);
    const shot = await takeScreenshot(page, '43-orbit-drag.png');
    const cameraDistance = positionDistance(firstCameraPosition(beforeCameras), firstCameraPosition(afterCameras));
    const visualDiff = thumbDiff(beforePixel.thumb, afterPixel.thumb);
    const changed = (cameraDistance !== null && cameraDistance > 0.005) || (visualDiff !== null && visualDiff.meanAbsDiff > 0.5);
    phase.orbit = { cameraDistance: round(cameraDistance, 5), visualDiff, shot, changed, beforeCamera: firstCameraPosition(beforeCameras), afterCamera: firstCameraPosition(afterCameras) };
    record('E7', 'E', changed ? 'PASS' : 'FAIL', 'mouse orbit drag changes camera', { cameraDistance: round(cameraDistance, 5), visualMeanAbsDiff: visualDiff?.meanAbsDiff ?? null, before: phase.orbit.beforeCamera, after: phase.orbit.afterCamera });

    const beforeWheelCameras = await snapshotCameras();
    const beforeWheelPixel = await collectPixelStats(page);
    await page.mouse.move(centerX, centerY);
    await page.mouse.wheel(0, -480);
    await page.waitForTimeout(600);
    const afterWheelCameras = await snapshotCameras();
    const afterWheelPixel = await collectPixelStats(page);
    const wheelShot = await takeScreenshot(page, '44-wheel-zoom.png');
    const wheelDistance = positionDistance(firstCameraPosition(beforeWheelCameras), firstCameraPosition(afterWheelCameras));
    const wheelVisualDiff = thumbDiff(beforeWheelPixel.thumb, afterWheelPixel.thumb);
    const wheelChanged = (wheelDistance !== null && wheelDistance > 0.005) || (wheelVisualDiff !== null && wheelVisualDiff.meanAbsDiff > 0.5);
    phase.wheel = { cameraDistance: round(wheelDistance, 5), visualDiff: wheelVisualDiff, shot: wheelShot, changed: wheelChanged };
    record('E8', 'E', wheelChanged ? 'PASS' : 'FAIL', 'mouse wheel zoom changes camera', { cameraDistance: round(wheelDistance, 5), visualMeanAbsDiff: wheelVisualDiff?.meanAbsDiff ?? null });
  }
  return phase;
}

// ---------------------------------------------------------------------------
// Phase F -- pause/resume, reset, screenshot button, lighthouse toggle, editing
// ---------------------------------------------------------------------------
function detectFlag(samples, pattern) {
  for (const sample of samples) {
    for (const source of [sample.state, sample.diag]) {
      for (const { path: flagPath, value } of flattenSignals(source ?? {})) {
        if (pattern.test(flagPath)) return { path: flagPath, value };
      }
    }
  }
  return null;
}
function poseDelta(a, b) {
  if (!a || !b) return null;
  const components = ['x', 'y', 'z', 'rx', 'ry', 'rz'].filter((key) => Number.isFinite(a[key]) && Number.isFinite(b[key]));
  if (!components.length) return null;
  return Math.max(...components.map((key) => Math.abs(a[key] - b[key])));
}
function maxConsecutivePoseStep(boatPoses, key) {
  let maxStep = 0;
  for (let i = 1; i < boatPoses.length; i += 1) {
    const previous = boatPoses[i - 1], current = boatPoses[i];
    if (previous && current && Number.isFinite(previous[key]) && Number.isFinite(current[key])) maxStep = Math.max(maxStep, Math.abs(current[key] - previous[key]));
  }
  return maxStep;
}
function readSimTimeDelta(motion) {
  const values = channelValues(motion, 'simTime');
  if (!values) return null;
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length < 2) return null;
  return finite[finite.length - 1] - finite[0];
}

async function runPausePhase(page, ui) {
  logBlank();
  log('-- F1. pause / resume --');
  const phase = { pause: null, reset: null, capture: null, lighthouse: null, editing: null };
  const pauseAction = findAction(ui, [/pause/i, /freeze/i]) ?? ui.actions.find((action) => /pause|freeze/i.test(action.text || ''));
  record('F1', 'F', Boolean(pauseAction), 'pause/resume button exists', pauseAction);
  if (pauseAction) {
    const beforeSamples = await page.evaluate(({ count, durationMs }) => window.__qa.sampleSeries(count, durationMs), { count: 6, durationMs: 700 });
    const clickPause = await clickAction(page, pauseAction.name);
    await page.waitForTimeout(500);
    const frozenSamples = await page.evaluate(({ count, durationMs }) => window.__qa.sampleSeries(count, durationMs), { count: 6, durationMs: 1200 });
    const pausedShot = await takeScreenshot(page, '60-paused.png');
    const frozenMotion = analyzeMotion(frozenSamples);
    const pausedFlag = detectFlag(frozenSamples, /paused|frozen|freeze|isrunning|isRunning|playing/i);
    const pausedValue = pausedFlag ? (/(running|playing)/i.test(pausedFlag.path) ? pausedFlag.value === false : Boolean(pausedFlag.value)) : null;
    const simTimeDelta = readSimTimeDelta(frozenMotion);
    const frozenBoat = frozenSamples.map((sample) => sample.boat).filter(Boolean);
    const frozenPoseStep = frozenBoat.length >= 2 ? Math.max(maxConsecutivePoseStep(frozenBoat, 'y'), maxConsecutivePoseStep(frozenBoat, 'rx'), maxConsecutivePoseStep(frozenBoat, 'rz')) : null;
    const frozenRendering = frozenSamples.length >= 2;
    const freezeOk = Boolean(clickPause.ok) && frozenRendering && (
      (simTimeDelta !== null && simTimeDelta < 0.08) ||
      (simTimeDelta === null && frozenPoseStep !== null && frozenPoseStep < 1e-4)
    ) && (frozenPoseStep === null || frozenPoseStep < 1e-4);
    record('F2', 'F', freezeOk ? 'PASS' : 'FAIL', 'pause freezes simTime and boat pose for >1s', {
      click: clickPause,
      pausedFlag,
      pausedValue,
      simTimeDelta: round(simTimeDelta, 5),
      frozenPoseMaxStep: round(frozenPoseStep, 6),
      frozenSamples: frozenSamples.length,
      pausedShot: pausedShot.name,
    });

    const resumeAction = findAction(ui, [/resume/i]) ?? pauseAction;
    const lastFrozenPose = frozenBoat.length ? frozenBoat[frozenBoat.length - 1] : null;
    const clickResume = await clickAction(page, resumeAction.name);
    // Sample immediately after the Resume click: no artificial delay, so the first
    // sample reflects pose continuity across the pause boundary. Position (world
    // units) and rotation (radians) are compared separately, never mixed.
    const resumedSamples = await page.evaluate(({ count, durationMs }) => window.__qa.sampleSeries(count, durationMs), { count: 40, durationMs: 650 });
    const resumedMotion = analyzeMotion(resumedSamples);
    const resumeSimDelta = readSimTimeDelta(resumedMotion);
    const resumedBoat = resumedSamples.map((sample) => sample.boat).filter(Boolean);
    const firstResumedPose = resumedBoat.length ? resumedBoat[0] : null;
    const componentDelta = (a, b, key) => (a && b && Number.isFinite(a[key]) && Number.isFinite(b[key]) ? Math.abs(a[key] - b[key]) : null);
    const firstSamplePositionDeltaY = componentDelta(lastFrozenPose, firstResumedPose, 'y');
    const firstSampleRotationDelta = Math.max(...['rx', 'ry', 'rz'].map((key) => componentDelta(lastFrozenPose, firstResumedPose, key) ?? 0));
    const maxPerSampleStepY = maxConsecutivePoseStep(resumedBoat, 'y');
    const maxPerSampleStepRotation = Math.max(maxConsecutivePoseStep(resumedBoat, 'rx'), maxConsecutivePoseStep(resumedBoat, 'ry'), maxConsecutivePoseStep(resumedBoat, 'rz'));
    const resumeFinite = resumedMotion.nonFinite.length === 0;
    const firstFrameOk = firstSamplePositionDeltaY !== null && firstSamplePositionDeltaY <= 0.02 && firstSampleRotationDelta <= 0.08;
    const stepsOk = (maxPerSampleStepY === null || maxPerSampleStepY <= 0.05) && (maxPerSampleStepRotation === null || maxPerSampleStepRotation <= 0.2);
    const resumeOk = Boolean(clickResume.ok) && resumeSimDelta !== null && resumeSimDelta > 0.2 && resumeFinite && firstFrameOk && stepsOk && firstResumedPose !== null;
    record('F3', 'F', resumeOk ? 'PASS' : 'FAIL', 'resume continues smoothly: no time skip, first-frame pose continuous, no NaN/huge jump', {
      click: clickResume,
      simTimeDeltaAfterResume: round(resumeSimDelta, 4),
      firstResumedFrameDelta: { positionY: round(firstSamplePositionDeltaY, 5), maxRotation: round(firstSampleRotationDelta, 5), thresholds: { positionY: 0.02, maxRotation: 0.08 } },
      maxPerSampleStepAfterResume: { positionY: round(maxPerSampleStepY, 5), maxRotation: round(maxPerSampleStepRotation, 5) },
      nonFinitePaths: resumedMotion.nonFinite.slice(0, 8),
      firstFrameOk, stepsOk,
      note: 'first sample taken immediately after clicking Resume (no 400ms delay); positionY compared in world units, rotation in radians',
    });

    phase.pause = { pauseAction, clickPause, frozenSimTimeDelta: simTimeDelta, frozenPoseMaxStep: frozenPoseStep, pausedFlag, pausedValue, pausedShot, resumeSimDelta, firstResumedFrameDelta: { positionY: firstSamplePositionDeltaY, maxRotation: firstSampleRotationDelta }, maxPerSampleStepAfterResume: { positionY: maxPerSampleStepY, maxRotation: maxPerSampleStepRotation }, resumedAmplitude: channelStat(resumedMotion, 'boatY', 'amplitude'), resumeFinite };
  }

  const hookPause = await page.evaluate(async () => {
    const hook = window.__bottleOcean || {};
    if (typeof hook.setPaused !== 'function') return { ok: false, reason: 'setPaused missing' };
    try {
      hook.setPaused(true);
      await new Promise((resolve) => setTimeout(resolve, 350));
      hook.setPaused(false);
      return { ok: true };
    } catch (error) { return { ok: false, reason: String(error?.message ?? error) }; }
  });
  record('F4', 'F', hookPause.ok ? 'PASS' : 'WARN', 'setPaused hook works without error', hookPause);

  // ---- reset ----
  logBlank();
  log('-- F2. reset --');
  const resetAction = findAction(ui, [/reset/i, /restore/i, /default/i]);
  record('F5', 'F', Boolean(resetAction), 'reset button exists', resetAction);
  if (resetAction) {
    const clickReset = await clickAction(page, resetAction.name);
    await page.waitForTimeout(1000);
    const afterUi = await introspectUi(page);
    const originalRanges = new Map(ui.ranges.filter((range) => range.dataControl).map((range) => [range.dataControl, String(range.value)]));
    const mismatches = afterUi.ranges.filter((range) => range.dataControl && originalRanges.has(range.dataControl) && String(range.value) !== originalRanges.get(range.dataControl))
      .map((range) => ({ control: range.dataControl, before: originalRanges.get(range.dataControl), after: range.value }));
    const afterState = await page.evaluate(() => window.__qa.stateSnapshot());
    const resetShot = await takeScreenshot(page, '61-reset.png');
    record('F6', 'F', clickReset.ok && mismatches.length === 0 ? 'PASS' : 'FAIL', 'reset restores default slider values', { click: clickReset, mismatches, originalRanges: [...originalRanges.entries()], afterShot: resetShot.name, nonFinite: afterState.nonFinite });
    phase.reset = { clickReset, mismatches, resetShot, afterState };
  }

  // ---- screenshot button ----
  logBlank();
  log('-- F3. screenshot capture --');
  const captureAction = findAction(ui, [/screenshot/i, /snapshot/i, /capture/i, /save/i, /download/i, /photo/i]);
  record('F7', 'F', Boolean(captureAction), 'screenshot button exists', captureAction);
  let download = null;
  if (captureAction) {
    const downloadPromise = page.waitForEvent('download', { timeout: 6000 }).catch(() => null);
    const clickCapture = await clickAction(page, captureAction.name);
    download = await downloadPromise;
    if (download) {
      const downloadPath = path.join(SHOTS_DIR, '90-screenshot-button.png');
      try { await download.saveAs(downloadPath); } catch (error) { log('    [warn] download save failed: ' + error); }
      const info = await readPngInfo(downloadPath).catch(() => ({ width: null, height: null, bytes: 0, validPng: false }));
      phase.capture = { kind: 'download', suggestedFilename: download.suggestedFilename(), file: 'qa-shots/90-screenshot-button.png', validPng: info.validPng, width: info.width, height: info.height, bytes: info.bytes, click: clickCapture };
      record('F8', 'F', info.validPng ? 'PASS' : 'FAIL', 'screenshot button produces a PNG download', phase.capture);
    }
  }
  if (!phase.capture) {
    const hookCapture = await page.evaluate(async () => {
      const hook = window.__bottleOcean || {};
      if (typeof hook.captureScreenshot !== 'function') return { ok: false, reason: 'captureScreenshot missing' };
      try {
        const value = await hook.captureScreenshot();
        if (typeof value === 'string' && value.startsWith('data:image')) return { ok: true, kind: 'dataUrl', dataUrl: value, length: value.length, mime: value.slice(5, value.indexOf(';')) };
        if (value && typeof value.dataUrl === 'string' && value.dataUrl.startsWith('data:image')) return { ok: true, kind: 'object.dataUrl', dataUrl: value.dataUrl, length: value.dataUrl.length };
        return { ok: true, kind: typeof value, length: typeof value === 'string' ? value.length : null };
      } catch (error) { return { ok: false, reason: String(error?.message ?? error) }; }
    });
    if (hookCapture.ok && hookCapture.dataUrl) {
      const stats = await analyzeDataUrl(page, hookCapture.dataUrl);
      let saved = null;
      try {
        const base64 = hookCapture.dataUrl.split(',')[1] ?? '';
        const filePath = path.join(SHOTS_DIR, '90-capture-hook.png');
        await writeFile(filePath, Buffer.from(base64, 'base64'));
        saved = 'qa-shots/90-capture-hook.png';
      } catch (error) {}
      phase.capture = { kind: hookCapture.kind, source: 'hook.captureScreenshot', length: hookCapture.length, stats, saved, click: captureAction };
      const blackish = stats.meanBrightness < 8 || stats.nearBlackFraction > 0.8;
      record('F8', 'F', !blackish ? 'PASS' : 'FAIL', 'captureScreenshot() returns a non-black PNG data URL', phase.capture);
    } else {
      phase.capture = { kind: 'none', click: captureAction, hookCapture };
      record('F8', 'F', 'FAIL', 'screenshot capture available (button download or captureScreenshot hook)', phase.capture);
    }
  }
  if (phase.capture) {
    const dimensions = phase.capture.width && phase.capture.height
      ? { width: phase.capture.width, height: phase.capture.height }
      : (phase.capture.stats ? { width: phase.capture.stats.width, height: phase.capture.stats.height } : null);
    record('F8b', 'F', dimensions && dimensions.width === VIEWPORT.width && dimensions.height === VIEWPORT.height ? 'PASS' : 'FAIL', 'screenshot PNG is full 1920x1080 resolution', { dimensions, kind: phase.capture.kind ?? null, file: phase.capture.file ?? phase.capture.saved ?? null });
    phase.capture.dimensions = dimensions;
  } else {
    record('F8b', 'F', 'SKIP', 'screenshot resolution check skipped (no capture)', {});
  }
  const pageStillAlive = await page.evaluate(() => ({ hasHook: Boolean(window.__bottleOcean), canvases: document.querySelectorAll('canvas').length })).catch((error) => ({ error: String(error?.message ?? error) }));
  record('F9', 'F', pageStillAlive.hasHook ? 'PASS' : 'FAIL', 'page still alive after screenshot capture', pageStillAlive);

  // ---- lighthouse toggle ----
  logBlank();
  log('-- F4. lighthouse toggle --');
  const lighthouseToggle = (ui.toggles ?? []).find((toggle) => /lighthouse/i.test(toggle.name || ''))
    ?? (ui.toggles ?? []).find((toggle) => /light|beam|lantern/i.test(toggle.name || '') || /灯塔|灯光/i.test(toggle.text || ''));
  record('F10', 'F', Boolean(lighthouseToggle), 'lighthouse toggle exists', lighthouseToggle ?? { toggles: (ui.toggles ?? []).map((toggle) => toggle.name), actions: ui.actions.map((action) => action.name) });
  if (lighthouseToggle) {
    const beforeState = await page.evaluate(() => window.__qa.stateSnapshot());
    const beforePixel = await collectPixelStats(page);
    const beforeShot = await takeScreenshot(page, '62-lighthouse-on.png');
    const beforeFlags = flattenSignals({ state: beforeState.state, diag: beforeState.diag }).filter((entry) => /lighthouse|lantern|beam/i.test(entry.path) && typeof entry.value === 'boolean');
    const clickToggle = await clickAttribute(page, 'data-toggle', lighthouseToggle.name);
    await page.waitForTimeout(1500);
    const afterState = await page.evaluate(() => window.__qa.stateSnapshot());
    const afterPixel = await collectPixelStats(page);
    const afterShot = await takeScreenshot(page, '63-lighthouse-off.png');
    const afterFlags = flattenSignals({ state: afterState.state, diag: afterState.diag }).filter((entry) => /lighthouse|lantern|beam/i.test(entry.path) && typeof entry.value === 'boolean');
    const beforeMap = new Map(beforeFlags.map((entry) => [entry.path, entry.value]));
    const stateChanged = afterFlags.some((entry) => beforeMap.has(entry.path) && beforeMap.get(entry.path) !== entry.value);
    const visualDiff = thumbDiff(beforePixel.thumb, afterPixel.thumb);
    const toggleOk = clickToggle.ok && (stateChanged || (visualDiff !== null && visualDiff.meanAbsDiff > 0.02));
    record('F11', 'F', toggleOk ? 'PASS' : 'WARN', 'lighthouse toggle changes state and visuals without errors', {
      toggle: lighthouseToggle,
      click: clickToggle,
      beforeFlags, afterFlags, stateChanged,
      visualMeanAbsDiff: visualDiff?.meanAbsDiff ?? null,
      beforeShot: beforeShot.name, afterShot: afterShot.name,
    });
    phase.lighthouse = { toggle: lighthouseToggle, toggleOk, stateChanged, visualDiff, beforeShot, afterShot };
    if (stateChanged) { await clickAttribute(page, 'data-toggle', lighthouseToggle.name).catch(() => {}); await page.waitForTimeout(700); }
  }

  // ---- editing interaction (optional) ----
  logBlank();
  log('-- F5. editing interaction (optional) --');
  const editButtons = ui.edits ?? [];
  const editHook = await page.evaluate(() => {
    const hook = window.__bottleOcean || {};
    const environment = hook.environment;
    return {
      hasEnvironment: Boolean(environment),
      keys: environment ? Object.keys(environment) : [],
      hasAddProp: typeof environment?.addProp === 'function',
      hasSetEditMode: typeof hook.setEditMode === 'function',
    };
  });
  const hasEditing = editButtons.length > 0 || editHook.hasAddProp || editHook.hasSetEditMode;
  record('F12.0', 'F', hasEditing ? 'PASS' : 'SKIP', 'editing/prop interaction available', { editButtons, editHook });
  if (hasEditing) {
    const beforePixel = await collectPixelStats(page);
    const beforeState = await page.evaluate(() => window.__qa.stateSnapshot());
    const beforePropSignals = new Map(flattenNumbers(beforeState.diag ?? {}).filter((entry) => /props|placed|shell|edits|instances|objectcount/i.test(entry.path)).map((entry) => [entry.path, entry.value]));
    let actionResult = { ok: false, reason: 'no editing action' };
    let placements = [];
    const editButton = editButtons[0] ?? null;
    if (editButton) {
      actionResult = await clickAttribute(page, 'data-edit', editButton.mode);
      await page.waitForTimeout(500);
      actionResult.modeAfter = await page.evaluate(() => { try { return window.__bottleOcean?.getDiagnostics?.()?.editMode ?? null; } catch (error) { return null; } }).catch(() => null);
      const canvasBox = await page.locator('canvas').first().boundingBox().catch(() => null);
      if (canvasBox) {
        for (const [fx, fy] of [[0.72, 0.84], [0.6, 0.8], [0.84, 0.9], [0.5, 0.88]]) {
          const x = canvasBox.x + canvasBox.width * fx;
          const y = canvasBox.y + canvasBox.height * fy;
          await page.mouse.click(x, y);
          await page.waitForTimeout(400);
          placements.push({ x: Math.round(x), y: Math.round(y) });
        }
      }
    } else if (editHook.hasAddProp) {
      actionResult = await page.evaluate(() => {
        const environment = window.__bottleOcean?.environment ?? {};
        try {
          const result = environment.addProp('shell', { x: 0.2, y: 0.4, z: 0.2 });
          return { ok: true, result: result ? '[value]' : String(result) };
        } catch (error) { return { ok: false, reason: String(error?.message ?? error) }; }
      });
    }
    await page.waitForTimeout(500);
    const afterPixel = await collectPixelStats(page);
    const afterShot = await takeScreenshot(page, '64-editing.png');
    const afterState = await page.evaluate(() => window.__qa.stateSnapshot());
    const toastText = await page.evaluate(() => document.getElementById('toast')?.textContent?.trim() ?? null).catch(() => null);
    const toastVisible = await page.evaluate(() => { const toast = document.getElementById('toast'); if (!toast) return null; const style = getComputedStyle(toast); return { visible: style.opacity !== '0' && style.display !== 'none', text: toast.textContent?.trim() ?? '' }; }).catch(() => null);
    const stateChanged = flattenNumbers(afterState.diag ?? {}).some((entry) => /props|placed|shell|edits|instances|objectcount/i.test(entry.path) && beforePropSignals.has(entry.path) && beforePropSignals.get(entry.path) !== entry.value);
    const visualDiff = thumbDiff(beforePixel.thumb, afterPixel.thumb);
    const toastOk = Boolean(toastVisible?.visible && /放置|已|place|add/i.test(toastVisible.text || ''));
    const editOk = Boolean(actionResult?.ok) && (toastOk || stateChanged || (visualDiff !== null && visualDiff.meanAbsDiff > 0.002));
    record('F12', 'F', editOk ? 'PASS' : 'WARN', 'editing interaction executes without error', {
      editButton, actionResult, placements, toastText, toastVisible, stateChanged,
      visualMeanAbsDiff: visualDiff?.meanAbsDiff ?? null, shot: afterShot.name,
      note: editOk ? 'prop placement interaction exercised' : 'editing interaction ran but produced no measurable placement evidence',
    });
    const resetPropsAction = (ui.actions ?? []).find((action) => /resetprops/i.test(action.name || ''));
    if (resetPropsAction) { await clickAction(page, resetPropsAction.name).catch(() => {}); await page.waitForTimeout(300); }
    await page.keyboard.press('Escape').catch(() => {});
    await page.evaluate(() => { try { window.__bottleOcean?.setEditMode?.(null); } catch (error) {} }).catch(() => {});
    await page.waitForTimeout(400);
    const editModeCleared = await page.evaluate(() => {
      try { return window.__bottleOcean?.getDiagnostics?.()?.editMode ?? null; } catch (error) { return 'unknown'; }
    }).catch(() => 'unknown');
    phase.editing = { editButton, actionResult, placements, toastVisible, stateChanged, visualDiff, afterShot, editOk, editModeCleared };
  } else {
    record('F12', 'F', 'SKIP', 'editing interaction tested (not implemented / optional)', { editButtons, editHook });
  }
  return phase;
}

// ---------------------------------------------------------------------------
// Phase G -- performance + quality presets
// ---------------------------------------------------------------------------
async function runPerformancePhase(page, ui, pageLog = null) {
  logBlank();
  log('-- G. performance / quality presets --');
  const phase = { defaultFps: null, qualityRows: [], perfPaths: [] };
  phase.defaultFps = await measureFps(page, 2000);
  const fpsStatus = phase.defaultFps.fps >= 30 ? 'PASS' : (phase.defaultFps.fps >= 20 ? 'WARN' : 'FAIL');
  record('G1', 'G', fpsStatus, 'rAF FPS at 1920x1080 (default settings)', phase.defaultFps);

  const perfSnapshot = await page.evaluate(() => {
    const hook = window.__bottleOcean || {};
    let diagnostics = null;
    try { diagnostics = window.__qa.sanitize(hook.getDiagnostics?.()); } catch (error) {}
    return { diagnostics };
  });
  phase.perfPaths = flattenNumbers(perfSnapshot.diagnostics ?? {})
    .filter((entry) => /fps|draw|call|triangle|texture|memory|render|resolution|pixelratio|pixel_ratio/i.test(entry.path))
    .slice(0, 20)
    .map((entry) => ({ path: entry.path, value: round(entry.value, 3) }));
  record('G2', 'G', phase.perfPaths.length ? 'PASS' : 'WARN', 'getDiagnostics exposes renderer/performance counters', phase.perfPaths);

  const qualityButtons = ui.quality;
  const qualityControl = ui.controls.find((control) => /quality|graphics|detail/i.test(control.name))
    ?? ui.ranges.find((range) => /quality|graphics|detail/i.test(range.dataControl || ''));
  if (qualityButtons.length >= 2) {
    for (const button of qualityButtons) {
      const errorsBefore = pageLog ? pageLog.consoleErrors.length + pageLog.pageErrors.length : null;
      const click = await clickAttribute(page, 'data-quality', button.name);
      await page.waitForTimeout(700);
      const fps = await measureFps(page, 1800);
      const snapshot = await page.evaluate(() => window.__qa.stateSnapshot());
      const counters = flattenNumbers(snapshot.diag ?? {}).filter((entry) => /fps|draw|call|triangle|texture|quality|pixel|scale|levels/i.test(entry.path)).slice(0, 12).map((entry) => ({ path: entry.path, value: round(entry.value, 3) }));
      const errorsAfter = pageLog ? pageLog.consoleErrors.length + pageLog.pageErrors.length : null;
      const errorsDelta = errorsBefore === null ? null : errorsAfter - errorsBefore;
      const shot = await takeScreenshot(page, '70-quality-' + slug(button.name) + '.png');
      phase.qualityRows.push({ preset: button.name, click, fps, counters, shot, errorsDelta });
      record('G3.' + slug(button.name), 'G', fps.fps >= 20 && errorsDelta === 0 ? 'PASS' : 'FAIL', 'quality preset "' + button.name + '": FPS measured, shadow refresh error-free', { fps, counters, click, errorsDelta, shot: shot.name });
    }
  } else if (qualityControl) {
    const options = await page.evaluate(() => {
      const control = [...document.querySelectorAll('[data-control]')].find((element) => /quality|graphics|detail/i.test(element.getAttribute('data-control') || ''));
      const select = control ? (control.matches('select') ? control : control.querySelector('select')) : null;
      if (!select) return [];
      return [...select.options].map((option) => option.value);
    });
    if (options.length >= 2) {
      for (const value of options) {
        const set = await setControlValue(page, qualityControl.name, value);
        await page.waitForTimeout(700);
        const fps = await measureFps(page, 1800);
        phase.qualityRows.push({ preset: value, set, fps });
        record('G3.' + slug(String(value)), 'G', fps.fps >= 20 ? 'PASS' : 'FAIL', 'quality preset "' + value + '" FPS measured', { fps, set });
      }
    }
  }
  if (phase.qualityRows.length) {
    const initialQuality = ui.quality.find((button) => button.ariaPressed === 'true') ?? ui.quality[0];
    if (initialQuality) { await clickAttribute(page, 'data-quality', initialQuality.name).catch(() => {}); await page.waitForTimeout(600); }
  }
  if (!phase.qualityRows.length) {
    record('G3', 'G', 'WARN', 'quality presets measured', { note: 'no [data-quality] buttons or quality control found', qualityButtons: qualityButtons.length, controls: ui.controls.map((control) => control.name) });
    record('G4', 'G', 'SKIP', 'quality presets change cost/FPS', { note: 'no quality control' });
  } else {
    const fpsValues = phase.qualityRows.map((row) => row.fps.fps);
    record('G4', 'G', fpsValues.every((value) => value >= 20) ? 'PASS' : 'FAIL', 'each quality preset stays >= 20 fps', { presets: phase.qualityRows.map((row) => ({ preset: row.preset, fps: row.fps.fps, maxGapMs: row.fps.maxGapMs })) });
    const highRow = phase.qualityRows.find((row) => /fine|high|ultra|best/i.test(row.preset)) ?? phase.qualityRows[0];
    const lowRow = phase.qualityRows.find((row) => /retro|low|perf|fast|eco|potato/i.test(row.preset))
      ?? phase.qualityRows[phase.qualityRows.length - 1];
    const relDiff = highRow && lowRow && highRow !== lowRow ? relativeDifference(highRow.fps.fps, lowRow.fps.fps) : null;
    const counterSignature = (row) => (row.counters ?? []).filter((entry) => !/fps/i.test(entry.path)).map((entry) => entry.path + '=' + entry.value).sort().join('|');
    const signatures = phase.qualityRows.map(counterSignature).filter((signature) => signature.length);
    const countersDiffer = new Set(signatures).size > 1;
    const measurable = (relDiff !== null && Math.abs(relDiff) >= 0.05) || countersDiffer;
    record('G5', 'G', measurable ? 'PASS' : 'WARN', 'quality presets measurably change render cost or FPS', {
      assumedHighPreset: highRow?.preset ?? null,
      assumedLowPreset: lowRow?.preset ?? null,
      highFps: highRow?.fps.fps ?? null,
      lowFps: lowRow?.fps.fps ?? null,
      fpsRelDiff: round(relDiff, 4),
      countersDiffer,
      counters: phase.qualityRows.map((row) => ({ preset: row.preset, counters: row.counters ?? null })),
    });
  }
  return phase;
}

// ---------------------------------------------------------------------------
// Phase H -- responsive 1280x720
// ---------------------------------------------------------------------------
async function runResponsivePhase(page) {
  logBlank();
  log('-- H. responsive 1280x720 --');
  const phase = {};
  await page.setViewportSize(NARROW_VIEWPORT);
  await page.waitForTimeout(1600);
  const canvas = await probeCanvas(page);
  const shot = await takeScreenshot(page, '50-narrow.png');
  const pixel = await collectPixelStats(page);
  const ui = await introspectUi(page);
  const fps = await measureFps(page, 1500);
  const problems = [];
  if (!canvas.found) problems.push('canvas missing at 1280x720');
  if (canvas.scroll && (canvas.scroll.scrollWidth > canvas.viewport.width + 1 || canvas.scroll.scrollHeight > canvas.viewport.height + 1)) problems.push('page overflows viewport (' + canvas.scroll.scrollWidth + 'x' + canvas.scroll.scrollHeight + ' vs ' + canvas.viewport.width + 'x' + canvas.viewport.height + ')');
  if (canvas.found) {
    const coverageWidth = canvas.rect.width / canvas.viewport.width;
    const coverageHeight = canvas.rect.height / canvas.viewport.height;
    if (coverageWidth < 0.9 || coverageHeight < 0.9) problems.push('canvas does not cover viewport (coverage ' + round(coverageWidth * 100, 1) + '% x ' + round(coverageHeight * 100, 1) + '%)');
    if (canvas.rect.right > canvas.viewport.width + 2 || canvas.rect.bottom > canvas.viewport.height + 2) problems.push('canvas overflows viewport');
  }
  record('H1', 'H', problems.length === 0 ? 'PASS' : 'FAIL', 'canvas fills 1280x720 viewport without overflow', { problems, canvas: canvas.found ? { widthAttr: canvas.widthAttr, heightAttr: canvas.heightAttr, rect: canvas.rect, viewport: canvas.viewport, scroll: canvas.scroll } : canvas });

  const pixelOk = pixel.meanBrightness >= 6 && pixel.stdBrightness >= 5 && pixel.darkFraction <= 0.6 && pixel.uniqueColors >= 24;
  record('H2', 'H', pixelOk ? 'PASS' : 'FAIL', 'render at 1280x720 is non-black and non-uniform', pixel);
  record('H3', 'H', shot.width === NARROW_VIEWPORT.width && shot.height === NARROW_VIEWPORT.height ? 'PASS' : 'FAIL', 'narrow screenshot is 1280x720', { width: shot.width, height: shot.height, name: shot.name });

  const aspectMismatch = canvas.bufferedAspect && canvas.displayedAspect ? Math.abs(canvas.bufferedAspect - canvas.displayedAspect) / canvas.displayedAspect : null;
  record('H4', 'H', aspectMismatch === null || aspectMismatch <= 0.05 ? 'PASS' : 'WARN', 'canvas aspect preserved at 1280x720 (no stretch)', { bufferedAspect: canvas.bufferedAspect, displayedAspect: canvas.displayedAspect, relativeMismatch: round(aspectMismatch, 4), note: aspectMismatch !== null && aspectMismatch > 0.05 ? 'render buffer aspect differs from displayed aspect (possible stretch or letterbox)' : null });
  record('H5', 'H', 'INFO', 'narrow viewport UI/fps', { fps, ranges: ui.ranges.length, actions: ui.actions.length, presets: ui.presets.length, bodyTextLength: ui.bodyText.length });

  await page.setViewportSize(VIEWPORT);
  await page.waitForTimeout(800);
  const restored = await probeCanvas(page);
  record('H6', 'H', restored.found && restored.viewport.width === VIEWPORT.width && restored.viewport.height === VIEWPORT.height ? 'PASS' : 'FAIL', 'viewport restored to 1920x1080 after responsive test', { viewport: restored.viewport, canvas: restored.found ? { widthAttr: restored.widthAttr, heightAttr: restored.heightAttr } : null });

  phase.canvas = canvas;
  phase.shot = shot;
  phase.pixel = pixel;
  phase.fps = fps;
  phase.problems = problems;
  phase.aspectMismatch = aspectMismatch;
  return phase;
}

// ---------------------------------------------------------------------------
// B11/B12 -- UI hide & restore ; B13 -- control panel fit
// ---------------------------------------------------------------------------
async function runUiHidePhase(page) {
  logBlank();
  log('-- B11. UI hide / restore --');
  const probeUi = () => page.evaluate(() => {
    const styleOf = (el) => {
      if (!el) return null;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return { visibility: style.visibility, opacity: Number(style.opacity), display: style.display, width: Math.round(rect.width), height: Math.round(rect.height), x: Math.round(rect.x), y: Math.round(rect.y) };
    };
    return {
      bodyClass: String(document.body.className),
      uiHiddenFlag: document.body.classList.contains('ui-hidden'),
      panel: styleOf(document.getElementById('control-panel')),
      brand: styleOf(document.getElementById('brand')),
      hint: styleOf(document.getElementById('hint-card')),
      stats: styleOf(document.getElementById('stats-pill')),
      restore: styleOf(document.getElementById('restore-ui')),
      canvas: styleOf(document.querySelector('canvas')),
    };
  });
  const before = await probeUi();
  const hideClick = await page.locator('[data-action="toggleUI"]').first().click({ timeout: 5000 }).then(() => ({ ok: true })).catch((error) => ({ ok: false, reason: String(error?.message ?? error) }));
  await page.waitForTimeout(800);
  const hidden = await probeUi();
  const shotHidden = await takeScreenshot(page, '65-ui-hidden.png');
  const hiddenElementsOk = ['panel', 'brand', 'hint', 'stats'].every((key) => hidden[key] && hidden[key].visibility === 'hidden' && hidden[key].opacity <= 0.01);
  const restoreVisible = Boolean(hidden.restore && hidden.restore.visibility !== 'hidden' && hidden.restore.opacity > 0.5 && hidden.restore.width > 0);
  record('B11', 'B', hideClick.ok && hidden.uiHiddenFlag && hiddenElementsOk && restoreVisible ? 'PASS' : 'FAIL', 'hide UI (eye button) hides panel/brand/hint/stats and reveals restore control', { hideClick, hiddenElementsOk, restoreVisible, before, hidden, shot: shotHidden.name });

  await page.keyboard.press('h');
  await page.waitForTimeout(900);
  const restored = await probeUi();
  const shotRestored = await takeScreenshot(page, '66-ui-restored.png');
  const restoreOk = !restored.uiHiddenFlag && restored.panel && restored.panel.visibility !== 'hidden' && restored.panel.opacity > 0.5;
  record('B12', 'B', restoreOk ? 'PASS' : 'FAIL', 'restore UI (keyboard H) brings the panel back', { restored, shot: shotRestored.name });
  if (!restoreOk) {
    await page.locator('#restore-ui').click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(800);
    const afterFallback = await probeUi();
    record('B12b', 'B', !afterFallback.uiHiddenFlag ? 'PASS' : 'FAIL', 'restore UI via restore button fallback', { afterFallback });
  }
  return { before, hidden, restored, hiddenElementsOk, restoreVisible, shotHidden, shotRestored };
}

async function runPanelFitPhase(page) {
  logBlank();
  log('-- B13. control panel fit at 1920x1080 --');
  const fit = await page.evaluate(() => {
    const panel = document.getElementById('control-panel');
    const scroll = panel?.querySelector('.panel-scroll') ?? panel;
    const rectOf = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height, visibility: s.visibility, display: s.display, opacity: Number(s.opacity) }; };
    const visibleOnScreen = (el) => { const r = rectOf(el); return r.visibility !== 'hidden' && r.display !== 'none' && r.opacity > 0.01 && r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; };
    const scrollRect = scroll.getBoundingClientRect();
    const inScrollWindow = (el) => { const r = el.getBoundingClientRect(); return r.top >= scrollRect.top - 1 && r.bottom <= scrollRect.bottom + 1; };
    const sections = [...document.querySelectorAll('.control-section')].map((el) => ({ text: String(el.innerText || '').split('\n')[0].slice(0, 30), visible: visibleOnScreen(el), inScrollWindow: inScrollWindow(el) }));
    const presets = [...document.querySelectorAll('[data-preset]')].map((el) => ({ name: el.getAttribute('data-preset'), visible: visibleOnScreen(el), inScrollWindow: inScrollWindow(el) }));
    const sandboxButtons = [...document.querySelectorAll('.sandbox-actions button')].map((el) => ({ text: String(el.innerText || '').trim().slice(0, 20), visible: visibleOnScreen(el), inScrollWindow: inScrollWindow(el) }));
    const pause = document.getElementById('pause-button');
    return {
      viewport: { width: innerWidth, height: innerHeight },
      panel: rectOf(panel),
      scroll: { ...rectOf(scroll), scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight, scrollTop: scroll.scrollTop },
      sections, presets, sandboxButtons,
      pauseVisible: pause ? visibleOnScreen(pause) : null,
      pageOverflow: { scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight },
    };
  });
  const panelFits = fit.panel.visibility !== 'hidden' && fit.panel.top >= -1 && fit.panel.bottom <= fit.viewport.height + 1 && fit.panel.right <= fit.viewport.width + 1;
  const noScrollNeeded = fit.scroll.scrollHeight <= fit.scroll.clientHeight + 1;
  const sectionsVisible = fit.sections.every((section) => section.visible && section.inScrollWindow);
  const presetsVisible = fit.presets.every((preset) => preset.visible && preset.inScrollWindow);
  const sandboxVisible = fit.sandboxButtons.every((button) => button.visible && button.inScrollWindow);
  const ok = panelFits && noScrollNeeded && sectionsVisible && presetsVisible && sandboxVisible && fit.pauseVisible !== false;
  record('B13', 'B', ok ? 'PASS' : 'FAIL', 'control panel fits 1920x1080: sections, camera presets and sandbox buttons all visible without scrolling', {
    panelFits, noScrollNeeded, sectionsVisible, presetsVisible, sandboxVisible, pauseVisible: fit.pauseVisible,
    scroll: fit.scroll, sections: fit.sections, presets: fit.presets, sandboxButtons: fit.sandboxButtons,
  });
  return fit;
}

// ---------------------------------------------------------------------------
// Phase A10 -- offline file:// reload
// ---------------------------------------------------------------------------
async function runOfflinePhase(context, fileUrl) {
  logBlank();
  log('-- A10. offline file:// reload --');
  if (!fileUrl) {
    record('A10', 'A', 'SKIP', 'offline file:// reload', { note: 'no file target' });
    return null;
  }
  const page = await context.newPage();
  const pageLog = createPageLog();
  attachPageLogging(page, pageLog);
  let navigationError = null;
  try {
    await context.setOffline(true);
    await page.goto(fileUrl, { waitUntil: 'load', timeout: 30000 });
  } catch (error) {
    navigationError = String(error?.message ?? error);
  }
  let ready = { ok: false, error: navigationError };
  let shot = null, pixel = null, state = null;
  if (!navigationError) {
    try { await installPageHelpers(page); } catch (error) {}
    ready = await waitForReady(page, 20000, pageLog);
    if (ready.ok) {
      await page.waitForTimeout(1000);
      try { state = await page.evaluate(() => window.__qa.stateSnapshot()); } catch (error) {}
      shot = await takeScreenshot(page, '80-offline-file.png');
      try { pixel = await collectPixelStats(page); } catch (error) {}
    }
  }
  const externalDuringOffline = externalAttempts.filter((attempt) => attempt.phase === 'offline');
  const pixelOk = Boolean(pixel && pixel.meanBrightness >= 6 && pixel.stdBrightness >= 5 && pixel.darkFraction <= 0.6);
  const clean = pageLog.consoleErrors.length === 0 && pageLog.pageErrors.length === 0 && pageLog.failedRequests.filter((request) => !request.external).length === 0;
  const status = navigationError ? 'WARN' : (ready.ok && pixelOk ? 'PASS' : 'FAIL');
  record('A10', 'A', status, 'offline file:// reload renders without errors', {
    navigationError,
    ready,
    consoleErrors: pageLog.consoleErrors.slice(0, 5),
    pageErrors: pageLog.pageErrors.slice(0, 5),
    failedRequests: pageLog.failedRequests.filter((request) => !request.external).slice(0, 5),
    pixelOk,
    pixel,
    shot: shot?.name ?? null,
    stateKeys: state ? Object.keys(state) : null,
    clean,
    externalDuringOffline,
  });
  await context.setOffline(false).catch(() => {});
  await page.close().catch(() => {});
  return { pageLog, ready, pixel, shot, navigationError, clean };
}

// ---------------------------------------------------------------------------
// Acceptance recording helpers
// ---------------------------------------------------------------------------
function cleanLogStatus(pageLog) {
  return pageLog.consoleErrors.length === 0 && pageLog.pageErrors.length === 0 && pageLog.failedRequests.filter((request) => !request.external).length === 0 && pageLog.badResponses.length === 0;
}
function summarizeRun(run, url) {
  const pageLog = run.pageLog;
  return {
    url,
    navigationError: run.navigationError,
    ready: { ok: run.ready.ok, elapsedMs: run.ready.elapsedMs, error: run.ready.error ?? null, snapshot: run.ready.snapshot ?? null },
    bootShot: run.bootShot ?? null,
    stateSummary: run.state ? {
      hookPresent: run.state.hookPresent,
      ready: run.state.ready,
      boat: run.state.boat,
      nonFinite: run.state.nonFinite,
      diagError: run.state.diagError,
      stateError: run.state.stateError,
    } : null,
    consoleErrors: pageLog.consoleErrors.slice(0, 10),
    pageErrors: pageLog.pageErrors.slice(0, 10),
    failedRequests: pageLog.failedRequests.filter((request) => !request.external).slice(0, 10),
    badResponses: pageLog.badResponses.slice(0, 10),
    warnings: [...new Set(pageLog.consoleWarnings.map((warning) => warning.text))].slice(0, 15),
    counts: {
      consoleMessages: pageLog.consoleMessages.length,
      consoleErrors: pageLog.consoleErrors.length,
      pageErrors: pageLog.pageErrors.length,
      failedRequests: pageLog.failedRequests.filter((request) => !request.external).length,
      badResponses: pageLog.badResponses.length,
      dialogs: pageLog.dialogs.length,
    },
  };
}
function pixelHealthy(pixel) {
  return Boolean(pixel) && pixel.meanBrightness >= 6 && pixel.stdBrightness >= 5 && pixel.darkFraction <= 0.6 && pixel.uniqueColors >= 24;
}
function pixelRich(pixel) {
  return Boolean(pixel) && pixel.stdBrightness >= 10 && pixel.uniqueColors >= 64 && pixel.colorfulFraction >= 0.02;
}
function assessCanvas(canvas, viewport = VIEWPORT) {
  if (!canvas || !canvas.found) return { found: false, raw: canvas };
  const coverageWidth = canvas.rect ? canvas.rect.width / viewport.width : null;
  const coverageHeight = canvas.rect ? canvas.rect.height / viewport.height : null;
  const renderings = [canvas.imageRendering, ...(canvas.ancestorRenderings ?? []).map((entry) => entry.imageRendering)];
  return {
    found: true,
    raw: canvas,
    coverageWidth,
    coverageHeight,
    covers: (coverageWidth ?? 0) >= 0.98 && (coverageHeight ?? 0) >= 0.98,
    lowRes: Boolean(canvas.widthAttr && canvas.widthAttr < viewport.width),
    nearest: renderings.some((value) => value === 'pixelated' || value === 'crisp-edges'),
    renderings,
    contextType: canvas.contextType,
    buffer: [canvas.widthAttr, canvas.heightAttr],
    displayedSize: [canvas.clientWidth, canvas.clientHeight],
  };
}
function recordCanvasChecks(prefix, canvas, pixel, fps) {
  const assessment = assessCanvas(canvas);
  record(prefix + '1', 'B', assessment.found && assessment.covers ? 'PASS' : 'FAIL', 'canvas exists and covers the fixed 1920x1080 viewport', {
    found: assessment.found,
    coverage: assessment.found ? { width: round(assessment.coverageWidth * 100, 2), height: round(assessment.coverageHeight * 100, 2) } : null,
    buffer: assessment.buffer ?? null,
    displayedSize: assessment.displayedSize ?? null,
    rect: assessment.raw?.rect ?? null,
    viewport: assessment.raw?.viewport ?? null,
  });
  const bufferWidth = assessment.raw?.widthAttr ?? null;
  const lowResStatus = bufferWidth === null ? 'FAIL' : (bufferWidth < VIEWPORT.width * 0.8 ? 'PASS' : (bufferWidth < VIEWPORT.width ? 'WARN' : 'FAIL'));
  record(prefix + '2', 'B', lowResStatus, 'canvas renders at low internal resolution (upscaled)', {
    bufferWidth,
    bufferHeight: assessment.raw?.heightAttr ?? null,
    viewport: VIEWPORT,
    note: lowResStatus === 'FAIL' ? 'render target is not low-res; spec asks for a low-res buffer upscaled to the viewport' : null,
  });
  record(prefix + '3', 'B', assessment.nearest ? 'PASS' : 'FAIL', 'canvas upscaled with nearest-neighbour image-rendering', {
    imageRendering: assessment.raw?.imageRendering ?? null,
    ancestorRenderings: assessment.raw?.ancestorRenderings ?? [],
    detected: assessment.renderings,
  });
  record(prefix + '4', 'B', pixelHealthy(pixel) ? 'PASS' : 'FAIL', 'frame is non-black and non-uniform (pixel statistics)', pixel ?? null);
  record(prefix + '5', 'B', assessment.contextType === 'webgl2' || assessment.contextType === 'webgl' ? 'PASS' : (assessment.contextType === null ? 'FAIL' : 'WARN'), 'canvas has an active WebGL context', { contextType: assessment.contextType });
  if (fps) record(prefix + '6', 'B', fps.fps >= 30 ? 'PASS' : (fps.fps >= 20 ? 'WARN' : 'FAIL'), 'rAF frame rate at default view', fps);
  return assessment;
}
function recordUiChecks(ui) {
  if (!ui) { record('B7', 'B', 'FAIL', 'DOM HUD/UI overlay present and readable', { ui: null }); return; }
  const visibleRanges = ui.ranges.filter((range) => range.visible);
  const hudFonts = ui.hudCandidates.map((entry) => entry.fontSize).filter(Boolean);
  const fontOk = !hudFonts.length || hudFonts.every((fontSize) => parseFloat(fontSize) >= 11);
  const status = (ui.ranges.length + ui.buttons.length === 0) ? 'FAIL' : ((ui.ranges.length === 0 || ui.actions.length === 0) ? 'WARN' : (fontOk ? 'PASS' : 'WARN'));
  record('B7', 'B', status, 'DOM HUD/UI overlay present and readable (not baked into low-res canvas)', {
    ranges: ui.ranges.length,
    visibleRanges: visibleRanges.length,
    actions: ui.actions.length,
    buttons: ui.buttons.length,
    presets: ui.presets.length,
    quality: ui.quality.length,
    hudFontSizes: hudFonts,
    bodyTextPreview: ui.bodyText.slice(0, 300),
  });
  record('B8', 'B', ui.presets.length >= 2 ? 'PASS' : 'WARN', 'expected UI families present ([data-control], [data-action], [data-preset], [data-toggle], [data-edit])', {
    controls: ui.controls.map((control) => control.name),
    actions: ui.actions.map((action) => action.name),
    presets: ui.presets.map((preset) => preset.name),
    quality: ui.quality.map((button) => button.name),
    toggles: (ui.toggles ?? []).map((toggle) => toggle.name),
    edits: (ui.edits ?? []).map((edit) => edit.mode),
  });
}

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------
const CATEGORY_TITLES = {
  A: 'A. Offline single-file loading, API, console/network hygiene',
  B: 'B. Visual/render integrity, canvas & UI fidelity',
  C: 'C. Wave height control & wave -> boat coupling',
  D: 'D. Wave direction control & motion signature',
  E: 'E. Camera presets, orbit drag & wheel zoom',
  F: 'F. Pause/resume, reset, screenshot, lighthouse, editing',
  G: 'G. Performance/FPS & quality presets',
  H: 'H. Responsive 1280x720 layout',
};
function categoryVerdict(letter) {
  const entries = results.filter((entry) => entry.id.startsWith(letter));
  if (!entries.length) return { verdict: 'SKIP', pass: 0, fail: 0, warn: 0, skip: 0, total: 0 };
  const fail = entries.filter((entry) => entry.status === 'FAIL').length;
  const warn = entries.filter((entry) => entry.status === 'WARN').length;
  const skip = entries.filter((entry) => entry.status === 'SKIP').length;
  const pass = entries.filter((entry) => entry.status === 'PASS').length;
  const failFirst = fail > 0 ? 'FAIL' : (warn > 0 ? 'PARTIAL' : (skip > 0 ? 'PARTIAL' : 'PASS'));
  return { verdict: failFirst, pass, fail, warn, skip, info: entries.length - (pass + fail + warn + skip), total: pass + fail + warn + skip };
}
function overallVerdict() {
  const verdicts = Object.keys(CATEGORY_TITLES).map((letter) => categoryVerdict(letter).verdict);
  if (verdicts.includes('FAIL')) return 'FAIL';
  if (verdicts.includes('PARTIAL')) return 'PARTIAL';
  return 'PASS';
}
function mdCell(value) {
  if (value === null || value === undefined) return '-';
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
function mdTable(headers, rows) {
  const lines = ['| ' + headers.map(mdCell).join(' | ') + ' |', '| ' + headers.map(() => '---').join(' | ') + ' |'];
  for (const row of rows) lines.push('| ' + row.map(mdCell).join(' | ') + ' |');
  return lines.join('\n');
}
function compactJson(value, maxLength = 700) {
  if (value === null || value === undefined) return '-';
  let text;
  try { text = typeof value === 'string' ? value : JSON.stringify(value); } catch (error) { text = String(value); }
  if (text.length > maxLength) text = text.slice(0, maxLength) + '...';
  return text.replace(/\|/g, '\\|');
}
function collectShots(node, out = new Map(), depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return out;
  if (Array.isArray(node)) {
    for (const value of node) collectShots(value, out, depth + 1);
    return out;
  }
  if (typeof node.path === 'string' && node.path.startsWith('qa-shots/') && typeof node.name === 'string' && ('width' in node) && ('bytes' in node)) out.set(node.path, node);
  for (const value of Object.values(node)) collectShots(value, out, depth + 1);
  return out;
}
function buildReport(data, results) {
  const meta = data.meta;
  const lines = [];
  const verdict = overallVerdict();
  const failEntries = results.filter((entry) => entry.status === 'FAIL');
  const warnEntries = results.filter((entry) => entry.status === 'WARN');
  lines.push('# QA Report -- Bottle Ocean Sandbox');
  lines.push('');
  lines.push('**Overall verdict: ' + verdict + '**  ');
  lines.push('Generated: ' + meta.finishedAt + '  ');
  lines.push('Artifact: `' + (data.artifactPath ?? '(unknown)') + '`  ');
  lines.push('Checks: ' + results.length + ' total, ' + results.filter((entry) => entry.status === 'PASS').length + ' PASS, ' + failEntries.length + ' FAIL, ' + warnEntries.length + ' WARN, ' + results.filter((entry) => entry.status === 'SKIP').length + ' SKIP');
  lines.push('');
  lines.push('## Acceptance summary (A-H)');
  lines.push('');
  const summaryRows = Object.entries(CATEGORY_TITLES).map(([letter, title]) => {
    const summary = categoryVerdict(letter);
    return [letter, title.replace(/^[A-H]\.\s*/, ''), summary.verdict, summary.pass + '/' + summary.total, summary.fail, summary.warn, summary.skip];
  });
  lines.push(mdTable(['Cat', 'Area', 'Verdict', 'PASS/total', 'FAIL', 'WARN', 'SKIP'], summaryRows));
  lines.push('');
  lines.push('## Environment & method');
  lines.push('');
  lines.push('- Host: ' + meta.platform + ', Node ' + meta.nodeVersion);
  lines.push('- Browser: Google Chrome ' + meta.chromeVersion + ' (headless=' + meta.headless + ', mode=' + meta.browserMode + ')');
  lines.push('- WebGL probe: ' + compactJson(meta.webgl));
  lines.push('- Viewport: 1920x1080 @ dsf=' + meta.deviceScaleFactor + '; tablet/narrow pass at 1280x720');
  lines.push('- Targets: file://' + (meta.fileUrl ? ' + ' : '') + ' http://127.0.0.1:' + meta.port + ' (local static server, zero external network allowed)');
  lines.push('- Harness: Playwright drives the real DOM; pixel statistics from PNG screenshots decoded in-page; motion from sampled `getDiagnostics()` + live boat object.');
  lines.push('- Warmup ' + meta.warmupMs + ' ms, wave settle ' + meta.settleMs + ' ms; diagnostics sampled 64x over 3.6s per stable wave setting (>=40 samples / >=2s as specified, window widened to cover full wave periods), 56x over 3s per wave direction.');
  lines.push('');
  lines.push('## Artifact facts');
  lines.push('');
  if (data.artifact) {
    const artifact = data.artifact;
    lines.push(mdTable(['Metric', 'Value'], [
      ['Size', artifact.kib + ' KiB (' + artifact.bytes + ' bytes)'],
      ['Inline <script> blocks', artifact.inlineScriptCount + ' (' + artifact.inlineScriptBytes + ' bytes)'],
      ['External <script src>', artifact.scriptSrc.length ? artifact.scriptSrc.join(', ') : 'none'],
      ['External <link href>', artifact.linkHref.length ? artifact.linkHref.join(', ') : 'none'],
      ['External script/link refs', artifact.externalRefs.length],
      ['Import map count / external', artifact.importMapCount + ' / ' + artifact.importMapExternal],
      ['Bundled Three.js markers', 'REVISION180=' + artifact.hasThreeRevision + ', WebGLRenderer=' + artifact.hasWebGLRenderer + ', ShaderMaterial=' + artifact.hasShaderMaterial],
      ['HTML open external URL strings', artifact.httpUrlStrings.length],
      ['CSP meta', artifact.metaCsp],
      ['sha256 (tested build)', meta.artifactBefore?.sha256 ?? 'unknown'],
      ['mtime / size', (meta.artifactBefore?.mtimeIso ?? 'unknown') + ' / ' + (meta.artifactBefore?.bytes ?? 'unknown') + ' bytes'],
      ['stable during run', meta.artifactStableDuringRun === true ? 'yes' : (meta.artifactStableDuringRun === false ? 'NO (rebuilt during run)' : 'unknown')],
    ]));
    if (artifact.httpUrlStrings.length) lines.push('\nExternal URL strings found in HTML (may be inert namespace/docs strings; network guard verifies no fetch): ' + artifact.httpUrlStrings.slice(0, 8).map((url) => '`' + url + '`').join(', '));
  } else {
    lines.push('- Artifact inspection unavailable.');
  }
  lines.push('');
  lines.push('## Load, network & console');
  lines.push('');
  const loadRows = [];
  for (const [label, load] of Object.entries(data.loads ?? {})) {
    if (!load) continue;
    loadRows.push([label, load.ready.ok ? 'ready in ' + load.ready.elapsedMs + 'ms' : 'FAILED: ' + (load.ready.error ?? load.navigationError), load.counts.consoleErrors, load.counts.pageErrors, load.counts.failedRequests, load.counts.badResponses, load.counts.consoleMessages]);
  }
  lines.push(mdTable(['Target', 'Ready', 'Console errors', 'Page errors', 'Failed requests', 'HTTP >=400', 'Console messages'], loadRows));
  lines.push('');
  lines.push('- External network attempts during the whole run: **' + (data.errors.externalAttempts.length) + '** (must be 0).');
  const warnings = data.errors.consoleWarnings ?? [];
  if (warnings.length) {
    lines.push('- Console warnings (' + warnings.length + '):');
    for (const warning of warnings.slice(0, 10)) lines.push('  - ' + mdCell(warning.text));
  } else {
    lines.push('- Console warnings: none.');
  }
  lines.push('');
  lines.push('## Render & canvas fidelity');
  lines.push('');
  const renderRows = [];
  for (const [label, entry] of Object.entries(data.render ?? {})) {
    if (!entry?.pixel) continue;
    renderRows.push([label, entry.pixel.meanBrightness, entry.pixel.stdBrightness, entry.pixel.darkFraction, entry.pixel.colorfulFraction, entry.pixel.uniqueColors, entry.fps ? entry.fps.fps : '-']);
  }
  lines.push(mdTable(['Frame', 'Mean brightness', 'Std brightness', 'Dark fraction', 'Colorful fraction', 'Unique colors', 'rAF FPS'], renderRows));
  lines.push('');
  if (data.canvas) {
    const canvas = data.canvas;
    lines.push('- Canvas buffer: ' + canvas.widthAttr + 'x' + canvas.heightAttr + ' displayed at ' + round(canvas.clientWidth, 0) + 'x' + round(canvas.clientHeight, 0) + ' (coverage ' + round((canvas.rect.width / canvas.viewport.width) * 100, 1) + '% x ' + round((canvas.rect.height / canvas.viewport.height) * 100, 1) + '%).');
    lines.push('- image-rendering: `' + canvas.imageRendering + '`; context: ' + canvas.contextType + '; dpr: ' + canvas.viewport.dpr + '.');
  }
  if (data.ui) {
    lines.push('- DOM UI: ' + data.ui.ranges.length + ' range inputs, ' + data.ui.actions.length + ' data-action buttons, ' + data.ui.presets.length + ' camera presets, ' + data.ui.quality.length + ' quality buttons, ' + data.ui.outputs.length + ' readouts.');
  }
  for (const uiCheckId of ['B11', 'B12', 'B13']) {
    const uiCheck = results.find((entry) => entry.id === uiCheckId);
    if (!uiCheck) continue;
    lines.push('- [' + uiCheck.id + '] ' + uiCheck.name + ': **' + uiCheck.status + '** — ' + compactJson(uiCheck.details, 650));
  }
  lines.push('');
  lines.push('## C. Wave height -> boat coupling');
  lines.push('');
  const waveRows = [];
  const waveData = data.waves ?? {};
  for (const key of ['calm', 'medium', 'strong']) {
    const setting = waveData.settings?.[key];
    if (!setting) continue;
    const motion = setting.motion;
    waveRows.push([key + ' (' + setting.value + ')', round(channelStat(motion, 'boatY', 'amplitude'), 5), round(channelStat(motion, 'pitch', 'amplitude'), 5), round(channelStat(motion, 'roll', 'amplitude'), 5), round(channelStat(motion, 'waveHeight', 'mean'), 4), motion.sampleCount, motion.nonFinite.length, setting.shot?.name ?? '-']);
  }
  lines.push(mdTable(['UI setting', 'Boat heave amp', 'Pitch amp', 'Roll amp', 'Wave telemetry mean', 'Samples', 'Non-finite', 'Screenshot'], waveRows));
  lines.push('');
  const hookRows = [];
  for (const key of ['calm', 'medium', 'strong']) {
    const entry = waveData.hookSettings?.[key];
    if (!entry) continue;
    hookRows.push([key + ' (' + entry.value + ')', entry.hookSet?.ok ? 'ok' : 'FAILED: ' + (entry.hookSet?.reason ?? ''), round(channelStat(entry.motion, 'boatY', 'amplitude'), 5), round(channelStat(entry.motion, 'pitch', 'amplitude'), 5)]);
  }
  if (hookRows.length) lines.push(mdTable(['setParam value', 'Hook', 'Boat heave amp', 'Pitch amp'], hookRows));
  const c9Result = results.find((entry) => entry.id === 'C9');
  if (c9Result) {
    lines.push('');
    lines.push('Containment/clipping check: **' + c9Result.status + '** — ' + compactJson({
      containmentInsideFraction: c9Result.details?.containmentInsideFraction ?? null,
      mastTipInsideFraction: c9Result.details?.mastTipInsideFraction ?? null,
      mastTipsInsideFraction: c9Result.details?.mastTipsInsideFraction ?? null,
      safety: c9Result.details?.safety ?? [],
      clippingFields: c9Result.details?.clippingFields ?? [],
      clippingViolations: c9Result.details?.clippingViolations ?? [],
      note: c9Result.details?.note ?? null,
    }, 900));
  }
  lines.push('');
  lines.push('## D. Wave direction signatures');
  lines.push('');
  const directionRows = [];
  for (const direction of [0, 90, 180]) {
    const run = data.directions?.runs?.[direction];
    if (!run) continue;
    directionRows.push([direction + ' deg', round(channelStat(run.motion, 'boatY', 'amplitude'), 5), round(channelStat(run.motion, 'pitch', 'amplitude'), 5), round(channelStat(run.motion, 'roll', 'amplitude'), 5), round(channelStat(run.motion, 'waveDirection', 'mean'), 2), run.shot?.name ?? '-']);
  }
  lines.push(mdTable(['Direction', 'Boat heave amp', 'Pitch amp', 'Roll amp', 'Direction telemetry', 'Screenshot'], directionRows));
  const d3 = results.find((entry) => entry.id === 'D3');
  if (d3) {
    lines.push('');
    lines.push('Pairwise y/pitch/roll correlation of motion series: ' + compactJson(d3.details?.comparisons, 1200));
  }
  lines.push('');
  lines.push('## E. Camera presets & orbit');
  lines.push('');
  const cameraRows = (data.camera?.presets ?? []).map((preset) => [preset.name, preset.position ? [round(preset.position.x, 2), round(preset.position.y, 2), round(preset.position.z, 2)].join(', ') : 'not exposed', round(preset.cameraDistance, 4), preset.visualDiff ? preset.visualDiff.meanAbsDiff : '-', preset.changed ? 'changed' : (preset.alreadyActive ? 'already active' : 'NO CHANGE'), preset.shot?.name ?? '-']);
  lines.push(mdTable(['Preset', 'Camera position', 'Camera delta', 'Visual diff', 'Result', 'Screenshot'], cameraRows));
  const requiredRows = (data.camera?.required ?? []).map((entry) => [entry.file, entry.presetName ?? '-', entry.source ?? 'NOT CAPTURED', entry.hookResult ? compactJson(entry.hookResult, 200) : '-']);
  lines.push('');
  lines.push(mdTable(['Required screenshot', 'Preset', 'Source', 'Hook fallback'], requiredRows));
  lines.push('');
  lines.push('- Orbit drag: ' + compactJson(data.camera?.orbit?.cameraDistance ?? data.camera?.orbit?.visualDiff ?? null, 300) + '; wheel zoom: ' + compactJson(data.camera?.wheel?.cameraDistance ?? data.camera?.wheel?.visualDiff ?? null, 300));
  lines.push('');
  lines.push('## F. Interactions');
  lines.push('');
  const interactions = data.interactions ?? {};
  const interactionRows = [
    ['Pause freezes sim', compactJson({ simTimeDelta: interactions.pause?.frozenSimTimeDelta, poseMaxStep: interactions.pause?.frozenPoseMaxStep, pausedFlag: interactions.pause?.pausedFlag }, 400)],
    ['Resume smooth', compactJson({ simTimeDelta: interactions.pause?.resumeSimDelta, firstFrameDelta: interactions.pause?.firstResumedFrameDelta, maxPerSampleStep: interactions.pause?.maxPerSampleStepAfterResume, noNonFiniteValues: interactions.pause?.resumeFinite }, 450)],
    ['Reset slider defaults', compactJson(interactions.reset?.mismatches ?? 'no reset button', 400)],
    ['Screenshot capture', compactJson({ kind: interactions.capture?.kind ?? 'none', dimensions: interactions.capture?.dimensions ?? null, validPng: interactions.capture?.validPng ?? null }, 300)],
    ['Lighthouse toggle', compactJson({ stateChanged: interactions.lighthouse?.stateChanged, visualDiff: interactions.lighthouse?.visualDiff?.meanAbsDiff ?? null }, 300)],
    ['Editing interaction', compactJson(interactions.editing?.actionResult ?? (interactions.editing ? 'tested' : 'not implemented'), 300)],
  ];
  lines.push(mdTable(['Interaction', 'Detail'], interactionRows));
  lines.push('');
  lines.push('## G. Performance / quality');
  lines.push('');
  const fpsRows = (data.performance?.qualityRows ?? []).map((row) => [row.preset, row.fps.fps, row.fps.maxGapMs, row.fps.frames, row.errorsDelta ?? '-', row.shot?.name ?? '-']);
  lines.push(mdTable(['Quality preset', 'FPS', 'Max frame gap (ms)', 'Frames', 'Console errors', 'Screenshot'], fpsRows.length ? fpsRows : [['(default)', data.performance?.defaultFps?.fps ?? '-', data.performance?.defaultFps?.maxGapMs ?? '-', data.performance?.defaultFps?.frames ?? '-', '-', '-']]));
  lines.push('');
  lines.push('- Default FPS: ' + compactJson(data.performance?.defaultFps));
  lines.push('- Renderer/perf counters from getDiagnostics(): ' + compactJson(data.performance?.perfPaths, 500));
  lines.push('');
  lines.push('## H. Responsive 1280x720');
  lines.push('');
  const responsive = data.responsive ?? {};
  lines.push(mdTable(['Metric', 'Value'], [
    ['Screenshot', responsive.shot ? responsive.shot.name + ' (' + responsive.shot.width + 'x' + responsive.shot.height + ')' : '-'],
    ['Canvas coverage', responsive.canvas ? round((responsive.canvas.rect.width / responsive.canvas.viewport.width) * 100, 1) + '% x ' + round((responsive.canvas.rect.height / responsive.canvas.viewport.height) * 100, 1) + '%' : '-'],
    ['Render buffer / displayed aspect', responsive.canvas ? responsive.canvas.bufferedAspect + ' / ' + responsive.canvas.displayedAspect : '-'],
    ['Overflow problems', (responsive.problems ?? []).join('; ') || 'none'],
    ['Pixel stats', compactJson(responsive.pixel ? { mean: responsive.pixel.meanBrightness, std: responsive.pixel.stdBrightness, colors: responsive.pixel.uniqueColors } : null, 250)],
    ['FPS at 1280x720', responsive.fps?.fps ?? '-'],
  ]));
  lines.push('');
  lines.push('## Offline reload (file://)');
  lines.push('');
  lines.push(compactJson(data.offline ? { ready: data.offline.ready?.ok, navigationError: data.offline.navigationError, pixel: data.offline.pixel ? { mean: data.offline.pixel.meanBrightness, std: data.offline.pixel.stdBrightness } : null } : { note: 'not run' }, 600));
  lines.push('');
  lines.push('## Defects / follow-ups');
  lines.push('');
  const defectEntries = [...failEntries, ...warnEntries];
  if (!defectEntries.length) {
    lines.push('- None observed by the automated checks.');
  } else {
    for (const entry of defectEntries) {
      lines.push('- **[' + entry.status + '] [' + entry.id + '] ' + entry.name + '**');
      if (entry.details !== null && entry.details !== undefined) lines.push('  - detail: ' + compactJson(entry.details, 900));
    }
  }
  lines.push('');
  lines.push('## Evidence screenshots');
  lines.push('');
  const shots = [...collectShots(data).values()];
  if (shots.length) {
    lines.push(mdTable(['File', 'Dimensions', 'Size (KiB)'], shots.map((shot) => [shot.path, shot.width + 'x' + shot.height, round((shot.bytes ?? 0) / 1024, 0)])));
  } else {
    lines.push('- none collected');
  }
  lines.push('');
  lines.push('## Limitations');
  lines.push('');
  lines.push('- Headless Chrome may use hardware ANGLE or SwiftShader depending on host; measured FPS is indicative only and can differ from an interactive desktop session.');
  lines.push('- Clipping containment is only as strong as the telemetry the artifact exposes (`getDiagnostics()`, bottle bounds, boat pose). If no bounds are exposed, the check is reported as WARN/PARTIAL rather than silently passing.');
  lines.push('- Aesthetic quality (composition, lighting, reference fidelity) is judged from screenshots; automated checks only verify measurable properties.');
  lines.push('- Peak memory/GPU load, long-session stability (>30s) and audio were not part of this pass unless noted.');
  lines.push('- The QA harness never modifies the artifact; all UI actions and hook calls are read/drive only.');
  lines.push('');
  lines.push('---');
  lines.push('_Generated by tools/qa.mjs; raw data: qa-shots/results.json._');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(SHOTS_DIR, { recursive: true });
  const startedAt = new Date();
  const data = {
    meta: {
      startedAt: startedAt.toISOString(),
      finishedAt: null,
      durationMs: null,
      nodeVersion: process.version,
      platform: process.platform + ' ' + process.arch,
      port: options.port,
      viewport: VIEWPORT,
      narrowViewport: NARROW_VIEWPORT,
      deviceScaleFactor: 1,
      warmupMs: WARMUP_MS,
      settleMs: SETTLE_MS,
      headless: !options.headed,
      browserMode: null,
      chromeVersion: null,
      webgl: null,
      fileUrl: null,
      serverUrl: null,
    },
    artifactPath: null,
    artifact: null,
    loads: {},
    render: {},
    canvas: null,
    ui: null,
    uiHide: null,
    panelFit: null,
    waves: null,
    directions: null,
    camera: null,
    interactions: null,
    performance: null,
    responsive: null,
    offline: null,
    errors: { consoleErrors: [], consoleWarnings: [], pageErrors: [], failedRequests: [], badResponses: [], externalAttempts: [], dialogs: [] },
  };
  let fatalError = null;
  let fatalStack = null;
  let browser = null;
  let server = null;
  let context = null;
  let smokeOnly = false;

  try {
    log('=== bottle ocean sandbox QA ===');
    log('started: ' + startedAt.toISOString());
    log('cwd: ' + ROOT);
    log('node: ' + process.version + ' | platform: ' + process.platform);

    const artifactExists = existsSync(ARTIFACT_PATH);
    const fixtureExists = existsSync(FIXTURE_PATH);
    let targetPath = null;
    let httpPath = null;
    if (options.fixture) {
      if (!fixtureExists) throw new Error('fixture not found: ' + FIXTURE_PATH);
      targetPath = FIXTURE_PATH;
      httpPath = 'qa-shots/fixture.html';
      smokeOnly = true;
      log('mode: FIXTURE SELF-TEST (harness validation only -- NOT acceptance evidence)');
    } else if (artifactExists) {
      targetPath = ARTIFACT_PATH;
      httpPath = 'bottle_ocean_sandbox.html';
      log('mode: FULL QA of bottle_ocean_sandbox.html');
    } else if (options.url) {
      log('mode: EXTERNAL URL QA (no local artifact found)');
    } else {
      if (!fixtureExists) throw new Error('bottle_ocean_sandbox.html is absent and qa-shots/fixture.html is missing');
      targetPath = FIXTURE_PATH;
      httpPath = 'qa-shots/fixture.html';
      smokeOnly = true;
      log('mode: HARNESS SELF-TEST -- bottle_ocean_sandbox.html not found yet');
      log('      the full acceptance run starts automatically once the Lead publishes the artifact');
    }
    data.artifactPath = targetPath ? path.relative(ROOT, targetPath) : '(external url)';
    data.meta.artifactBefore = targetPath ? await fileStamp(targetPath) : null;

    if (artifactExists && targetPath === ARTIFACT_PATH) {
      data.artifact = await inspectArtifact(ARTIFACT_PATH);
      record('A7', 'A', data.artifact.externalRefs.length === 0 ? 'PASS' : 'FAIL', 'artifact references no external scripts/links', { externalRefs: data.artifact.externalRefs, scriptSrc: data.artifact.scriptSrc, linkHref: data.artifact.linkHref });
      const inlineOk = data.artifact.inlineScriptBytes >= 150000 && data.artifact.scriptSrc.length === 0;
      record('A8', 'A', inlineOk ? 'PASS' : 'WARN', 'single-file artifact with bundled Three.js inline', {
        kib: data.artifact.kib,
        inlineScriptCount: data.artifact.inlineScriptCount,
        inlineScriptBytes: data.artifact.inlineScriptBytes,
        scriptSrc: data.artifact.scriptSrc,
        markers: { revision180: data.artifact.hasThreeRevision, webglRenderer: data.artifact.hasWebGLRenderer, shaderMaterial: data.artifact.hasShaderMaterial },
      });
    } else if (targetPath) {
      data.artifact = await inspectArtifact(targetPath);
    }

    const launched = await launchBrowser(options);
    browser = launched.browser;
    data.meta.browserMode = launched.mode;
    data.meta.webgl = launched.probe;
    try { data.meta.chromeVersion = browser.version(); } catch (error) {}
    log('  Chrome ' + data.meta.chromeVersion + ' | WebGL mode: ' + launched.mode + ' | renderer: ' + (launched.probe.renderer || 'unknown'));

    if (!options.url) {
      server = await startServer({ port: options.port, root: ROOT, quiet: true });
      data.meta.serverUrl = server.url;
      log('  server: ' + server.url);
    }
    const httpUrl = options.url ?? (server.url + httpPath);
    const fileUrl = targetPath ? pathToFileURL(targetPath).href : null;
    data.meta.fileUrl = fileUrl;

    context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, acceptDownloads: true });
    context.setDefaultTimeout(15000);
    context.setDefaultNavigationTimeout(30000);
    await installNetworkGuards(context, () => (server ? server.port : options.port));

    // ---------------- file:// ----------------
    let fileRun = null;
    if (fileUrl && !options.url) {
      logBlank();
      log('-- A/B. loading file:// target --');
      fileRun = await loadAndSettle(context, fileUrl);
      data.loads.file = summarizeRun(fileRun, fileUrl);
      record('A1', 'A', fileRun.ready.ok ? 'PASS' : 'FAIL', 'file:// reaches window.__bottleOcean.ready', {
        ready: fileRun.ready,
        bootShot: fileRun.bootShot?.name ?? null,
        navigationError: fileRun.navigationError,
        state: fileRun.state ? { hookPresent: fileRun.state.hookPresent, ready: fileRun.state.ready, nonFinite: fileRun.state.nonFinite, diagError: fileRun.state.diagError } : null,
      });
      record('A3', 'A', cleanLogStatus(fileRun.pageLog) ? 'PASS' : 'FAIL', 'file:// console/pageerror/request clean during load+warmup', data.loads.file.counts);
      if (fileRun.ready.ok) {
        const fileCanvas = await probeCanvas(fileRun.page);
        const filePixel = await collectPixelStats(fileRun.page);
        const fileFps = await measureFps(fileRun.page, 2000);
        const fileShot = await takeScreenshot(fileRun.page, '00-default-file.png');
        data.render.file = { pixel: filePixel, fps: fileFps, shot: fileShot };
        data.canvas = fileCanvas;
        data.loads.file.canvas = fileCanvas;
        recordCanvasChecks('B', fileCanvas, filePixel, fileFps);
        data.loads.file.resources = await fileRun.page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name)).catch(() => []);
        data.loads.file.consoleWarnings = data.loads.file.warnings;
      }
      await fileRun.page.close().catch(() => {});
    } else {
      record('A1', 'A', 'SKIP', 'file:// load (skipped)', { note: options.url ? '--url mode' : 'no target' });
      record('A3', 'A', 'SKIP', 'file:// console clean (skipped)');
    }

    // ---------------- http:// ----------------
    logBlank();
    log('-- A/B. loading http:// target --');
    const httpRun = await loadAndSettle(context, httpUrl);
    data.loads.http = summarizeRun(httpRun, httpUrl);
    record('A2', 'A', httpRun.ready.ok ? 'PASS' : 'FAIL', 'http://127.0.0.1 reaches window.__bottleOcean.ready', {
      url: httpUrl,
      ready: httpRun.ready,
      bootShot: httpRun.bootShot?.name ?? null,
      navigationError: httpRun.navigationError,
      state: httpRun.state ? { hookPresent: httpRun.state.hookPresent, ready: httpRun.state.ready, nonFinite: httpRun.state.nonFinite, diagError: httpRun.state.diagError } : null,
    });
    record('A4', 'A', cleanLogStatus(httpRun.pageLog) ? 'PASS' : 'FAIL', 'http:// console/pageerror/request clean during load+warmup', data.loads.http.counts);

    let httpCanvas = null, httpPixel = null, httpFps = null, httpUi = null;
    if (httpRun.ready.ok) {
      httpCanvas = await probeCanvas(httpRun.page);
      httpPixel = await collectPixelStats(httpRun.page);
      httpFps = await measureFps(httpRun.page, 2000);
      httpUi = await introspectUi(httpRun.page);
      const httpShot = await takeScreenshot(httpRun.page, '01-default-http.png');
      data.render.http = { pixel: httpPixel, fps: httpFps, shot: httpShot };
      data.canvas = httpCanvas;
      data.ui = httpUi;
      data.loads.http.canvas = httpCanvas;
      data.loads.http.resources = await httpRun.page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name)).catch(() => []);
      recordUiChecks(httpUi);
      data.uiHide = await runUiHidePhase(httpRun.page);
      await pageWaitForUi(httpRun.page);
      data.panelFit = await runPanelFitPhase(httpRun.page);
      const richnessStatus = pixelRich(httpPixel) ? 'PASS' : 'WARN';
      record('B9', 'B', richnessStatus, 'default frame is visually rich (sunset scene, many colors)', { meanBrightness: httpPixel.meanBrightness, stdBrightness: httpPixel.stdBrightness, uniqueColors: httpPixel.uniqueColors, colorfulFraction: httpPixel.colorfulFraction });
      const shotDimensionsOk = data.render.http?.shot?.width === VIEWPORT.width && data.render.http?.shot?.height === VIEWPORT.height;
      record('B10', 'B', shotDimensionsOk ? 'PASS' : 'FAIL', 'default screenshot is exactly 1920x1080', { width: data.render.http?.shot?.width, height: data.render.http?.shot?.height });

      const apiSurface = await httpRun.page.evaluate(() => {
        const hook = window.__bottleOcean;
        const required = ['ready', 'state', 'setParam', 'getDiagnostics', 'setPreset', 'setPaused', 'resetAll', 'captureScreenshot', 'cameraPreset', 'boat', 'environment'];
        const present = hook && typeof hook === 'object' ? Object.keys(hook) : [];
        return { present, missing: required.filter((key) => !(hook && key in hook)), types: required.reduce((out, key) => { out[key] = hook ? typeof hook[key] : 'absent'; return out; }, {}) };
      });
      record('A11', 'A', apiSurface.missing.length === 0 ? 'PASS' : 'WARN', 'window.__bottleOcean exposes the documented API surface', apiSurface);

      // ---------------- interaction suite ----------------
      const baseline = {
        consoleErrors: httpRun.pageLog.consoleErrors.length,
        pageErrors: httpRun.pageLog.pageErrors.length,
        failedRequests: httpRun.pageLog.failedRequests.filter((request) => !request.external).length,
        badResponses: httpRun.pageLog.badResponses.length,
      };
      data.waves = await runWavePhase(httpRun.page, httpUi, {});
      data.directions = await runDirectionPhase(httpRun.page, httpUi, data.waves, {});
      data.camera = await runCameraPhase(httpRun.page, httpUi);
      data.interactions = await runPausePhase(httpRun.page, httpUi);
      data.performance = await runPerformancePhase(httpRun.page, httpUi, httpRun.pageLog);
      data.responsive = await runResponsivePhase(httpRun.page);
      data.offline = await runOfflinePhase(context, fileUrl);

      const newConsoleErrors = httpRun.pageLog.consoleErrors.slice(baseline.consoleErrors);
      const newPageErrors = httpRun.pageLog.pageErrors.slice(baseline.pageErrors);
      const newFailedRequests = httpRun.pageLog.failedRequests.filter((request) => !request.external).slice(baseline.failedRequests);
      const newBadResponses = httpRun.pageLog.badResponses.slice(baseline.badResponses);
      record('A9', 'A', newConsoleErrors.length === 0 && newPageErrors.length === 0 && newFailedRequests.length === 0 && newBadResponses.length === 0 ? 'PASS' : 'FAIL', 'no console/page errors during the full interaction suite', {
        consoleErrors: newConsoleErrors.slice(0, 8),
        pageErrors: newPageErrors.slice(0, 8),
        failedRequests: newFailedRequests.slice(0, 8),
        badResponses: newBadResponses.slice(0, 8),
        remainingConsoleWarnings: [...new Set(httpRun.pageLog.consoleWarnings.map((warning) => warning.text))].slice(0, 8),
      });
    } else {
      record('B9', 'B', 'SKIP', 'visual richness check skipped (http target failed to load)');
      record('B10', 'B', 'SKIP', 'default screenshot check skipped');
      record('A11', 'A', 'SKIP', 'API surface check skipped');
      record('A9', 'A', 'SKIP', 'interaction suite skipped (http target failed to load)');
    }

    // ---------------- aggregate telemetry ----------------
    const logs = [fileRun?.pageLog, httpRun?.pageLog, data.offline?.pageLog].filter(Boolean);
    const internalFailures = logs.flatMap((pageLog) => pageLog.failedRequests.filter((request) => !request.external).map((request) => ({ url: request.url, failure: request.failure })));
    const badResponses = logs.flatMap((pageLog) => pageLog.badResponses.map((response) => ({ url: response.url, status: response.status })));
    const allConsoleErrors = logs.flatMap((pageLog) => pageLog.consoleErrors.map((entry) => ({ text: entry.text, url: entry.url })));
    const allPageErrors = logs.flatMap((pageLog) => pageLog.pageErrors.map((entry) => ({ message: entry.message })));
    const allWarnings = [...new Set(logs.flatMap((pageLog) => pageLog.consoleWarnings.map((entry) => entry.text)))];
    data.errors = { consoleErrors: allConsoleErrors.slice(0, 20), pageErrors: allPageErrors.slice(0, 20), failedRequests: internalFailures.slice(0, 20), badResponses: badResponses.slice(0, 20), externalAttempts: externalAttempts.slice(0, 20), consoleWarnings: allWarnings.slice(0, 30), dialogs: logs.flatMap((pageLog) => pageLog.dialogs).slice(0, 10) };
    record('A5', 'A', internalFailures.length === 0 && badResponses.length === 0 ? 'PASS' : 'FAIL', 'no failed requests or HTTP >=400 responses (file/http/offline)', { failedRequests: internalFailures.slice(0, 10), badResponses: badResponses.slice(0, 10) });
    record('A6', 'A', externalAttempts.length === 0 ? 'PASS' : 'FAIL', 'zero external network requests (fully offline)', { externalAttempts: externalAttempts.slice(0, 10), count: externalAttempts.length });
    record('A12', 'A', 'INFO', 'resource entries loaded by page', { http: (data.loads.http?.resources ?? []).slice(0, 15), file: (data.loads.file?.resources ?? []).slice(0, 15) });

    // dialog safety net
    if (data.errors.dialogs.length) record('A13', 'A', 'WARN', 'unexpected browser dialogs were dismissed', data.errors.dialogs);
  } catch (error) {
    fatalError = String(error?.message ?? error);
    fatalStack = String(error?.stack ?? '');
    log('FATAL: ' + fatalError);
    log(fatalStack.split('\n').slice(0, 8).join('\n'));
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (server) await server.close().catch(() => {});
  }

  if (fatalError) {
    record('Z1', 'Z', 'FAIL', 'harness completed without fatal error', { fatalError, stack: fatalStack.split('\n').slice(0, 6) });
  }
  if (data.meta.artifactBefore) {
    data.meta.artifactAfter = await fileStamp(data.meta.artifactBefore ? ARTIFACT_PATH : ARTIFACT_PATH).catch(() => null);
    if (data.meta.artifactBefore?.sha256 && data.meta.artifactAfter?.sha256) {
      data.meta.artifactStableDuringRun = data.meta.artifactBefore.sha256 === data.meta.artifactAfter.sha256;
    }
  }
  if (data.meta.artifactStableDuringRun === false) {
    record('A14', 'A', 'WARN', 'artifact file was rebuilt while QA was running (evidence may mix builds)', {
      before: data.meta.artifactBefore,
      after: data.meta.artifactAfter,
      note: 'rerun the suite on the frozen artifact for acceptance evidence',
    });
  } else if (data.meta.artifactStableDuringRun === true) {
    record('A14', 'A', 'PASS', 'artifact sha256 unchanged before/after QA run', { sha256: data.meta.artifactBefore.sha256, mtimeIso: data.meta.artifactBefore.mtimeIso, bytes: data.meta.artifactBefore.bytes });
  }
  data.meta.finishedAt = new Date().toISOString();
  data.meta.durationMs = Date.now() - startedAt.getTime();
  const summary = {
    overall: overallVerdict(),
    categories: Object.fromEntries(Object.keys(CATEGORY_TITLES).map((letter) => [letter, categoryVerdict(letter)])),
    counts: {
      total: results.length,
      pass: results.filter((entry) => entry.status === 'PASS').length,
      fail: results.filter((entry) => entry.status === 'FAIL').length,
      warn: results.filter((entry) => entry.status === 'WARN').length,
      skip: results.filter((entry) => entry.status === 'SKIP').length,
      info: results.filter((entry) => entry.status === 'INFO').length,
    },
    fatalError,
    smokeOnly,
  };
  const payload = { meta: { ...data.meta, smokeOnly, mode: smokeOnly ? 'fixture-self-test' : 'full-qa' }, summary, results, data };
  const resultsPath = smokeOnly ? path.join(SHOTS_DIR, 'smoke-results.json') : RESULTS_PATH;
  try {
    await writeFile(resultsPath, JSON.stringify(payload, null, 2), 'utf8');
    log('raw results: ' + path.relative(ROOT, resultsPath));
  } catch (error) {
    log('[warn] could not write results json: ' + String(error?.message ?? error));
  }

  if (!smokeOnly && options.report && !fatalError) {
    try {
      const report = buildReport(data, results);
      await writeFile(REPORT_PATH, report, 'utf8');
      log('report: QA_REPORT.md');
    } catch (error) {
      log('[warn] could not write QA_REPORT.md: ' + String(error?.message ?? error));
    }
  } else if (smokeOnly) {
    log('fixture self-test: QA_REPORT.md intentionally NOT written (not acceptance evidence)');
  }

  logBlank();
  log('=== SUMMARY ===');
  for (const [letter, title] of Object.entries(CATEGORY_TITLES)) {
    const category = categoryVerdict(letter);
    log('  ' + letter + ' ' + title.replace(/^[A-H]\.\s*/, '') + ': ' + category.verdict + ' (' + category.pass + ' pass / ' + category.fail + ' fail / ' + category.warn + ' warn / ' + category.skip + ' skip)');
  }
  log('  overall: ' + summary.overall + ' | ' + summary.counts.total + ' checks, ' + summary.counts.fail + ' FAIL, ' + summary.counts.warn + ' WARN');
  const failed = results.filter((entry) => entry.status === 'FAIL');
  if (failed.length) {
    log('  failures:');
    for (const entry of failed) log('   - [' + entry.id + '] ' + entry.name);
  }
  if (fatalError) log('  fatal error: ' + fatalError);

  const exitCode = fatalError ? 2 : (options.exitZero ? 0 : (smokeOnly ? 0 : (summary.counts.fail > 0 ? 1 : 0)));
  process.exitCode = exitCode;
}

main().catch((error) => {
  console.error('fatal:', error);
  process.exit(2);
});



