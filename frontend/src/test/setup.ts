import '@testing-library/jest-dom/vitest';

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(String(key)) ?? null; }
  key(index: number) { return Array.from(this.data.keys())[index] ?? null; }
  removeItem(key: string) { this.data.delete(String(key)); }
  setItem(key: string, value: string) { this.data.set(String(key), String(value)); }
}

Object.defineProperty(window, 'localStorage', { configurable: true, value: new MemoryStorage() });
