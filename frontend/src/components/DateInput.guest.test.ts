import { readFileSync } from 'node:fs';
import { runInNewContext, Script } from 'node:vm';
import { afterEach, expect, it } from 'vitest';

const guestScript = readFileSync('public/guest/demo.js', 'utf8');
const html = readFileSync('public/guest/index.html', 'utf8') + '\n' + guestScript;
afterEach(() => { document.body.innerHTML = ''; });

it('guest script remains valid and every date input uses the same renderer', () => {
  expect(() => new Script(guestScript)).not.toThrow();
  expect(readFileSync('public/guest/index.html','utf8')).toContain('src="/guest/demo.js"');
  for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) expect(() => new Script(script)).not.toThrow();
  expect(html.match(/\$\{dateInput\(/g)).toHaveLength(5);
  expect(html).not.toMatch(/<input[^>]*type="(?:date|datetime-local)"/);
});

it('guest helper preserves values/labels and updates empty state after clearing', () => {
  const helper = html.slice(html.indexOf('function dateInput('), html.indexOf("document.addEventListener('input', syncDateInput)"));
  const context = { HTMLInputElement, esc: (s: string) => s.replaceAll('"', '&quot;'), render: '', input: null as HTMLInputElement | null };
  runInNewContext(helper + '; render = dateInput("when", "2026-10-01T09:50", "datetime-local");', context);
  document.body.innerHTML = '<label for="when">决策时间</label>' + context.render;
  const input = document.querySelector('input')!;
  expect(input.type).toBe('datetime-local'); expect(input.value).toBe('2026-10-01T09:50');
  expect(input).toHaveAccessibleName('决策时间');
  expect(input.parentElement).toHaveAttribute('data-empty', 'false');
  input.value = ''; context.input = input;
  runInNewContext(helper + '; syncDateInput({target: input});', context);
  expect(input.parentElement).toHaveAttribute('data-empty', 'true');
  expect(input.nextElementSibling).toHaveAttribute('data-placeholder', '请选择日期');
});

it('guest pointer/cancel stays empty while explicit keyboard editing remains available', () => {
  const start = html.indexOf('function dateEditingMode(');
  const helper = html.slice(start, html.indexOf("document.addEventListener('keydown', dateEditingMode)", start));
  document.body.innerHTML = '<span class="date-input-control" data-empty="true"><input type="date" value=""></span>';
  const input = document.querySelector('input')!;
  const context = { HTMLInputElement, input };
  runInNewContext(helper + '; dateEditingMode({target: input, type: "pointerdown"});', context);
  expect(input.parentElement).toHaveAttribute('data-keyboard-editing', 'false');
  expect(input.value).toBe('');
  runInNewContext(helper + '; dateEditingMode({target: input, type: "keydown", key: "2"});', context);
  expect(input.parentElement).toHaveAttribute('data-keyboard-editing', 'true');
  runInNewContext(helper + '; dateEditingMode({target: input, type: "focusout"});', context);
  expect(input.parentElement).toHaveAttribute('data-keyboard-editing', 'false');
  expect(input.value).toBe('');
});
