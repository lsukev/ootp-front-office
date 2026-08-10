import express from 'express';
import type { AddressInfo } from 'node:net';
import { api } from '../server/api.js';

/**
 * Exercises the endpoints through HTTP rather than calling handlers directly,
 * so a test covers the route, the query and the JSON shape the pages actually
 * receive — the layer where every bug in this suite lived.
 */
let base: string | null = null;

async function server(): Promise<string> {
  if (base) return base;
  const app = express();
  app.use(express.json());
  app.use('/api', api);
  const listening = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => listening.once('listening', resolve));
  const { port } = listening.address() as AddressInfo;
  process.env.OOTP_FO_PORT = String(port);
  base = `http://127.0.0.1:${port}`;
  return base;
}

export default async function request(path: string): Promise<any> {
  const res = await fetch(`${await server()}${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}
