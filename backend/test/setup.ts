import { env } from './helpers/env';

/**
 * 在 worker 运行时内按序应用 migrations/ 下全部 D1 迁移。
 * 测试存储按测试隔离，无需维护 d1_migrations 账本。
 */
const migrations = import.meta.glob('../migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/**
 * 将迁移 SQL 切分为单条语句（处理行注释、块注释与单双引号内的分号）。
 * 迁移文件由仓库控制，不包含存储过程/触发器等复杂结构。
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i] as string;
    const next = sql[i + 1];
    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      current += ch;
      if (ch === '*' && next === '/') {
        current += next as string;
        i++;
        inBlockComment = false;
      }
      continue;
    }
    if (!inSingle && !inDouble && ch === '-' && next === '-') {
      inLineComment = true;
      current += ch;
      continue;
    }
    if (!inSingle && !inDouble && ch === '/' && next === '*') {
      inBlockComment = true;
      current += ch;
      continue;
    }
    if (!inSingle && !inDouble && ch === "'") {
      inSingle = true;
      current += ch;
      continue;
    }
    if (inSingle && ch === "'") {
      if (next === "'") {
        current += ch + (next as string);
        i++;
        continue;
      }
      inSingle = false;
      current += ch;
      continue;
    }
    if (!inSingle && !inDouble && ch === '"') {
      inDouble = true;
      current += ch;
      continue;
    }
    if (inDouble && ch === '"') {
      if (next === '"') {
        current += ch + (next as string);
        i++;
        continue;
      }
      inDouble = false;
      current += ch;
      continue;
    }
    if (ch === ';' && !inSingle && !inDouble) {
      const stmt = current.trim();
      if (stmt) statements.push(stmt);
      current = '';
      continue;
    }
    current += ch;
  }
  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

export async function setup(): Promise<void> {
  const ordered = Object.entries(migrations).sort(([a], [b]) => (a < b ? -1 : 1));
  for (const [file, sql] of ordered) {
    const statements = splitSqlStatements(sql).map((s) => env.DB.prepare(s));
    if (statements.length === 0) continue;
    await env.DB.batch(statements);
    console.debug(`[setup] applied migration ${file} (${statements.length} statements)`);
  }
}

await setup();
