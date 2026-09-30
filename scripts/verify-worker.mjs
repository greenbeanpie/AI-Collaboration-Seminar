import assert from 'node:assert/strict';
import worker from '../frontend/src/worker.ts';

const apiRequest = new Request('https://office.example/api/v1/auth/session', {
  method: 'DELETE', headers: { Cookie: 'ai_office_session=opaque', Origin: 'https://office.example' },
});
const expected = new Response(JSON.stringify({ data: { revoked: true }, requestId: 'verification' }), {
  headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'ai_office_session=; Max-Age=0; HttpOnly; Secure; SameSite=Lax' },
});
let apiCalls = 0;
let assetCalls = 0;
const env = {
  API: { fetch: async request => { assert.equal(request, apiRequest); apiCalls++; return expected; } },
  ASSETS: { fetch: async request => { assetCalls++; return new Response(`asset:${new URL(request.url).pathname}`); } },
};
assert.equal(await worker.fetch(apiRequest, env), expected, 'Session and error responses must be forwarded unchanged');
assert.equal(apiCalls, 1);
assert.equal(assetCalls, 0);
for (const path of ['/', '/guest/index.html', '/projects/example/materials']) {
  const response = await worker.fetch(new Request(`https://office.example${path}`), env);
  assert.equal(await response.text(), `asset:${path}`);
}
const unavailable = new Response('upstream unavailable', { status: 503 });
const failed = await worker.fetch(new Request('https://office.example/api/v1/projects'), {
  ...env, API: { fetch: async () => unavailable },
});
assert.equal(failed.status, 503, 'Real API failures cannot fall back to assets/demo');
const bare = await worker.fetch(new Request('https://office.example/api'), { ...env, API: { fetch: async () => unavailable } });
assert.equal(bare.status, 503);
console.log('PASS: Service Binding forwards request/response, cookies, Origin and errors; guest/SPA assets are separate.');
