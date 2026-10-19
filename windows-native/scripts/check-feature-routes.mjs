import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Intentionally conservative: verify complete literal arguments only. Aliases,
// concatenations and interpolations stay unresolved rather than inventing evidence.
export function calls(source) {
  const tokens = source.match(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|\$?"(?:\\.|[^"\\])*"|[A-Za-z_]\w*|[^\s]/g) ?? [];
  const code = tokens.filter(t => !t.startsWith('//') && !t.startsWith('/*'));
  const found = [];
  for (let i = 0; i < code.length; i++) {
    const name = code[i];
    if (!['GetAsync', 'SendAsync', 'WriteAsync'].includes(name) || code[i + 1] !== '(') continue;
    // Definitions are not calls.
    if (i > 0 && ['Task', '>'].includes(code[i - 1])) continue;
    const args = []; let current = []; let depth = 0;
    for (let n = i + 2; n < code.length; n++) {
      const token = code[n];
      if (token === ')' && depth === 0) { args.push(current); break; }
      if (token === ',' && depth === 0) { args.push(current); current = []; continue; }
      if (['(', '[', '{'].includes(token)) depth++;
      if ([')', ']', '}'].includes(token)) depth--;
      current.push(token);
    }
    const literal = tokens => tokens?.length === 1 && /^"/.test(tokens[0]) ? JSON.parse(tokens[0]) : null;
    found.push({ name, method: name === 'GetAsync' ? 'GET' : literal(args[0]), path: literal(args[name === 'GetAsync' ? 0 : 1]) });
  }
  return found;
}
function files(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => ['obj', 'bin'].includes(entry.name) ? [] : entry.isDirectory() ? files(path.join(directory, entry.name)) : entry.name.endsWith('.cs') ? [path.join(directory, entry.name)] : []);
}
export function audit(root) {
  const spec = JSON.parse(fs.readFileSync(path.join(root, 'backend/openapi/openapi.json'), 'utf8'));
  const result = { checked: [], unresolved: [], errors: [], notice: 'Literal method/path verification only; no API count establishes business UI parity.' };
  for (const file of files(path.join(root, 'windows-native/App'))) for (const binding of calls(fs.readFileSync(file, 'utf8'))) {
    const item = { file: path.relative(root, file).replaceAll('\\', '/'), ...binding };
    if (!binding.method || !binding.path) { result.unresolved.push(item); continue; }
    let url = binding.path.split('?')[0]; if (!url.startsWith('/api/v1/')) url = '/api/v1' + url;
    if (!spec.paths[url]?.[binding.method.toLowerCase()]) result.errors.push({ ...item, reason: 'No matching literal API method/path' });
    else result.checked.push(item);
  }
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = process.argv.indexOf('--root');
  const root = argument >= 0 ? path.resolve(process.argv[argument + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const result = audit(root); console.log(JSON.stringify(result, null, 2));
  if (result.errors.length) process.exitCode = 1;
}
