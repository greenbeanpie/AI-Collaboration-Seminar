import { describe,it,expect } from 'vitest';
import { env } from './helpers/env';
import { seedProject,seedUser } from './helpers/seed';
import { saveStandard } from '../src/services/project-simplification';
import { createManualAssessment,correctAssessment } from '../src/services/assessment-corrections';

describe('effective standards in manual scoring',()=>{
 it('defaults to the saved standard, rejects expired corrections and keeps the historical report unchanged',async()=>{
  const owner=await seedUser(),projectId=await seedProject(owner.userId);
  const first=await saveStandard(env,projectId,owner.userId,{requirements:[],weights:[{key:'quality',label:'质量',weight:100}]});
  const assessment=await createManualAssessment(env,projectId,owner.userId,{scores:[{key:'quality',score:null}],reason:'检查'});
  const before=await env.DB.prepare('SELECT report_json FROM assessments WHERE id=?1').bind(assessment.assessmentId).first<{report_json:string}>();
  await saveStandard(env,projectId,owner.userId,{requirements:[],weights:[{key:'new',label:'新维度',weight:100}]});
  await expect(createManualAssessment(env,projectId,owner.userId,{standardsVersionId:first.standardsVersionId,scores:[{key:'quality',score:null}],reason:'检查'})).rejects.toThrow('项目标准已更新');
  await expect(correctAssessment(env,projectId,assessment.assessmentId,owner.userId,{expectedRevision:1,scores:[{key:'quality',score:null}],reason:'检查'})).rejects.toThrow();
  expect(await env.DB.prepare('SELECT report_json FROM assessments WHERE id=?1').bind(assessment.assessmentId).first()).toEqual(before);
 });
});
