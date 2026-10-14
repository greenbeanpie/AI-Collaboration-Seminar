/** Read-only R2/D1 metadata census. Output stays private; SQL is prepared, never applied here. */
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const arg=name=>process.argv[process.argv.indexOf(name)+1];
assert(process.argv.includes('--production'),'Pass --production explicitly');
const output=resolve(arg('--output')||'.local-secrets/resource-audit-20261014');
assert(output.split(/[\\/]/).includes('.local-secrets'),'Metadata census must be written in .local-secrets');
const root=resolve(import.meta.dirname,'..');
const require=createRequire(join(root,'backend/package.json'));
const config=require('wrangler').experimental_readRawConfig({config:join(root,'backend/wrangler.jsonc')}).rawConfig;
const production=config.env.production,account=production.vars.CLOUDFLARE_ACCOUNT_ID,bucket=production.r2_buckets.find(x=>x.binding==='FILES').bucket_name,database=production.d1_databases.find(x=>x.binding==='DB').database_id;
const authPath=process.env.WRANGLER_AUTH_FILE||join(process.env.APPDATA||'', 'xdg.config','.wrangler','config','default.toml');
const auth=await readFile(authPath,'utf8'),token=process.env.CLOUDFLARE_API_TOKEN||auth.match(/(?:oauth_token|api_token)\s*=\s*"([^"\n]+)"/)?.[1];
assert(token,'Wrangler credential unavailable; authenticate normally without printing secrets');
async function api(path,body,jurisdiction){
 const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(jurisdiction?{'cf-r2-jurisdiction':jurisdiction}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(60000)});
 const data=await r.json();assert(r.ok&&data.success,`Cloudflare metadata request failed (${r.status}; codes ${(data.errors||[]).map(e=>e.code).join(',')})`);return data;
}
await mkdir(output,{recursive:true});
const buckets=[{name:bucket,jurisdiction:'default'}];
const summaries=[],objects=[];
for(const b of buckets){
 let cursor,bytes=0,count=0,pages=0;const cursors=new Set();
 do{
  assert(++pages<=100,'Bucket metadata inventory exceeded bounded page limit');
  const page=await api(`/r2/buckets/${encodeURIComponent(b.name)}/objects?per_page=1000${cursor?'&cursor='+encodeURIComponent(cursor):''}`,undefined,b.jurisdiction);
  const rows=Array.isArray(page.result)?page.result:page.result.objects;
  assert(Array.isArray(rows),'Unexpected R2 object metadata shape');
  for(const o of rows){assert(Number.isSafeInteger(o.size)&&o.size>=0,'Invalid metadata byte count');bytes+=o.size;assert(Number.isSafeInteger(bytes),'Aggregate object bytes must be exact');count++;if(b.name===bucket&&b.jurisdiction==='default')objects.push({key:o.key,size:o.size,etag:o.etag,lastModified:o.last_modified});}
  cursor=page.result_info?.is_truncated?page.result_info.cursor:undefined;
  assert(!page.result_info?.is_truncated||(typeof cursor==='string'&&cursor.length>0),'Truncated objects require a cursor');
  if(cursor){assert(!cursors.has(cursor),'Repeated object cursor');cursors.add(cursor);}
 }while(cursor);
 summaries.push({bucket:b.name,jurisdiction:b.jurisdiction,bytes,objects:count});
}
async function query(sql){const r=await api(`/d1/database/${database}/query`,{sql,params:[]});return r.result.flatMap(r=>r.results||[]);}
const pending=await query("SELECT COUNT(*) count FROM file_upload_sessions WHERE status IN('uploading','completing','aborting') UNION ALL SELECT COUNT(*) FROM draft_document_uploads WHERE status IN('uploading','completing','aborting') UNION ALL SELECT COUNT(*) FROM storage_reservations");
assert(pending.length===3&&pending.every(r=>r.count===0),'Current-bucket writes require reconciliation before activating inventory');
const [files,drafts,sources,calls,jobs,bridges,investigations,tickets]=await Promise.all([
 query('SELECT id,r2_key,project_id,uploader_user_id user_id FROM files'),
 query("SELECT id,owner_id user_id,preview_attempt_id,CASE WHEN status='committed' THEN project_id ELSE NULL END project_id FROM project_creation_drafts"),
 query('SELECT v.id,v.project_id,s.created_by user_id FROM source_versions v JOIN sources s ON s.id=v.source_id'),
 query("SELECT c.id,c.project_id,COALESCE(json_extract(j.input_json,'$.requestedBy'),j.created_by,d.owner_id) user_id FROM ai_calls c LEFT JOIN jobs j ON j.id=c.job_id LEFT JOIN project_creation_drafts d ON d.id=c.draft_id"),
 query("SELECT id,project_id,COALESCE(json_extract(input_json,'$.requestedBy'),created_by) user_id FROM jobs"),
 query('SELECT id,project_id,requested_by user_id FROM agent_bridge_handoffs'),
 query('SELECT id,project_id,requested_by user_id FROM ai_investigations'),
 query('SELECT id,owner_id user_id FROM support_tickets'),
]);
const map=rows=>new Map(rows.map(r=>[r.id,r])),fm=map(files),dm=map(drafts),sm=map(sources),cm=map(calls),jm=map(jobs),bm=map(bridges),im=map(investigations),tm=map(tickets);
const attempts=new Map(drafts.filter(d=>d.preview_attempt_id).map(d=>[d.preview_attempt_id,d]));
const quote=v=>v===null||v===undefined?'NULL':"'"+String(v).replaceAll("'","''")+"'";
const now=new Date().toISOString();
const sql=['UPDATE storage_inventory_state SET ready=0 WHERE id=1;'];
for(const o of objects){
 const s=o.key.split('/'),firstFile=(s[1]||'').split('.')[0];let r,category='system';
 if(fm.has(firstFile)){r=fm.get(firstFile);category='upload';}
 else if(s[0]==='creation-drafts'){r=dm.get(s[1]);category='upload';}
 else if(s[0]==='support-images'){r=tm.get(s[1]);category='upload';}
 else if(s[0]==='sources'){r=sm.get(s[1]);category=s[2]==='paste.txt'?'upload':'system';}
 else if(s[0]==='ai-calls')r=cm.get(s[1]);
 else if(s[0]==='agent-bridges')r=bm.get(s[2]);
 else if(s[0]==='ai'&&s[1]==='investigations')r=im.get((s[2]||'').split('.')[0]);
 else if(s[0]==='ai'&&s[1]==='draft-investigations')r=attempts.get((s[2]||'').split('.')[0]);
 if(!r)for(const part of s){r=jm.get(part.split('.')[0]);if(r)break;}
 sql.push(`INSERT INTO storage_objects(object_key,size_bytes,user_id,project_id,category,etag,updated_at) VALUES(${quote(o.key)},${o.size},${quote(r?.user_id)},${quote(r?.project_id)},${quote(category)},${quote(o.etag)},${quote(now)}) ON CONFLICT(object_key) DO UPDATE SET user_id=COALESCE(storage_objects.user_id,excluded.user_id),project_id=COALESCE(storage_objects.project_id,excluded.project_id),category=excluded.category,size_bytes=excluded.size_bytes,etag=excluded.etag,updated_at=excluded.updated_at;`);
}
sql.push(`UPDATE storage_inventory_state SET ready=1,scanning=0,cursor=NULL,external_checked_at=${quote(now)},verification_note='Current application bucket census; unfinished writes reconciled',updated_at=${quote(now)} WHERE id=1;`);
await writeFile(join(output,'storage-inventory.sql'),sql.join('\n')+'\n');
await writeFile(join(output,'storage-inventory.private.json'),JSON.stringify({collectedAt:now,account,database,bucket,summaries,objects},null,2));
console.log(JSON.stringify({collectedAt:now,buckets:summaries,preparedObjects:objects.length,sqlPrepared:true},null,2));
