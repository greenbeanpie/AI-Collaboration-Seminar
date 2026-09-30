const {chromium}=require(process.env.UI_PLAYWRIGHT_PATH||'playwright');
const {fixture,origin}=require('./audit-ui.cjs'); const fs=require('node:fs');const path=require('node:path');
const root=path.resolve(process.argv[2]||'docs/evidence/ui-audit');const results=[];
(async()=>{const browser=await chromium.launch();
for(const width of [1440,390,320]) for(const theme of ['light','dark']) {
 const context=await browser.newContext({viewport:{width,height:900},colorScheme:theme,serviceWorkers:'block'});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/v1/**',r=>r.fulfill(r.request().method()==='GET'?{json:{data:fixture(new URL(r.request().url()).pathname,'filled'),requestId:'fixture'}}:{status:409,json:{error:{code:'FIXTURE_READ_ONLY',message:'本地夹具拒绝保存，原有数据保持不变。',retryable:false},requestId:'fixture'}}));
 async function go(route){await page.goto(origin+route);await page.waitForSelector('.theme-toolbar');await page.waitForTimeout(450)}
 async function capture(name){await page.screenshot({path:path.join(root,`interaction-${width}-${theme}-${name}.png`),fullPage:true});results.push({width,theme,name,overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),errors:[...errors]});}
 await go('/login');await page.getByRole('tab',{name:'注册',exact:true}).click();await capture('register');
 await go('/app/projects/fixture/tasks');await page.locator('.tm-task-open').first().click();await page.getByRole('dialog').waitFor();await capture('task-edit');
 for(let i=0;i<18;i++){await page.keyboard.press('Tab');if(!await page.evaluate(()=>!!document.activeElement.closest('[role="dialog"]')))throw Error('Modal focus escaped');}
 await page.keyboard.press('Escape');if(await page.getByRole('dialog').count())throw Error('Escape did not close dialog');
 await go('/app/settings');await page.getByLabel('原密码',{exact:true}).fill('fixture-current');await page.getByLabel('新密码',{exact:true}).fill('fixture-new-password');await page.getByLabel('确认新密码',{exact:true}).fill('fixture-new-password');await page.getByRole('button',{name:'修改密码',exact:true}).click();await capture('password-confirm');await page.getByRole('button',{name:'取消',exact:true}).click();
 await page.getByLabel('昵称',{exact:true}).fill('本地审查昵称');await page.getByRole('button',{name:'保存昵称'}).click();await page.getByRole('alert').waitFor();await capture('profile-error');
 await page.getByLabel('主题',{exact:true}).selectOption('light');if(await page.locator('html').getAttribute('data-theme')!=='light')throw Error('Light theme failed');await page.getByLabel('主题',{exact:true}).selectOption('dark');if(await page.locator('html').getAttribute('data-theme')!=='dark')throw Error('Dark theme failed');await page.getByLabel('主题',{exact:true}).selectOption('system');if(await page.locator('html').getAttribute('data-theme')!==theme)throw Error('System theme failed');
 await go('/app/projects/fixture/requirements');await page.getByRole('button',{name:/新建评分草稿/}).click();await capture('rubric-editor');
 await go('/app/projects/fixture/sources');for(const tab of await page.locator('.sources-intake-tab').all()){if(await tab.isEnabled())await tab.click();await capture('source-'+await tab.innerText())}
 await go('/app/projects/fixture/materials');await page.locator('.tm-material-list-item').first().click();await page.locator('.tiptap').waitFor();await capture('material-editor');await page.locator('.tm-history-item').first().click();await capture('material-history');
 await go('/app/admin/ai');await page.locator('summary').click();await capture('admin-details');
 await go('/app/projects/fixture/settings');await page.locator('input').first().fill('修改后的本地夹具项目');await capture('project-dirty');
 if(width===1440){await go('/app/projects/fixture/ledger');await page.addStyleTag({content:'html {zoom:2}'});await capture('ledger-200percent');}
 await context.close();
}
await browser.close();fs.writeFileSync(path.join(root,'interaction-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({cases:results.length,failures:results.filter(x=>x.overflow||x.errors.length)},null,2));})().catch(e=>{console.error(e);process.exit(1)});
