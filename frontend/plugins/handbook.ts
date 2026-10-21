import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { handbookSection } from '../../shared/handbook.mjs';

/** Bundle only the public help sections; keep the dev server's file access limits intact. */
export function handbookPlugin(): Plugin {
  const source = fileURLToPath(new URL('../../README.md', import.meta.url));
  return {
    name: 'project-handbook',
    resolveId(id) { if (id === 'virtual:project-help') return '\0project-help'; },
    load(id) {
      if (id !== '\0project-help') return;
      this.addWatchFile(source);
      const text = readFileSync(source, 'utf8');
      return [['userGuide', 'user'], ['technicalGuide', 'technical'], ['databaseGuide', 'database']].map(([name, key]) =>
        `export const ${name} = ${JSON.stringify(handbookSection(text, key as 'user' | 'technical' | 'database'))};`).join('\n');
    },
  };
}
