import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inventory, generate } from './generate-contracts.mjs';
import { calls, audit } from './check-feature-routes.mjs';

const spec = { paths: { '/api/v1/projects': { parameters: [], get: { tags: ['projects'], responses: { 200: {} } }, post: { tags: ['projects'], responses: { 201: {} } } }, '/api/v1/auth/session': { delete: { tags: ['auth'], responses: { 200: {} } } } } };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buwei-win-contracts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'backend/openapi'), { recursive: true });
  fs.mkdirSync(path.join(root, 'windows-native/App'), { recursive: true });
  fs.writeFileSync(path.join(root, 'backend/openapi/openapi.json'), JSON.stringify(spec));
  return root;
}
test('inventory contains only method operations, grouped by route family', () => {
  const operations = inventory(spec); assert.equal(operations.length, 3);
  assert.equal(operations[0].family, 'auth'); assert.equal(operations[0].method, 'DELETE');
});
test('generated inventories are reproducible and stale content fails check', t => {
  const root = fixture(t); assert.equal(generate(root), 3); assert.equal(generate(root, true), 3);
  const target = path.join(root, 'windows-native/scripts/operation-inventory.json');
  fs.writeFileSync(target, '{}'); assert.throws(() => generate(root, true), /Stale/);
});
test('literal repository calls and write wrapper arguments resolve; dynamic values remain unknown', () => {
  const result = calls('repository.GetAsync("/projects?limit=10", ct); WriteAsync("POST", "/projects", new JsonObject { ["x"] = F(1, 2) }); repository.SendAsync(method, prefix + "/tasks", body);');
  assert.deepEqual(result.map(({ method, path }) => [method, path]), [['GET', '/projects?limit=10'], ['POST', '/projects'], [null, null]]);
});
test('comments and quoted examples do not produce route evidence', () => {
  assert.equal(calls('// repository.GetAsync("/bad");\n/* WriteAsync("POST", "/bad"); */\nvar example = "GetAsync(\\"/bad\\")";').length, 0);
});
test('interpolated paths are unresolved rather than treated as API or UI parity', () => {
  assert.equal(calls('repository.GetAsync($"/projects/{id}", ct)')[0].path, null);
});
test('literal bad method or nonexistent URL fails; dynamic URL remains separately unresolved', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'windows-native/App/Workspace.cs'), 'repository.GetAsync("/projects?limit=10"); WriteAsync("DELETE", "/projects"); repository.GetAsync("/missing"); repository.GetAsync(Base + "/tasks");');
  const result = audit(root); assert.equal(result.checked.length, 1); assert.equal(result.errors.length, 2); assert.equal(result.unresolved.length, 1);
});
test('logout uses actual DELETE session endpoint', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'windows-native/App/Account.cs'), 'repository.SendAsync("DELETE", "/auth/session"); repository.SendAsync("POST", "/auth/logout");');
  const result = audit(root); assert.equal(result.checked.length, 1); assert.equal(result.errors.length, 1);
});
