import { getJob } from '../services/jobs';
import { isMediaExtension } from '../services/files';
import { runMediaJob } from '../services/media-summary';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../env';
import { runParseJob } from '../services/parse';

/**
 * 来源解析 Workflow（PLAN 二.4/二.7）。
 * 实例 ID = jobId（确定性）；步骤失败按配置重试，状态机由 services/parse.ts 维护。
 */
export class ParseSourceWorkflow extends WorkflowEntrypoint<Env, { jobId: string }> {
  async run(event: WorkflowEvent<{ jobId: string }>, step: WorkflowStep): Promise<void> {
    const job=await getJob(this.env,event.payload.jobId),input=JSON.parse(job.input_json) as {sourceVersionId?:string;phase?:string};
    const file=input.sourceVersionId?await this.env.DB.prepare('SELECT f.ext FROM source_versions v JOIN files f ON f.id=v.file_id WHERE v.id=?1').bind(input.sourceVersionId).first<{ext:string}>():null;
    if(file&&isMediaExtension(file.ext)&&input.phase==='extract'){for(let window=0;window<240;window++){const result=await step.do('media-window-'+window,{retries:{limit:0,delay:'5 seconds'},timeout:'15 minutes'},()=>runMediaJob(this.env,event.payload.jobId,input.sourceVersionId,1));if(result.status==='busy'){await step.sleep('media-wait-'+window,'15 seconds');continue;}if(result.status!=='running')return;}return;}
    await step.do(
      'parse-source',
      { retries: { limit: 2, delay: '5 seconds' } },
      async () => runParseJob(this.env, event.payload.jobId),
    );
  }
}
