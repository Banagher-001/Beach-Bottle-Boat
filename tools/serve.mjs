#!/usr/bin/env node
/**
 * tools/serve.mjs -- dependency-free static file server used by the QA harness.
 *
 * Serves the workspace over HTTP so the single-file artifact can be exercised over
 * http://127.0.0.1 as well as file://. Node core only (no packages).
 *
 * CLI:
 *   node tools/serve.mjs [port] [--port 8123] [--root <dir>] [--quiet]
 *
 * Programmatic:
 *   const { url, port, close } = await startServer({ port: 8123, root: process.cwd(), quiet: true });
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 8123;
export const DEFAULT_HOST = '127.0.0.1';

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
});

function contentTypeFor(filePath) {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/** Resolve a URL pathname under root, rejecting traversal outside root. */
function safeResolve(root, pathname) {
  const relative = pathname.replace(/^[/\\]+/, '');
  const candidate = resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
}

function normalizePort(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid port: ${raw}`);
  }
  return port;
}

/**
 * Start the static server.
 * @returns {Promise<{server: import('node:http').Server, host: string, port: number, url: string, root: string, close: () => Promise<void>}>}
 */
export async function startServer(options = {}) {
  const root = resolve(options.root ?? process.cwd());
  const host = options.host ?? DEFAULT_HOST;
  const port = normalizePort(options.port, DEFAULT_PORT);
  const quiet = options.quiet ?? false;
  const sockets = new Set();

  const server = createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    try {
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
        res.end('405 Method Not Allowed');
        return;
      }
      if (!req.url) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('400 Bad Request');
        return;
      }

      let pathname = req.url.split(/[?#]/, 1)[0] || '/';
      try {
        pathname = decodeURIComponent(pathname);
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('400 Bad Request (bad escape)');
        return;
      }

      // Browsers may probe /favicon.ico; answer 204 so QA sees no 404 noise.
      if (pathname === '/favicon.ico') {
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        res.end();
        return;
      }

      if (pathname.endsWith('/')) pathname += 'index.html';

      const filePath = safeResolve(root, pathname);
      if (!filePath) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('403 Forbidden');
        return;
      }

      let info;
      try {
        info = await stat(filePath);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
        return;
      }

      if (!info.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found (not a file)');
        return;
      }

      const body = await readFile(filePath);
      res.writeHead(200, {
        'Content-Type': contentTypeFor(filePath),
        'Content-Length': body.byteLength,
        'Cache-Control': 'no-store, no-cache, max-age=0',
        'X-Content-Type-Options': 'nosniff',
      });
      if (method === 'HEAD') res.end();
      else res.end(body);
    } catch (error) {
      if (!quiet) console.error('[serve] request failed:', req.url, error);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('500 Internal Server Error');
    }
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise((resolveListening, rejectListening) => {
    const onError = (error) => {
      server.off('listening', onListening);
      rejectListening(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolveListening();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  const address = server.address();
  const actualPort = address && typeof address === 'object' ? address.port : port;
  const url = `http://${host}:${actualPort}/`;
  if (!quiet) console.log(`[serve] root=${root} url=${url}`);

  return {
    server,
    host,
    port: actualPort,
    url,
    root,
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolveClosed) => server.close(() => resolveClosed()));
    },
  };
}

function parseCliArgs(argv) {
  const parsed = { port: undefined, root: process.cwd(), quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--quiet') { parsed.quiet = true; continue; }
    if (arg === '--port' || arg === '-p') { parsed.port = argv[++i]; continue; }
    if (arg.startsWith('--port=')) { parsed.port = arg.slice('--port='.length); continue; }
    if (arg === '--root') { parsed.root = argv[++i]; continue; }
    if (arg.startsWith('--root=')) { parsed.root = arg.slice('--root='.length); continue; }
    if (/^\d+$/.test(arg) && parsed.port === undefined) { parsed.port = arg; continue; }
    throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const app = await startServer({ port: normalizePort(args.port, DEFAULT_PORT), root: args.root, quiet: args.quiet });
  console.log(`[serve] serving ${app.root} at ${app.url}`);
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[serve] ${signal} received; shutting down cleanly`);
    try { await app.close(); } catch (error) { console.error('[serve] close error:', error); }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('uncaughtException', (error) => { console.error('[serve] uncaught exception:', error); void shutdown('uncaughtException'); });
  process.on('unhandledRejection', (error) => { console.error('[serve] unhandled rejection:', error); });
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => { console.error('[serve] fatal:', error); process.exit(1); });
}
