import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { api, runImport } from './api.js';
import { buildIndexes } from './importer.js';
import { APP_ROOT, loadConfig } from './config.js';
import { startWatcher } from './watcher.js';
import { tableExists } from './db.js';
import { snapshotDates, takeSnapshot } from './history.js';
import { loadSettings } from './settings.js';

/**
 * Rejects requests whose Host header is not a loopback name.
 *
 * The server binds to 127.0.0.1, which stops other machines reaching it but
 * not the browser already running on this one. A page on the open web can
 * point a hostname it controls at 127.0.0.1 (DNS rebinding) and then have the
 * visitor's browser talk to this server — same-origin as far as the browser is
 * concerned, because the hostname matches. That would hand a stranger's page
 * the whole save and, worse, the ability to spend the user's API credits
 * through /api/chat.
 *
 * The defence is the Host header: a rebound request carries the attacker's
 * hostname, never `localhost` or a loopback IP. Only the hostname is checked,
 * not the port, so the Vite dev proxy (which forwards the original
 * `localhost:5173`) keeps working.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

/** Where to listen. Loopback unless the user deliberately opens it up. */
export const BIND_ADDRESS = process.env.OOTP_FO_BIND?.trim() || '127.0.0.1';
// Note 0.0.0.0 is a valid Host header but is NOT a loopback bind — it means
// every interface, which is exactly the case that opens the server up.
const LOOPBACK_BINDS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const OPEN_TO_NETWORK = !LOOPBACK_BINDS.has(BIND_ADDRESS.toLowerCase());

/**
 * Host names this server will answer to.
 *
 * Serving the network does NOT mean answering to any Host. The rebinding attack
 * works by pointing a hostname the attacker owns at this machine's address, and
 * that hostname is never one of this machine's own — so the allowlist is built
 * from the real interface addresses rather than abandoned. A name that is not
 * on the list still gets a 403 even with the server bound to every interface.
 */
function allowedHosts(): Set<string> {
  const allowed = new Set(LOOPBACK_HOSTS);
  if (OPEN_TO_NETWORK) {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs ?? []) {
        allowed.add(a.family === 'IPv6' ? `[${a.address}]` : a.address);
        allowed.add(a.address);
      }
    }
    allowed.add(os.hostname().toLowerCase());
    // Bonjour name, which is how a Mac is usually reached on a home network
    allowed.add(`${os.hostname().replace(/\.local$/i, '').toLowerCase()}.local`);
  }
  for (const extra of (process.env.OOTP_FO_ALLOWED_HOSTS ?? '').split(',')) {
    const name = extra.trim().toLowerCase();
    if (name) allowed.add(name);
  }
  return allowed;
}
const ALLOWED_HOSTS = allowedHosts();

function requireLocalHost(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const host = req.headers.host ?? '';
  // Strip the port; an IPv6 literal keeps its brackets
  const name = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : host.split(':')[0];
  if (ALLOWED_HOSTS.has(name.toLowerCase())) return next();
  res
    .status(403)
    .type('text/plain')
    .send(
      OPEN_TO_NETWORK
        ? `This server does not answer to the name "${name}". Add it to OOTP_FO_ALLOWED_HOSTS if it is yours.`
        : 'This server only answers requests addressed to localhost.'
    );
}

/** Import on boot if needed, then watch for fresh OOTP exports. */
function bootstrapData(): void {
  const config = loadConfig();
  if (!config.csvDir || !fs.existsSync(config.csvDir)) return;
  if (!tableExists('players')) runImport(config.csvDir);
  // Indexes used to be built only by the importer, so upgrading the app left
  // every existing database without them — the same full table scans as before,
  // and an export that took twenty-five minutes with the UI wedged behind it.
  // Creating them is idempotent and only costs anything the first time.
  buildIndexes();
  if (loadSettings().autoImport) startWatcher(config.csvDir);
  try {
    // Ensure development tracking has a baseline for already-imported data
    if (tableExists('players') && snapshotDates().length === 0) takeSnapshot();
  } catch (err) {
    console.error('[history] baseline snapshot failed:', err);
  }
}

/**
 * Starts the API (and, when built, the frontend) and resolves with the port.
 * Pass port 0 to let the OS pick a free one — the desktop app does this so it
 * never collides with another copy or an unrelated service.
 */
export function startServer(port = 5178): Promise<number> {
  const app = express();
  app.use(requireLocalHost);
  app.use(express.json());
  app.use('/api', api);

  const dist = path.join(APP_ROOT, 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  return new Promise((resolve, reject) => {
    const server = app.listen(port, BIND_ADDRESS);
    server.once('error', reject);
    server.once('listening', () => {
      const actual = (server.address() as AddressInfo).port;
      // The chat tools read the app's own endpoints so the assistant sees
      // exactly what the UI shows, rather than a second implementation.
      process.env.OOTP_FO_PORT = String(actual);
      console.log(`[server] http://localhost:${actual}`);
      if (OPEN_TO_NETWORK) {
        const lan = Object.values(os.networkInterfaces())
          .flatMap((addrs) => addrs ?? [])
          .filter((a) => a.family === 'IPv4' && !a.internal)
          .map((a) => `http://${a.address}:${actual}`);
        console.warn(
          `[server] listening on ${BIND_ADDRESS} — reachable from your network at ${lan.join(', ') || 'this machine'}`
        );
        console.warn(
          '[server] THERE IS NO PASSWORD. Anyone who can reach this address can read the whole ' +
            'save, change settings, and spend your Anthropic credits through the assistant. ' +
            'Only do this on a network you trust, and never forward the port from a router.'
        );
      }
      bootstrapData();
      resolve(actual);
    });
  });
}

// Running directly (npm run dev / npm start) rather than embedded in Electron
if (!process.env.OOTP_FO_EMBEDDED) {
  startServer(Number(process.env.PORT) || 5178).catch((err) => {
    console.error('[server] failed to start:', err);
    process.exit(1);
  });
}
