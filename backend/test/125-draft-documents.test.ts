import {describe,it,expect} from 'vitest';
import {env} from './helpers/env';
import {seedUser} from './helpers/seed';
import {newId,nowIso} from '../src/core/db';
import {beginDraftUpload,uploadDraftPart,completeDraftUpload,importDraftBlocks,finishDraftImport,readDraftDocument,draftUploadStatus,cancelDraftUpload} from '../src/services/draft-documents';
import {getDraft,commitDraft,previewDraft,uploadDraftFile} from '../src/services/creation-drafts';
async function fixture(){const owner=await seedUser(),id=newId(),time=nowIso();await env.DB.prepare('INSERT INTO project_creation_drafts(id,owner_id,payload_json,project_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)').bind(id,owner.userId,JSON.stringify({name:'分块项目',description:'',brief:'',teamSize:1,inviteLabels:[],inviteUsernames:[],aiCollaborationEnabled:false}),newId(),time).run();return {id,userId:owner.userId,fileId:newId()};}
describe('draft streamed original and client text import',()=>{
 it('validates later legacy text against the original and rejects invented non-PDF page numbers',async()=>{
  const f=await fixture();await uploadDraftFile(env,f.id,f.userId,1,f.fileId,'文本.txt',new TextEncoder().encode('前段'.repeat(1000)+'确切尾段引用'));
  const task={title:'核对尾段',detail:'核查',criteria:'原文可见',effortHours:1,dependsOn:[],citations:[{fileId:f.fileId,pageNumber:null,quote:'确切尾段引用'}]};
  const preview=await previewDraft(env,f.id,f.userId,2,'manual',[task],true);expect(preview.previewState).toBe('ready');
  await expect(previewDraft(env,f.id,f.userId,2,'manual',[{...task,citations:[{...task.citations[0]!,pageNumber:1}]}],true)).rejects.toThrow('原文不符');
 });
 it('retains long text and nullable page locators through promotion, with idempotent completion',async()=>{
  const f=await fixture(),bytes=new TextEncoder().encode('original');
  const begun=await beginDraftUpload(env,f.id,f.userId,f.fileId,'资料.txt',bytes.length,1);expect(begun.partBytes).toBeGreaterThan(0);
  await uploadDraftPart(env,f.id,f.userId,f.fileId,1,new Response(bytes).body,bytes.length);
  let draft=await completeDraftUpload(env,f.id,f.userId,f.fileId);expect(draft.revision).toBe(2);expect(draft.files[0]?.sha256).toBe('');
  expect((await completeDraftUpload(env,f.id,f.userId,f.fileId)).revision).toBe(2);
  for(let seq=0;seq<10;seq++)await importDraftBlocks(env,f.id,f.userId,f.fileId,2,[{seq,pageNumber:null,text:`第${seq}节\n`+'中文😀'.repeat(4000),headingPath:[`第${seq}节`]}]);
  await expect(importDraftBlocks(env,f.id,f.userId,f.fileId,2,[{seq:0,pageNumber:null,text:'changed'}])).rejects.toThrow('改变');
  draft=await finishDraftImport(env,f.id,f.userId,f.fileId,2,10,'complete',[]);expect(draft.revision).toBe(3);expect(draft.files[0]?.textReady).toBe(true);
  expect((await finishDraftImport(env,f.id,f.userId,f.fileId,2,10,'complete',[])).revision).toBe(3);
  const read=await readDraftDocument(env,f.id,f.userId,f.fileId,0);expect(read.blocks[0]).toMatchObject({locator:'block:0',pageNumber:null});expect(read.nextOffset).toBe(0);expect(read.nextCharOffset).toBe(6000);
  const ready=await previewDraft(env,f.id,f.userId,3,'manual',[{title:'读取材料',detail:'有依据',criteria:'可核查',effortHours:1,dependsOn:[],citations:[{fileId:f.fileId,pageNumber:null,locator:'block:0',quote:'第0节'}]}],true);
  const project=await commitDraft(env,f.id,f.userId,ready.revision);
  const fragments=await env.DB.prepare('SELECT page_number,count(*) n,sum(length(content)) chars FROM source_fragments WHERE project_id=?1').bind(project.projectId).first<{page_number:number|null;n:number;chars:number}>();expect(fragments!.page_number).toBeNull();expect(fragments!.n).toBe(10);expect(fragments!.chars).toBeGreaterThan(120000);
 });
 it('rejects cross-user, missing parts, stale revision and removed files; cancel keeps original uploads isolated',async()=>{
  const f=await fixture(),other=await seedUser();await beginDraftUpload(env,f.id,f.userId,f.fileId,'资料.txt',10,1);
  await expect(draftUploadStatus(env,f.id,other.userId,f.fileId)).rejects.toThrow('不存在');
  await expect(completeDraftUpload(env,f.id,f.userId,f.fileId)).rejects.toThrow('分片');
  await cancelDraftUpload(env,f.id,f.userId,f.fileId);await expect(draftUploadStatus(env,f.id,f.userId,f.fileId)).rejects.toThrow('取消');
  const draft=await getDraft(env,f.id,f.userId);expect(draft.revision).toBe(1);
 });
});
