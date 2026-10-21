export const helpFiles = Object.freeze({ user: 'USER-GUIDE.md', technical: 'TECHNICAL-IMPLEMENTATION.md', database: 'DATABASE-SCHEMA.md' });

/** Extract exactly one bounded document; never expose the rest of the maintenance manual. */
export function handbookSection(source, key) {
  if (!Object.hasOwn(helpFiles, key)) throw new Error(`Unknown help document: ${key}`);
  const text = source.replace(/\r\n/g, '\n');
  const start = `<!-- help:${key}:start -->\n`;
  const end = `<!-- help:${key}:end -->`;
  if (text.split(start).length !== 2 || text.split(end).length !== 2) throw new Error(`Missing or duplicated help boundaries: ${key}`);
  const from = text.indexOf(start) + start.length;
  const to = text.indexOf(end);
  if (to <= from || !text.slice(from, to).trim()) throw new Error(`Invalid help boundaries: ${key}`);
  return text.slice(from, to);
}
