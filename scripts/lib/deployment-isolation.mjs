/** Configuration-only identity checks; never provision or mutate a resource. */
export function deploymentIsolationProblems(backend, frontend, environment) {
  const problems=[];
  const api=backend.env?.[environment],web=frontend.env?.[environment];
  const deployedNames=new Set([...Object.values(backend.env??{}),...Object.values(frontend.env??{})].map(config=>config.name).filter(Boolean));
  if(!backend.name||!frontend.name||backend.name===frontend.name||deployedNames.has(backend.name)||deployedNames.has(frontend.name)) problems.push('默认前后端 Worker 名必须隔离于所有云端环境');
  if(!frontend.services?.some(binding=>binding.binding==='API'&&binding.service===backend.name)) problems.push('默认前端 API 绑定必须指向默认本地后端');
  if(api?.name&&web?.name&&api.name===web.name) problems.push('前后端 Worker 名不能相同');
  for(const [otherName,other] of [['default',backend],...Object.entries(backend.env??{})]) {
    if(otherName===environment)continue;
    if(api?.name&&api.name===other.name)problems.push(`后端 Worker 名与 ${otherName} 重复`);
    const db=api?.d1_databases?.find(binding=>binding.binding==='DB');
    if(db?.database_id&&other.d1_databases?.some(binding=>binding.database_id===db.database_id))problems.push(`D1 database_id 与 ${otherName} 共享`);
    const bucket=api?.r2_buckets?.find(binding=>binding.binding==='FILES');
    if(bucket?.bucket_name&&other.r2_buckets?.some(binding=>binding.bucket_name===bucket.bucket_name))problems.push(`R2 bucket_name 与 ${otherName} 共享`);
  }
  for(const [otherName,other] of Object.entries(frontend.env??{}))if(otherName!==environment&&web?.name&&web.name===other.name)problems.push(`前端 Worker 名与 ${otherName} 重复`);
  return problems;
}
