import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handbookSection, helpFiles } from '../../shared/handbook.mjs';

test('help extraction preserves content and excludes maintenance text', () => {
  const source = 'Private maintenance\n<!-- help:user:start -->\n# Help\n正文\n<!-- help:user:end -->\nOther operations';
  assert.equal(handbookSection(source, 'user'), '# Help\n正文\n');
  assert.equal(handbookSection(source.replace(/\n/g, '\r\n'), 'user'), '# Help\n正文\n');
});
test('missing, duplicate, reversed, empty and unknown sections fail explicitly', () => {
  for (const source of ['', '<!-- help:user:start -->\n', '<!-- help:user:end --><!-- help:user:start -->\n', '<!-- help:user:start -->\n<!-- help:user:end -->', '<!-- help:user:start -->\nA\n<!-- help:user:end --><!-- help:user:end -->']) {
    assert.throws(() => handbookSection(source, 'user'));
  }
  assert.throws(() => handbookSection('', 'admin'));
});
test('the single handbook retains all three complete runtime help documents', () => {
  const source = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  for (const key of Object.keys(helpFiles)) assert.match(handbookSection(source, key), /^# /);
  assert.ok((handbookSection(source, 'database').match(/^## `/gm) ?? []).length > 70);
  assert.ok(handbookSection(source, 'technical').includes('projectToolConversation'));
});
