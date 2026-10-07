import { createHash } from 'node:crypto';

export function validateMigrations(files, baseline) {
  const problems = [];
  const hash = text => createHash('sha256').update(text).digest('hex');
  for (const [name, digest] of Object.entries(baseline)) {
    if (!files.has(name)) problems.push(`Published migration removed: ${name}`);
    else if (hash(files.get(name)) !== digest) problems.push(`Published migration modified: ${name}`);
  }
  const publishedMax = Math.max(...Object.keys(baseline).map(name => Number(name.split('_')[0])));
  const addedNumbers = new Set();
  for (const name of files.keys()) {
    if (name in baseline) continue;
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name)) { problems.push(`Invalid migration name: ${name}`); continue; }
    const number = Number(name.split('_')[0]);
    if (number <= publishedMax) problems.push(`New migration must be after ${publishedMax}: ${name}`);
    if (addedNumbers.has(number)) problems.push(`Duplicate new migration number: ${number}`);
    addedNumbers.add(number);
  }
  return problems;
}
