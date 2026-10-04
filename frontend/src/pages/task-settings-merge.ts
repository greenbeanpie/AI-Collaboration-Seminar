export function mergeFields<T extends Record<string, unknown>>(base: T, local: T, latest: T): { value: T; conflicts: (keyof T)[] } {
  const value = { ...latest };
  const conflicts: (keyof T)[] = [];
  for (const key of Object.keys(local) as (keyof T)[]) {
    if (JSON.stringify(local[key]) === JSON.stringify(base[key])) continue;
    value[key] = local[key];
    if (JSON.stringify(latest[key]) !== JSON.stringify(base[key]) && JSON.stringify(latest[key]) !== JSON.stringify(local[key])) conflicts.push(key);
  }
  return { value, conflicts };
}
