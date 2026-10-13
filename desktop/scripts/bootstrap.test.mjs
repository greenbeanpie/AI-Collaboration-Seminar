import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../static/bootstrap.js', import.meta.url), 'utf8');
function page({ recovery = false, invoke = async () => {}, online = false } = {}) {
  const elements = Object.fromEntries(['status', 'detail', 'retry'].map(id => [id, { listeners: {}, addEventListener(name, handler) { this.listeners[name] = handler; } }]));
  const timers = [], events = {}, calls = [];
  const window = { __TAURI_INTERNALS__: { invoke: async command => { calls.push(command); return invoke(command); } }, addEventListener: (name, handler) => { events[name] = handler; } };
  vm.runInNewContext(source, { document: { getElementById: id => elements[id] }, window, location: { search: recovery ? '?recovery=1' : '' }, navigator: { onLine: online }, URLSearchParams, setTimeout: callback => timers.push(callback) });
  return { elements, events, calls, timers };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('first offline launch tries existing origin cache without a network preflight', async () => {
  const current = page();
  assert.equal(current.timers.length, 1);
  current.timers[0]();
  await settle();
  assert.deepEqual(current.calls, ['desktop_open_app']);
  assert.equal(current.elements.retry.disabled, true);
});
test('recovery never loops automatically; manual retry and restored connectivity open app', async () => {
  const current = page({ recovery: true });
  assert.equal(current.timers.length, 0);
  assert.equal(current.elements.retry.disabled, false);
  assert.match(current.elements.detail.textContent, /草稿和附件仍保留/);
  current.elements.retry.listeners.click();
  current.events.online();
  await settle();
  assert.deepEqual(current.calls, ['desktop_open_app']);
  const restored = page({ recovery: true });
  restored.events.online();
  await settle();
  assert.deepEqual(restored.calls, ['desktop_open_app']);
});
test('failed native navigation exposes retry instead of leaving a loading dead end', async () => {
  const current = page({ invoke: async () => { throw new Error('not available'); } });
  current.timers[0]();
  await settle();
  assert.equal(current.elements.retry.disabled, false);
  assert.match(current.elements.detail.textContent, /不会清除/);
  current.elements.retry.listeners.click();
  await settle();
  assert.equal(current.calls.length, 2);
});
