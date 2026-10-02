// Local production-build QA; every API request is intercepted with synthetic data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, webkit } = require(process.env.UI_PLAYWRIGHT_PATH || 'playwright');
const { fixture } = require('./audit-ui.cjs');
const origin = process.env.UI_ORIGIN || 'http://127.0.0.1:5262';
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) throw new Error('Only a loopback fixture server is allowed');
const output = process.env.UI_OUTPUT || '/tmp/p2-ticket-images-ui';
const raster = JSON.parse(fs.readFileSync(path.join(__dirname, '../backend/test/fixtures/ticket-images.ts'), 'utf8').split('= ')[1].replace(/;\s*$/, '')).png;
const png = Buffer.from(raster, 'base64');
const ticketId = '588b0a50-ec3d-48e9-9c7d-21dfcdfb4b2e';
const date = '2026-10-02T00:00:00Z';
const cases = [
 ['chromium',1440,'light','user'], ['chromium',1440,'dark','admin'],
 ['chromium',390,'light','user'], ['chromium',390,'dark','admin'], ['chromium',320,'light','user'],
 ['webkit',390,'light','user'], ['webkit',390,'dark','admin'],
];
(async () => {
 fs.mkdirSync(output, { recursive: true }); const results = [];
 for (const engine of (process.env.UI_ENGINES || 'chromium').split(',')) {
  const executablePath = engine === 'chromium' ? process.env.UI_CHROMIUM_PATH : process.env.UI_WEBKIT_PATH;
  const browser = await ({chromium,webkit}[engine]).launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
   for (const [, width, theme, role] of cases.filter(item => item[0] === engine)) {
    const name = `${engine}-${width}-${theme}-${role}`;
    const context = await browser.newContext({ viewport: {width,height:900}, colorScheme: theme, serviceWorkers: 'block' });
    await context.addInitScript(theme => localStorage.setItem('theme',theme), theme);
    const page = await context.newPage(); const errors = []; const uploads = []; const imageReads = []; const ready = new Map(); let creates = 0; let failedUpload = false; let failedRead = false;
    let ticket = { id:ticketId,ownerId:'fixture-user',ownerName:'本地测试提交人',title:'界面上传与紧急度测试',body:'图片及工单说明，应在桌面和手机完整显示。',status:'pending',revision:1,urgency:'urgent',category:'interface',images:[],createdAt:date,updatedAt:date };
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/v1/**', async route => {
     const request = route.request(), url = new URL(request.url()), p = url.pathname, method = request.method();
     const respond = (data, status = 200) => route.fulfill({status,json:{data,requestId:'local-ticket-ui'}});
     const fail = message => route.fulfill({status:503,json:{error:{code:'INTERNAL',message,retryable:true},requestId:'local-ticket-ui'}});
     if (p.endsWith('/auth/session')) return respond({user:{id:'fixture-user',username:'local_fixture',displayName:'本地测试用户',email:null,role,isAdmin:role==='admin'}});
     if (p.endsWith('/notifications/settings')) return respond({inAppEnabled:true,pushEnabled:false});
     if (p.endsWith('/notifications/push/status')) return respond({configured:false,publicKey:''});
     if (p.endsWith('/notifications')) return respond({items:[],unreadCount:0,nextCursor:null});
     if (p.endsWith('/support/tickets') && method === 'POST') { creates++; const input = request.postDataJSON(); assert.equal(input.urgency,'urgent'); assert.equal(input.category,'interface'); ticket={...ticket,...input}; return respond({ticket},201); }
     if (p.endsWith('/support/tickets')) return respond({items:creates ? [ticket] : [],nextCursor:null});
     if (p.includes('/images/')) {
      const id = p.split('/').at(-1);
      if (method === 'PUT') { uploads.push(id); assert.equal(request.headers()['content-type'],'image/png'); assert.deepEqual(request.postDataBuffer(),png); if (!failedUpload) { failedUpload = true; return fail('图片上传暂时失败，请重试'); } ready.set(id,{id,contentType:'image/png',sizeBytes:png.length,createdAt:date}); ticket.images=[...ready.values()]; return respond({image:ready.get(id)}); }
      assert.equal(method,'GET'); imageReads.push(url.search);
      if (!failedRead) { failedRead = true; return fail('图片读取暂时失败'); }
      return route.fulfill({contentType:'image/png',body:png});
     }
     if (p.endsWith('/support/tickets/'+ticketId)) return respond({ticket});
     if (p.endsWith('/support/tickets/'+ticketId+'/messages')) return respond({items:[],nextCursor:null});
     if (p.endsWith('/support/tickets/'+ticketId+'/status')) { assert.equal(role,'admin'); assert.equal(method,'PATCH'); const input=request.postDataJSON(); assert.deepEqual(input,{status:'in_progress',revision:1}); ticket={...ticket,status:'in_progress',revision:2}; return respond({ticket}); }
     assert.equal(method,'GET','All writes must be part of the synthetic ticket flow'); return respond(fixture(p,'filled'));
    });
    function noOverflow(stage) { return page.evaluate(() => ({viewport:innerWidth,page:document.documentElement.scrollWidth,fields:[...document.querySelectorAll('.support-page .input,.support-image')].map(el=>({left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right}))})).then(metrics => { assert(metrics.page<=metrics.viewport+1,`${name} ${stage} page overflow`); for (const box of metrics.fields) assert(box.left>=-1&&box.right<=metrics.viewport+1,`${name} ${stage} field overflow`); return metrics; }); }
    await page.goto(origin+'/app/support'); await page.getByRole('heading',{name:role==='admin'?'全部工单':'我的工单'}).waitFor();
    await page.getByLabel('问题标题').fill(ticket.title); await page.getByLabel('问题描述').fill(ticket.body);
    await page.getByLabel('紧急度').selectOption('urgent'); await page.getByLabel('问题分类').selectOption('interface');
    await page.getByLabel('上传问题图片').setInputFiles([{name:'截图一.png',mimeType:'image/png',buffer:png},{name:'手机与桌面的很长截图文件名称用于换行测试.png',mimeType:'image/png',buffer:png}]);
    const previews = page.locator('.support-image img'); assert.equal(await previews.count(),2); await page.waitForFunction(()=>[...document.querySelectorAll('.support-image img')].every(image=>image.complete&&image.naturalWidth>0));
    await noOverflow('preview'); await page.screenshot({path:path.join(output,name+'-preview.png'),fullPage:true});
    await page.getByRole('button',{name:'提交工单',exact:true}).click(); await page.getByRole('button',{name:'重试未上传图片'}).waitFor();
    assert.equal(creates,1); assert.equal(uploads.length,2); assert.equal(await page.getByText('上传失败',{exact:true}).count(),1); assert.equal(await page.getByText('已上传',{exact:true}).count(),1);
    await noOverflow('partial-failure'); await page.screenshot({path:path.join(output,name+'-failed.png'),fullPage:true});
    await page.getByRole('button',{name:'重试未上传图片'}).click(); await page.getByRole('heading',{name:ticket.title,exact:true}).waitFor();
    assert.equal(creates,1); assert.equal(uploads.length,3); assert.equal(uploads[2],uploads[0]);
    const retry = page.getByRole('button',{name:/重试加载图片/}); await retry.waitFor(); await retry.click();
    await page.waitForFunction(()=>[...document.querySelectorAll('[aria-label="工单图片"] img')].length===2&&[...document.querySelectorAll('[aria-label="工单图片"] img')].every(image=>image.complete&&image.naturalWidth>0));
    assert(imageReads.some(query=>query.includes('retry=1'))); assert.equal(await page.getByText('紧急度：紧急 · 无法继续使用').count(),1); assert.equal(await page.getByText('分类：界面与显示').count(),1);
    if(role==='admin') { await page.getByLabel('工单状态').selectOption('in_progress'); await page.getByRole('button',{name:'保存状态'}).click(); await page.getByText('状态已更新',{exact:true}).waitFor(); }
    else assert.equal(await page.getByLabel('工单状态').count(),0);
    const metrics=await noOverflow('detail'); await page.screenshot({path:path.join(output,name+'-detail.png'),fullPage:true}); assert.deepEqual(errors,[]);
    results.push({name,status:'passed',creates,uploads,readyImages:ready.size,imageReadRetry:true,metrics}); fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2)); await context.close();
   }
  } finally { await browser.close(); }
 }
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2)); console.log(JSON.stringify(results,null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
