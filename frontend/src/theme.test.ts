import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
const source = readFileSync('public/theme.js', 'utf8');
function boot(saved: string | null = null, dark = false, blocked = false) {
  const listeners: Record<string, (event: { detail?: string; key?: string | null; newValue?: string | null }) => void> = {};
  const dataset: Record<string, string> = {};
  const meta = { content: '' };
  let stored = saved;
  let changed = () => {};
  const media = { matches: dark, addEventListener: (_: string, listener: () => void) => { changed = listener; } };
  runInNewContext(source, {
    document: { documentElement: { dataset, style: {} }, querySelector: () => meta },
    window: { matchMedia: () => media, addEventListener: (name: string, fn: typeof listeners[string]) => { listeners[name] = fn; }, dispatchEvent: () => {} },
    Event: class {},
    localStorage: { getItem: () => { if (blocked) throw Error(); return stored; }, setItem: (_: string, value: string) => { if (blocked) throw Error(); stored = value; }, removeItem: () => { if (blocked) throw Error(); stored = null; } },
  });
  return { dataset, meta, stored: () => stored, select: (detail: string) => listeners['office-theme-select']({ detail }), system: (matches: boolean) => { media.matches = matches; changed(); }, storage: (key: string | null, newValue: string | null) => listeners.storage({ key, newValue }) };
}
describe('pre-render theme controller', () => {
  it('uses system on first paint and tracks live changes', () => { const t = boot(null, true); expect(t.dataset.theme).toBe('dark'); t.system(false); expect(t.dataset.theme).toBe('light'); });
  it('persists overrides, ignores system while manual, resumes system', () => { const t = boot(); t.select('dark'); expect(t.stored()).toBe('dark'); t.system(false); expect(t.dataset.theme).toBe('dark'); t.select('system'); expect(t.stored()).toBeNull(); expect(t.dataset.theme).toBe('light'); t.system(true); expect(t.dataset.theme).toBe('dark'); });
  it('restores saved preference before rendering and rejects invalid storage', () => { expect(boot('light', true).dataset.theme).toBe('light'); expect(boot('invalid', true).dataset.themePreference).toBe('system'); });
  it('handles cross-tab changes and storage clear', () => { const t = boot(); t.storage('unrelated', 'dark'); expect(t.dataset.theme).toBe('light'); t.storage('ai-office-theme', 'dark'); expect(t.dataset.theme).toBe('dark'); t.storage(null, null); expect(t.dataset.themePreference).toBe('system'); });
  it('remains usable when storage access throws', () => { const t = boot(null, true, true); t.select('light'); expect(t.dataset.theme).toBe('light'); t.select('system'); t.system(false); expect(t.dataset.theme).toBe('light'); expect(t.meta.content).toBe('#f4f6fa'); });
});

