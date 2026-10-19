import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const spec=JSON.parse(fs.readFileSync(path.join(root,'backend/openapi/openapi.json'),'utf8'));
const features=path.join(root,'android-native/app/src/main/java/cn/buwei/nativeapp/features');
let checks=0;
for(const name of fs.readdirSync(features).filter(n=>n.endsWith('.kt')&&!n.startsWith('Generated'))){
 const source=fs.readFileSync(path.join(features,name),'utf8');
 for(const match of source.matchAll(/(?:action|operation)\("(GET|POST|PUT|PATCH|DELETE)","([^"]+)"/g)){
  const route=match[2].replaceAll('$projectPrefix','/api/v1/projects/{projectId}');
  assert.ok(spec.paths[route]?.[match[1].toLowerCase()],`${name}: missing ${match[1]} ${route}`);checks++;
 }
 for(const match of source.matchAll(/it\.method=="(GET|POST|PUT|PATCH|DELETE)"&&it\.path=="([^"]+)"/g)){
  assert.ok(spec.paths[match[2]]?.[match[1].toLowerCase()],`${name}: invalid contract lookup ${match[1]} ${match[2]}`);checks++;
 }
}
assert.ok(checks>10,'Route scan did not find expected business bindings');
console.log(`${checks} hardcoded feature action/contract routes match server OpenAPI`);
