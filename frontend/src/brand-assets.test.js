import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(join(root, file));

describe('project emblem assets', () => {
  it('uses a text-free scalable emblem consistently in app branding', () => {
    const svg = read('public/icon.svg').toString();
    expect(svg).toContain('viewBox="0 0 64 64"');
    expect(svg).not.toMatch(/<text\b|<image\b|<script\b|[\u4e00-\u9fff]/i);
    const component = read('src/components/BrandMark.tsx').toString();
    expect(component).toContain('src="/icon.svg"');
    expect(component).toContain('alt=""');
    expect(component).toContain('aria-hidden="true"');
    for (const file of ['src/App.tsx', 'src/components/AppShell.tsx', 'src/pages/LoginPage.tsx']) {
      expect(read(file).toString()).not.toMatch(/className="brand-mark">[^<]+</);
    }
  });

  it('provides correctly sized install PNGs and a separate maskable icon', () => {
    for (const [file, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['icon-maskable-512.png', 512]]) {
      const png = read(`public/${file}`);
      expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
      expect(read('vite.config.ts').toString()).toContain(`src: '/${file}'`);
    }
    expect(read('vite.config.ts').toString()).toContain("purpose: 'maskable'");
    const mask = read('public/icon-maskable.svg').toString();
    expect(mask).toContain('<rect width="64" height="64" fill=');
    expect(read('index.html').toString()).toContain('href="/icon-192.png"');
    expect(read('index.html').toString()).toMatch(/rel="icon"[^>]+type="image\/svg\+xml"/);
  });
});
