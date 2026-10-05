import { it,expect,vi } from 'vitest';
import { gatewayChat } from '../src/ai/gateway';
import { aiModelConfigSchema } from '../src/ai/config';
import type { ChatContentPart } from '../src/ai/gateway';
const endpoint={accountId:'test',apiToken:'test',gatewayId:'test'};
const config=aiModelConfigSchema.parse({provider:'workers-ai',model:'vision-test',supportsVision:true,supportsJson:true,timeoutMs:1000,maxInputChars:1000});
const image=(bytes:number):ChatContentPart=>({type:'image_url',image_url:{url:'data:image/png;base64,'+btoa('x'.repeat(bytes))}});
const success=()=>Response.json({choices:[{message:{content:'ok'}}]});
it('sends three realistic 200 KB images without counting base64 against text capacity',async()=>{
 const fetch=vi.fn(async()=>success());
 expect((await gatewayChat(endpoint,{config,messages:[{role:'user',content:[image(200000),image(200000),image(200000),{type:'text',text:'识别当前三页'}]}]},fetch)).content).toBe('ok');expect(fetch).toHaveBeenCalledOnce();
});
it('allows three maximum 2 MiB images within the explicit 9 MiB transport bound',async()=>{
 const fetch=vi.fn(async()=>success());
 await gatewayChat(endpoint,{config,messages:[{role:'user',content:[image(2*1024*1024),image(2*1024*1024),image(2*1024*1024),{type:'text',text:'OCR'}]}]},fetch);expect(fetch).toHaveBeenCalledOnce();
});
it('preserves model text capacity when images are present',async()=>{
 const fetch=vi.fn(async()=>success());
 await expect(gatewayChat(endpoint,{config,messages:[{role:'user',content:[image(200000),{type:'text',text:'文'.repeat(1001)}]}]},fetch)).rejects.toMatchObject({code:'QUOTA_EXCEEDED'});expect(fetch).not.toHaveBeenCalled();
});
it('rejects excessive image size and image count before dispatch',async()=>{
 const fetch=vi.fn(async()=>success());
 for(const content of [[image(2*1024*1024+1)],[image(1),image(1),image(1),image(1)]]) await expect(gatewayChat(endpoint,{config,messages:[{role:'user',content}]},fetch)).rejects.toMatchObject({code:'QUOTA_EXCEEDED'});
 expect(fetch).not.toHaveBeenCalled();
});
it('enforces total UTF8 serialized payload separately from allowed text characters',async()=>{
 const fetch=vi.fn(async()=>success());
 await expect(gatewayChat(endpoint,{config:{...config,maxInputChars:3000000},messages:[{role:'user',content:[image(2*1024*1024),image(2*1024*1024),image(2*1024*1024),{type:'text',text:'文'.repeat(600000)}]}]},fetch)).rejects.toMatchObject({code:'QUOTA_EXCEEDED'});expect(fetch).not.toHaveBeenCalled();
});
