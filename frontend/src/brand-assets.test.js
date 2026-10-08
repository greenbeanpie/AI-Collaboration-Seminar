import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(join(root, file));

describe('project emblem assets', () => {
  it('keeps a text-free scalable emblem asset', () => {
    const svg = read('public/icon.svg').toString();
    expect(svg).toContain('viewBox="0 0 64 64"');
    expect(svg).not.toMatch(/<text\b|<image\b|<script\b|[\u4e00-\u9fff]/i);
  });

  it('provides correctly sized install PNGs including the maskable icon', () => {
    for (const [file, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['icon-maskable-512.png', 512]]) {
      const png = read(`public/${file}`);
      expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
    }
  });
});
