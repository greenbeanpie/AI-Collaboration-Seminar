import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const dateCss = readFileSync('public/date-input.css', 'utf8');
const layoutCss = readFileSync('src/styles/readability.css', 'utf8');
it('constrains the native date control and its wrapper without clipping the picker or focus ring', () => {
  for (const selector of ['.date-input-control', '.date-input-control > input']) {
    const rule = dateCss.slice(dateCss.indexOf(`${selector} {`)).split('}')[0];
    expect(rule).toContain('min-width: 0');
    expect(rule).toContain('width: 100%');
    expect(rule).toContain('max-width: 100%');
    expect(rule).not.toMatch(/overflow:\s*hidden/);
  }
  expect(dateCss).toContain('input::-webkit-datetime-edit { min-width: 0');
  expect(layoutCss).toContain('.field:has(> .date-input-control), .settings-form, .section-card:has(.date-input-control) { grid-template-columns: minmax(0, 1fr); }');
});
it('uses a shrinkable horizontal tab area and a compact mobile navigation with an unclipped actions panel', () => {
  expect(layoutCss).toContain('.topbar-project-navigation { flex: 1 1 0; min-width: 0;');
  expect(layoutCss).toMatch(/\.topbar-project-links \{[^}]*overflow-x: auto/);
  expect(layoutCss).toContain('.topbar-project-select { display: block; min-height: 44px;');
  expect(layoutCss).toContain('.workspace-account-panel[data-open="true"] { display: grid;');
  expect(layoutCss).toContain('width: min(280px, calc(100vw - 34px))');
});
