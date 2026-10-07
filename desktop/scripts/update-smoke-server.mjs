import { createServer } from 'node:http';
import { createUpdateSmokeHandler } from './update-smoke-routes.mjs';
const [installerPath, version = '0.1.1'] = process.argv.slice(2);
if (!installerPath) throw new Error('Usage: node update-smoke-server.mjs SIGNED_INSTALLER.exe [VERSION]');
const handle = createUpdateSmokeHandler({ installerPath, version });
createServer(async (req, res) => { try { if (!await handle(req, res)) { res.writeHead(404); res.end(); } } catch { if (!res.headersSent) res.writeHead(500); res.end(); } }).listen(5173, '127.0.0.1', () => console.log('Update fixture listening on http://127.0.0.1:5173 (update routes only)'));
