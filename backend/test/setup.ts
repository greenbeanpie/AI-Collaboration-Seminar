import { env } from './helpers/env';
import { afterEach, beforeEach } from 'vitest';
import { introspectWorkflow, type WorkflowIntrospector } from 'cloudflare:test';

let workflowIntrospectors: WorkflowIntrospector[] = [];

beforeEach(async () => {
  // These are the actual bindings declared by backend/wrangler.jsonc.
  workflowIntrospectors = await Promise.all([
    env.PARSE_WORKFLOW,
    env.AGENT_WORKFLOW,
  ].map((workflow) => introspectWorkflow(workflow)));
});

afterEach(async () => {
  const activeIntrospectors = workflowIntrospectors;
  workflowIntrospectors = [];
  // Stop introspection and abort unfinished instances created during the test.
  await Promise.all(activeIntrospectors.map(async (introspector) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const instances = await introspector.get();
      // A business terminal state can precede step.do completion. Allow the engine to finish
      // before aborting; keep teardown bounded for intentionally unfinished test workflows.
      // 说明（A13）：负向用例的实例停在 'errored'，仅等待 'complete' 会在超时后被 abort，
      // 从而产生 workerd canceled request / RPC stub 提示。试过并发等待多个终态，反而因
      // 遗留待决 RPC 调用把告警从 5 条放大到 44 条，故保留单一终态等待并如实记录日志。
      await Promise.race([
        Promise.all(instances.map(instance => instance.waitForStatus('complete'))),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      await introspector.dispose();
    }
  }));
});

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
