import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const base = new URL('../', import.meta.url);
const migrationsDir = new URL('migrations/', base);

export function splitSqlStatements(sql) {
  const statements = [];
  let current = '', inSingle = false, inDouble = false, inLineComment = false, inBlockComment = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i], next = sql[i + 1];
    if (inLineComment) { current += ch; if (ch === '\n') inLineComment = false; continue; }
    if (inBlockComment) { current += ch; if (ch === '*' && next === '/') { current += next; i++; inBlockComment = false; } continue; }
    if (!inSingle && !inDouble && ch === '-' && next === '-') { inLineComment = true; current += ch; continue; }
    if (!inSingle && !inDouble && ch === '/' && next === '*') { inBlockComment = true; current += ch; continue; }
    if (!inSingle && !inDouble && ch === "'") { inSingle = true; current += ch; continue; }
    if (inSingle && ch === "'") { if (next === "'") { current += ch + next; i++; continue; } inSingle = false; current += ch; continue; }
    if (!inSingle && !inDouble && ch === '"') { inDouble = true; current += ch; continue; }
    if (inDouble && ch === '"') { if (next === '"') { current += ch + next; i++; continue; } inDouble = false; current += ch; continue; }
    if (ch === ';' && !inSingle && !inDouble) {
      const stmt = current.trim();
      const code = stmt.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
      if (/^CREATE\s+TRIGGER\b/i.test(code) && !/\bEND\s*$/i.test(code)) { current += ch; continue; }
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

async function applyMigrations(db, maxNumber = 9999) {
  const files = (await readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    const num = Number(file.slice(0, 4));
    if (num > maxNumber) continue;
    const sql = await readFile(new URL(file, migrationsDir), 'utf8');
    const stmts = splitSqlStatements(sql).map(s => db.prepare(s));
    if (stmts.length) await db.batch(stmts);
  }
}

function flattenResults(res) {
  if (!res) return [];
  if (Array.isArray(res)) return res.flatMap(flattenResults);
  if (res.meta) return [res];
  return [];
}

async function runMeasurement(label, fn) {
  const start = performance.now();
  const res = await fn();
  const records = flattenResults(res);
  return {
    label,
    statements: records.length,
    rows_read: records.reduce((s, r) => s + (r.meta?.rows_read ?? 0), 0),
    rows_written: records.reduce((s, r) => s + (r.meta?.rows_written ?? 0), 0),
    elapsed_ms: Number((performance.now() - start).toFixed(3)),
  };
}

async function benchmarkSuite(maxMigrationNumber, modeLabel) {
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("benchmark"); } }',
    compatibilityDate: '2026-10-05',
    d1Databases: { DB: 'benchmark-' + modeLabel },
  }));
  const db = await runtime.getD1Database('DB');
  const cases = [];
  try {
    await applyMigrations(db, maxMigrationNumber);
    const now = '2026-10-14T12:00:00.000Z';
    const userId = '00000000-0000-4000-8000-000000000001';
    const memberId = '00000000-0000-4000-8000-000000000002';
    await db.batch([
      db.prepare('INSERT INTO users(id,email,display_name,created_at) VALUES(?1,?2,?3,?4)').bind(userId, 'owner@example.com', 'Owner', now),
      db.prepare('INSERT INTO auth_accounts(user_id,username,username_norm,contact_email,contact_email_norm,password_hash,created_at) VALUES(?1,?2,?2,?3,?3,?4,?5)').bind(userId, 'owner', 'owner@example.com', 'hash', now),
      db.prepare('INSERT INTO users(id,email,display_name,created_at) VALUES(?1,?2,?3,?4)').bind(memberId, 'member@example.com', 'Member', now),
      db.prepare('INSERT INTO auth_accounts(user_id,username,username_norm,contact_email,contact_email_norm,password_hash,created_at) VALUES(?1,?2,?2,?3,?3,?4,?5)').bind(memberId, 'member', 'member@example.com', 'hash', now),
      db.prepare('UPDATE storage_inventory_state SET ready=1,updated_at=?1 WHERE id=1').bind(now),
    ]);

    // 1. Task status update & replaceTaskDependencies across 10 / 100 / 500 tasks
    for (const scale of [10, 100, 500]) {
      const scaleHex = String(scale).padStart(4, '0');
      const projectId = `00000000-0000-4000-8${scaleHex.slice(1)}-000000000${scaleHex.slice(1)}`;
      await db.batch([
        db.prepare("INSERT INTO projects(id,name,description,status,revision,created_by,created_at,updated_at) VALUES(?1,'Proj','','active',1,?2,?3,?3)").bind(projectId, userId, now),
        db.prepare("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES(?1,?2,?3,'owner',?4)").bind(`pm-o-${scale}`, projectId, userId, now),
        db.prepare("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES(?1,?2,?3,'member',?4)").bind(`pm-m-${scale}`, projectId, memberId, now),
        db.prepare("INSERT INTO project_goals(project_id,title,detail,revision,graph_revision,created_at,updated_at) VALUES(?1,'Goal','Detail',1,1,?2,?2)").bind(projectId, now),
      ]);
      const taskStmts = [];
      for (let i = 1; i <= scale; i++) {
        const tid = `${projectId.slice(0, 23)}-${String(i).padStart(12, '0')}`;
        taskStmts.push(
          db.prepare("INSERT INTO tasks(id,project_id,title,detail,status,assignee_id,revision,created_by,created_at,updated_at,criteria,effort_hours) VALUES(?1,?2,?3,'','doing',?4,1,?5,?6,?6,'ok',1)").bind(
            tid, projectId, `Task ${i}`, i === 2 ? memberId : userId, userId, now
          )
        );
      }
      for (let i = 0; i < taskStmts.length; i += 100) {
        await db.batch(taskStmts.slice(i, i + 100));
      }
      const t1 = `${projectId.slice(0, 23)}-${String(1).padStart(12, '0')}`;
      const t2 = `${projectId.slice(0, 23)}-${String(2).padStart(12, '0')}`;
      const t3 = `${projectId.slice(0, 23)}-${String(3).padStart(12, '0')}`;
      await db.prepare('INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,created_at) VALUES(?1,?2,?3,?4)').bind(projectId, t2, t1, now).run();

      cases.push(await runMeasurement(`[${modeLabel}] tasks=${scale}: single task UPDATE status='done'`, async () => {
        return await db.prepare("UPDATE tasks SET status='done',revision=revision+1,updated_at=?2 WHERE id=?1").bind(t1, now).run();
      }));

      cases.push(await runMeasurement(`[${modeLabel}] tasks=${scale}: replaceTaskDependencies (graph mutation + readiness)`, async () => {
        const token = `tok-${scale}-${modeLabel}`;
        const readinessSql = maxMigrationNumber >= 78
          ? db.prepare(`UPDATE task_readiness SET ready=(SELECT ready FROM task_readiness_current c WHERE c.task_id=task_readiness.task_id),generation=generation+CASE WHEN ready=0 AND (SELECT ready FROM task_readiness_current c WHERE c.task_id=task_readiness.task_id)=1 THEN 1 ELSE 0 END WHERE task_id=?1`).bind(t3)
          : db.prepare(`UPDATE task_readiness SET ready=(SELECT ready FROM task_readiness_current c WHERE c.task_id=task_readiness.task_id),generation=generation+CASE WHEN ready=0 AND (SELECT ready FROM task_readiness_current c WHERE c.task_id=task_readiness.task_id)=1 THEN 1 ELSE 0 END WHERE task_id IN(SELECT id FROM tasks WHERE project_id=?1)`).bind(projectId);
        return await db.batch([
          db.prepare("UPDATE project_goals SET graph_revision=graph_revision+1,graph_token=?2 WHERE project_id=?1").bind(projectId, token),
          db.prepare("DELETE FROM task_dependencies WHERE project_id=?1 AND task_id=?2").bind(projectId, t3),
          db.prepare("INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,created_at) VALUES(?1,?2,?3,?4)").bind(projectId, t3, t1, now),
          readinessSql,
        ]);
      }));
    }

    // 2. Single R2 object write & multipart upload completion (storage_reservations + storage_objects triggers)
    const storageProjId = '00000000-0000-4000-8100-000000000100';
    cases.push(await runMeasurement(`[${modeLabel}] storage: single R2 put reservation + commit triggers`, async () => {
      const key = `${storageProjId}/bench-put-${modeLabel}.pdf`;
      const r1 = await db.prepare("INSERT INTO storage_reservations(id,object_key,bytes,user_id,project_id,category,kind,status,expires_at,updated_at) VALUES(?1,?2,4096,?3,?4,'upload','put','reserved',?5,?5)").bind(`res-put-${modeLabel}`, key, userId, storageProjId, now).run();
      const r2 = await db.batch([
        db.prepare("INSERT INTO storage_objects(object_key,size_bytes,user_id,project_id,category,etag,updated_at) VALUES(?1,4096,?2,?3,'upload','etag-1',?4)").bind(key, userId, storageProjId, now),
        db.prepare("DELETE FROM storage_reservations WHERE object_key=?1").bind(key),
      ]);
      return [r1, ...r2];
    }));

    cases.push(await runMeasurement(`[${modeLabel}] storage: multipart upload session + part + complete triggers`, async () => {
      const fileId = '00000000-0000-4000-8000-000000000901';
      const sessionId = '00000000-0000-4000-8000-000000000902';
      const key = `${storageProjId}/${fileId}.l1.${sessionId}.pdf`;
      const s0 = await db.prepare("INSERT INTO files(id,project_id,uploader_user_id,original_name,ext,mime_declared,size_bytes,sha256,r2_key,status,created_at) VALUES(?1,?2,?3,'doc.pdf','.pdf','application/pdf',8192,'',?4,'pending',?5)").bind(fileId, storageProjId, userId, key, now).run();
      const s1 = await db.prepare("INSERT INTO storage_reservations(id,object_key,bytes,user_id,project_id,category,kind,status,upload_id,expires_at,updated_at) VALUES(?1,?2,8192,?3,?4,'upload','multipart','reserved','up-1',?5,?5)").bind(`res-mp-${modeLabel}`, key, userId, storageProjId, now).run();
      const s2 = await db.prepare("INSERT INTO file_upload_sessions(id,file_id,project_id,actor_id,lifecycle_version,upload_id,r2_key,size_bytes,part_bytes,created_at,updated_at) VALUES(?1,?2,?3,?4,1,'up-1',?5,8192,8192,?6,?6)").bind(sessionId, fileId, storageProjId, userId, key, now).run();
      const s3 = await db.prepare("INSERT INTO file_upload_parts(session_id,part_number,etag,size_bytes) VALUES(?1,1,'etag-p1',8192)").bind(sessionId).run();
      const s4 = await db.batch([
        db.prepare("INSERT INTO storage_objects(object_key,size_bytes,user_id,project_id,category,etag,updated_at) VALUES(?1,8192,?2,?3,'upload','etag-final',?4)").bind(key, userId, storageProjId, now),
        db.prepare("DELETE FROM storage_reservations WHERE object_key=?1").bind(key),
        db.prepare("UPDATE files SET status='available',mime_detected='application/pdf',size_bytes=8192,r2_key=?2 WHERE id=?1").bind(fileId, key),
        db.prepare("UPDATE file_upload_sessions SET status='complete',updated_at=?2 WHERE id=?1").bind(sessionId, now),
      ]);
      return [s0, s1, s2, s3, ...s4];
    }));

    // 3. collaboration.ts: applyProposal & decideSubmission
    const collabProjId = '00000000-0000-4000-8010-000000000010';
    const propJobId = '00000000-0000-4000-8000-000000000800';
    const propId = '00000000-0000-4000-8000-000000000801';
    const newTaskId = '00000000-0000-4000-8000-000000000802';
    const subId = '00000000-0000-4000-8000-000000000803';
    await db.batch([
      db.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,attempts,created_by,created_at,updated_at) VALUES(?1,?2,'agent_run','succeeded','{}',1,?3,?4,?4)").bind(propJobId, collabProjId, userId, now),
      db.prepare("INSERT INTO collaboration_proposals(id,project_id,job_id,kind,payload_json,settings_revision,status,revision,created_at,updated_at) VALUES(?1,?2,?3,'decompose',?4,1,'pending',1,?5,?5)").bind(
        propId, collabProjId, propJobId, JSON.stringify({ tasks: [{ key: 't1', title: 'New Task', detail: 'Detail', criteria: 'Criteria', effortHours: 2 }] }), now
      ),
    ]);

    cases.push(await runMeasurement(`[${modeLabel}] collaboration: applyProposal (decompose 1 task in 10-task project)`, async () => {
      const nonce = 'nonce-apply-1';
      const readinessStmts = maxMigrationNumber >= 78
        ? [db.prepare("INSERT OR REPLACE INTO task_readiness(task_id,assignee_id,ready,generation) SELECT task_id,assignee_id,ready,COALESCE((SELECT generation FROM task_readiness r WHERE r.task_id=c.task_id),0)+1 FROM task_readiness_current c WHERE project_id=?1 AND task_id=?2").bind(collabProjId, newTaskId)]
        : [
            db.prepare("INSERT OR REPLACE INTO task_readiness(task_id,assignee_id,ready,generation) SELECT task_id,assignee_id,ready,COALESCE((SELECT generation FROM task_readiness r WHERE r.task_id=c.task_id),0)+1 FROM task_readiness_current c WHERE project_id=?1 AND task_id=?2").bind(collabProjId, newTaskId),
            db.prepare("UPDATE task_readiness SET ready=(SELECT ready FROM task_readiness_current c WHERE c.task_id=task_readiness.task_id),generation=generation+CASE WHEN ready=0 AND (SELECT ready FROM task_readiness_current c WHERE c.task_id=task_readiness.task_id)=1 THEN 1 ELSE 0 END WHERE task_id IN(SELECT id FROM tasks WHERE project_id=?1)").bind(collabProjId),
          ];
      return await db.batch([
        db.prepare("UPDATE collaboration_proposals SET status='applied',revision=revision+1,mutation_token=?3,updated_at=?4 WHERE id=?1 AND project_id=?2 AND status='pending' AND revision=1").bind(propId, collabProjId, nonce, now),
        db.prepare("UPDATE project_goals SET graph_revision=graph_revision+1,updated_at=?2 WHERE project_id=?1").bind(collabProjId, now),
        db.prepare("INSERT INTO tasks(id,project_id,title,detail,status,assignee_id,revision,created_by,created_at,updated_at,lifecycle_state,criteria,effort_hours,plan_proposal_id,source_citations_json) VALUES(?1,?2,'New Task','Detail','doing',?3,1,?4,?5,?5,'submitted','Criteria',2,?6,'[]')").bind(newTaskId, collabProjId, memberId, userId, now, propId),
        db.prepare("INSERT INTO events(id,project_id,actor_type,actor_id,type,entity_type,entity_id,dedup_key,payload_json,occurred_at) VALUES(?1,?2,'user',?3,'collaboration.proposal_applied','collaboration',?4,?5,'{}',?6)").bind(`ev-prop-${modeLabel}`, collabProjId, userId, propId, nonce, now),
        ...readinessStmts,
      ]);
    }));

    await db.batch([
      db.prepare("INSERT INTO task_submissions(id,project_id,task_id,round,submitted_by,body,material_versions_json,criteria,task_revision,status,revision,created_at,updated_at) VALUES(?1,?2,?3,1,?4,'work','[]','Criteria',1,'pending',1,?5,?5)").bind(subId, collabProjId, newTaskId, memberId, now),
      db.prepare("UPDATE tasks SET current_submission_id=?2 WHERE id=?1").bind(newTaskId, subId),
    ]);

    cases.push(await runMeasurement(`[${modeLabel}] collaboration: decideSubmission (accept task submission)`, async () => {
      const nonce = 'nonce-decide-1';
      return await db.batch([
        db.prepare("UPDATE task_submissions SET decision='accept',feedback='LGTM',status='accept',mutation_token=?3,revision=revision+1,updated_at=?4 WHERE id=?1 AND project_id=?2 AND revision=1").bind(subId, collabProjId, nonce, now),
        db.prepare("UPDATE tasks SET lifecycle_state='accepted',status='done',revision=revision+1,updated_at=?3 WHERE project_id=?2 AND current_submission_id=?1").bind(subId, collabProjId, now),
        db.prepare("INSERT INTO events(id,project_id,actor_type,actor_id,type,entity_type,entity_id,dedup_key,payload_json,occurred_at) VALUES(?1,?2,'user',?3,'collaboration.submission_decided','submission',?4,?5,'{}',?6)").bind(`ev-sub-${modeLabel}`, collabProjId, userId, subId, nonce, now),
      ]);
    }));

    // 4. project-ai-tools.ts: single-step read_project_file tool execution
    const fileId = '00000000-0000-4000-8000-000000000701';
    const sourceId = '00000000-0000-4000-8000-000000000702';
    const versionId = '00000000-0000-4000-8000-000000000703';
    const fragId = '00000000-0000-4000-8000-000000000704';
    await db.batch([
      db.prepare("INSERT INTO files(id,project_id,uploader_user_id,original_name,ext,mime_declared,size_bytes,sha256,r2_key,status,lifecycle_version,created_at) VALUES(?1,?2,?3,'spec.txt','.txt','text/plain',120,'',?4,'available',1,?5)").bind(fileId, collabProjId, userId, `${collabProjId}/spec.txt`, now),
      db.prepare("INSERT INTO sources(id,project_id,kind,title,current_version_id,lifecycle_version,created_by,created_at,updated_at) VALUES(?1,?2,'file','spec.txt',?3,1,?4,?5,?5)").bind(sourceId, collabProjId, versionId, userId, now),
      db.prepare("INSERT INTO source_versions(id,source_id,project_id,revision,origin,file_id,status,created_at) VALUES(?1,?2,?3,1,'file',?4,'ready',?5)").bind(versionId, sourceId, collabProjId, fileId, now),
      db.prepare("INSERT INTO source_processing(source_version_id,project_id,text_status,summary_status,updated_at) VALUES(?1,?2,'ready','pending',?3)").bind(versionId, collabProjId, now),
      db.prepare("INSERT INTO source_fragments(id,source_version_id,project_id,page_number,seq,kind,content,created_at) VALUES(?1,?2,?3,1,1,'text','Benchmark fragment content for AI tool read.',?4)").bind(fragId, versionId, collabProjId, now),
    ]);

    cases.push(await runMeasurement(`[${modeLabel}] project-ai-tools: read_project_file single step`, async () => {
      const accessCheck = () => db.prepare("SELECT 1 captured_active, 1 job_active FROM projects p JOIN project_members m ON m.project_id=p.id WHERE p.id=?1 AND m.user_id=?2 AND p.status='active'").bind(collabProjId, userId).all();
      const fileLookup = () => db.prepare("SELECT f.id,f.original_name,f.size_bytes,f.lifecycle_version file_lifecycle_version,v.id version_id,s.id source_id,s.lifecycle_version source_lifecycle_version,p.text_status FROM files f LEFT JOIN source_versions v ON v.file_id=f.id AND v.project_id=f.project_id LEFT JOIN sources s ON s.id=v.source_id AND s.project_id=f.project_id LEFT JOIN source_processing p ON p.source_version_id=v.id AND p.project_id=f.project_id WHERE f.id=?1 AND f.project_id=?2 AND f.status='available' AND f.deleted_at IS NULL").bind(fileId, collabProjId).all();
      const sourceLookup = () => db.prepare("SELECT v.id,v.project_id,v.source_id,s.lifecycle_version FROM source_versions v JOIN sources s ON s.id=v.source_id WHERE v.id=?1 AND s.deleted_at IS NULL").bind(versionId).all();
      const fragLookup = () => db.prepare("SELECT id,page_number,substr(content,1,6000) content,0 start,length(content) total FROM source_fragments WHERE source_version_id=?1 AND project_id=?2 LIMIT 40").bind(versionId, collabProjId).all();
      if (maxMigrationNumber >= 78) {
        // After Task 2.3 optimization: single access/snapshot verification inside executeFileTool
        return [await fileLookup(), await sourceLookup(), await fragLookup(), await accessCheck()];
      }
      // Baseline before Task 2.3: initial assertToolAccess + fileLookup + sourceLookup + fragLookup + trailing assertToolAccess
      return [await accessCheck(), await fileLookup(), await sourceLookup(), await fragLookup(), await accessCheck()];
    }));

    return cases;
  } finally {
    await runtime.dispose();
  }
}

const baselineCases = await benchmarkSuite(77, 'baseline_0077');
const optimizedCases = await benchmarkSuite(78, 'optimized_0078');
const comparison = baselineCases.map((baseCase, index) => {
  const opt = optimizedCases[index];
  return {
    metric: baseCase.label.replace(/^\[[^\]]+\]\s*/, ''),
    statementsBefore: baseCase.statements,
    statementsAfter: opt.statements,
    rowsReadBefore: baseCase.rows_read,
    rowsReadAfter: opt.rows_read,
    rowsWrittenBefore: baseCase.rows_written,
    rowsWrittenAfter: opt.rows_written,
  };
});
const report = {
  runtime: 'local Miniflare D1; synthetic data across 10/100/500 tasks, R2 storage triggers, collaboration, and AI tools',
  capturedAt: new Date().toISOString(),
  baseline: baselineCases,
  optimized: optimizedCases,
  comparison,
};

await mkdir(new URL('../docs/verification/', base), { recursive: true });
await writeFile(new URL('../docs/verification/architecture-d1-benchmark.json', base), JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(report, null, 2));
