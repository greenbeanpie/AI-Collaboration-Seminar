import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentIsolationProblems } from '../lib/deployment-isolation.mjs';

function fixture(){
  const binding=name=>[{binding:'API',service:name}];
  const resources=name=>({name:`api-${name}`,d1_databases:[{binding:'DB',database_id:`database-${name}`}],r2_buckets:[{binding:'FILES',bucket_name:`bucket-${name}`}]});
  return {backend:{...resources('local'),env:{production:resources('production'),staging:resources('staging')}},frontend:{name:'web-local',services:binding('api-local'),env:{production:{name:'web-production',services:binding('api-production')},staging:{name:'web-staging',services:binding('api-staging')}}}};
}
test('isolates defaults and immutable cloud resources',()=>{
  const {backend,frontend}=fixture();assert.deepEqual(deploymentIsolationProblems(backend,frontend,'production'),[]);
  backend.name='api-production';frontend.name='web-production';frontend.services[0].service='api-staging';
  assert.equal(deploymentIsolationProblems(backend,frontend,'production').length,3);
});
test('rejects shared D1 IDs and R2 names even with different display names',()=>{
  const {backend,frontend}=fixture();
  backend.env.staging.d1_databases[0].database_id=backend.env.production.d1_databases[0].database_id;
  backend.env.staging.r2_buckets[0].bucket_name=backend.env.production.r2_buckets[0].bucket_name;
  assert.deepEqual(deploymentIsolationProblems(backend,frontend,'production'),['D1 database_id 与 staging 共享','R2 bucket_name 与 staging 共享']);
});
