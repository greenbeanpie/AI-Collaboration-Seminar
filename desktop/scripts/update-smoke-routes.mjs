import { createReadStream, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { pipeline } from 'node:stream/promises';

// Mount before the existing fixture's other routes. It serves exactly one configured artifact.
export function createUpdateSmokeHandler({ installerPath, version = '0.1.1', signaturePath = `${installerPath}.sig` }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid smoke update version');
  const assetPath = `/updates/${encodeURIComponent(basename(installerPath))}`;
  const signature = readFileSync(signaturePath, 'utf8').trim();
  const bytes = statSync(installerPath).size;
  if (!signature || !installerPath.endsWith('.exe')) throw new Error('Signed NSIS installer required');
  return async (req, res) => {
    const requestPath = new URL(req.url, 'http://127.0.0.1:5173').pathname;
    if (requestPath !== '/latest.json' && requestPath !== assetPath) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return true; }
    if (requestPath === '/latest.json') {
      const platform = { signature, url: `http://127.0.0.1:5173${assetPath}` };
      const body = JSON.stringify({ version, notes: 'Local signed updater acceptance fixture', pub_date: new Date().toISOString(), platforms: { 'windows-x86_64': platform, 'windows-x86_64-nsis': platform } });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
      res.end(req.method === 'HEAD' ? undefined : body); return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes, 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') res.end(); else await pipeline(createReadStream(installerPath), res);
    return true;
  };
}
