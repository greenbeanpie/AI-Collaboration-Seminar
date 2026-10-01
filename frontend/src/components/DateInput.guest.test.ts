import { readFileSync } from 'node:fs';
import { runInNewContext, Script } from 'node:vm';
import { afterEach, expect, it } from 'vitest';

const html = readFileSync('public/guest/index.html', 'utf8');
afterEach(() => { document.body.innerHTML = ''; });

it('guest script remains valid and every date input uses the same renderer', () => {
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
