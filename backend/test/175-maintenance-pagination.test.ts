import { expect, it } from 'vitest';
import { env } from './helpers/env';
import { seedProject, seedUser } from './helpers/seed';
import { releaseStaleReservations } from '../src/services/ai-reservations';

const now='2026-10-14T00:00:00.000Z',old='2026-10-01T00:00:00.000Z';
async function insert(project:string,id:string,protectedCall=false){
  await env.DB.batch([
    env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_at,updated_at) VALUES(?1,?2,'agent_run','waiting_input','{}',?3,?3)").bind(id,project,old),
    env.DB.prepare("INSERT INTO usage_reservations(id,project_id,job_id,purpose,status,created_at) VALUES(?1,?2,?1,'agent_run','reserved',?3)").bind(id,project,old),
    ...(protectedCall?[env.DB.prepare("INSERT INTO ai_executions(target_kind,target_id,call_limit,state,inflight_token,created_at,updated_at) VALUES('job',?1,20,'running','live',?2,?2)").bind(id,old)]:[]),
  ]);
}
const released=async(project:string)=> (await env.DB.prepare("SELECT count(*) n FROM usage_reservations WHERE project_id=?1 AND status='released'").bind(project).first<{n:number}>())!.n;
it('limits each sweep to 25 and makes progress past protected calls with tied timestamps',async()=>{
  const project=await seedProject((await seedUser()).userId);
  for(let i=0;i<51;i++)await insert(project,`r${String(i).padStart(3,'0')}`,i<25);
  await releaseStaleReservations(env,now);expect(await released(project)).toBe(0);
  expect(await env.DB.prepare("SELECT cursor_created_at,cursor_id FROM maintenance_cursors WHERE name='idle_reservations'").first()).toEqual({cursor_created_at:old,cursor_id:'r024'});
  await releaseStaleReservations(env,now);expect(await released(project)).toBe(25);
  await releaseStaleReservations(env,now);expect(await released(project)).toBe(26);
  expect(await env.DB.prepare("SELECT cursor_id FROM maintenance_cursors WHERE name='idle_reservations'").first()).toEqual({cursor_id:null});
  await env.DB.prepare("UPDATE ai_executions SET inflight_token=NULL WHERE target_id='r000'").run();
  await releaseStaleReservations(env,now);expect(await released(project)).toBe(27);
});
it('concurrent sweeps preserve fencing and cursor progress',async()=>{
  const project=await seedProject((await seedUser()).userId);
  for(let i=0;i<30;i++)await insert(project,`s${String(i).padStart(3,'0')}`);
  await Promise.all([releaseStaleReservations(env,now),releaseStaleReservations(env,now)]);
  for(let i=0;i<3;i++)await releaseStaleReservations(env,now);
  expect(await released(project)).toBe(30);
  expect(await env.DB.prepare("SELECT count(*) n FROM usage_reservations WHERE project_id=?1 AND status='reserved'").bind(project).first()).toEqual({n:0});
});
