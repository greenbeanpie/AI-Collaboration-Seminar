import { SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { newId, nowIso } from '../src/core/db';
import { loadAiConfig } from '../src/ai/config';
import { configureGoFixture } from './helpers/provider-config';

it('exposes only quality metadata and binds source continuation to the authorized current task', async () => {
  await configureGoFixture();
  const config=(await loadAiConfig(env.DB))!, owner=await seedUser(), outsider=await seedUser(), projectId=await seedProject(owner.userId);
  const fileId=newId(),sourceId=newId(),versionId=newId(),jobId=newId(),now=nowIso();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO files(id,project_id,uploader_user_id,r2_key,ext,mime_detected,size_bytes,status,created_at) VALUES(?1,?2,?3,'fixture-audio','.wav','audio/wav',4,'available',?4)").bind(fileId,projectId,owner.userId,now),
    env.DB.prepare("INSERT INTO sources(id,project_id,kind,title,current_version_id,created_by,created_at,updated_at) VALUES(?1,?2,'file','Audio',?3,?4,?5,?5)").bind(sourceId,projectId,versionId,owner.userId,now),
    env.DB.prepare("INSERT INTO source_versions(id,source_id,project_id,revision,origin,file_id,status,created_at) VALUES(?1,?2,?3,1,'file',?4,'pending',?5)").bind(versionId,sourceId,projectId,fileId,now),
    env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_by,created_at,updated_at) VALUES(?1,?2,'parse_source','waiting_input',?3,?4,?5,?5)").bind(jobId,projectId,JSON.stringify({sourceVersionId:versionId,sourceLifecycleVersion:1,configVersionId:config.id,phase:'extract'}),owner.userId,now),
    env.DB.prepare("INSERT INTO media_processing(id,job_id,source_version_id,config_version_id,stage,created_at,updated_at) VALUES(?1,?2,?3,?4,'processing',?5,?5)").bind(newId(),jobId,versionId,config.id,now),
    env.DB.prepare("INSERT INTO audio_pipeline(job_id,phase,transcript_r2_key,quality_json,config_version_id,error,created_at,updated_at) VALUES(?1,'waiting_config',?2,?3,?4,'Waiting Gemini',?5,?5)").bind(jobId,`audio-pipeline/${jobId}/transcript.json`,JSON.stringify([{score:0.5,critical:true,reasons:['Low quality'],anomalies:[]}]),config.id,now),
  ]);
  const path=`${BASE}/api/v1/projects/${projectId}/sources/${sourceId}/versions/${versionId}/processing`;
  const request=(token:string,url=path,body?:unknown)=>SELF.fetch(url,{method:body?'POST':'GET',headers:{cookie:authCookie(token),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const read=await request(owner.token); expect(read.status).toBe(200);
  const text=await read.text(); expect(text).not.toContain('transcript.json');
  expect(JSON.parse(text).data.media).toMatchObject({jobId,audio:{phase:'waiting_config',qualityScore:0.5,transcriptAvailable:true,canResumeFallback:false}});
  expect((await request(outsider.token)).status).toBe(403);
  expect((await request(owner.token,path+'/media-resume',{jobId:newId()})).status).toBe(404);
  expect((await request(owner.token,path+'/media-resume',{jobId})).status).toBe(409);
  expect(await env.DB.prepare('SELECT status FROM jobs WHERE id=?1').bind(jobId).first()).toEqual({status:'waiting_input'});
});
