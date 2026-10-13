// SPDX-License-Identifier: Apache-2.0
// Development-only: render the real application with a synthetic project.
const {chromium}=require('playwright'),fs=require('fs'),os=require('os'),path=require('path'),{spawn}=require('child_process');
(async()=>{const base=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'localtex-demo-')),project=path.join(temp,'project');fs.cpSync(path.join(base,'examples/demo'),project,{recursive:true});const server=spawn(process.env.PYTHON||'python3',['-u',path.join(base,'server.py'),project,'--port','0','--no-browser'],{env:{...process.env,LOCALTEX_RECENTS:path.join(temp,'recents.json')}});let browser;try{
 const url=await new Promise((resolve,reject)=>{let out='';const timer=setTimeout(()=>reject(Error('Server startup timeout')),10000);server.stdout.on('data',d=>{out+=d;const m=out.match(/Open: (http:\/\/\S+)/);if(m){clearTimeout(timer);resolve(m[1])}});server.on('error',reject)});
 browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader']});const page=await browser.newPage({viewport:{width:1600,height:980},deviceScaleFactor:1});page.setDefaultTimeout(30000);
 await page.goto(url);await page.waitForFunction(()=>!document.querySelector('#editor').readOnly);await page.locator('#editor').focus();await page.keyboard.press('Control+Enter');
 await page.waitForFunction(()=>document.querySelector('#pageCount').textContent.includes('/ 2')||document.querySelector('#pageCount').textContent.includes('/ 1'),{},{timeout:120000});
 await page.waitForFunction(()=>document.querySelector('#cancelBuild').classList.contains('hidden'));await page.waitForTimeout(1200);
 await page.locator('#pageNumber').fill('1');await page.locator('#pageNumber').press('Enter');await page.locator('#pdf').evaluate(e=>e.scrollTop=0);await page.locator('#editor').evaluate(e=>{e.scrollTop=0;e.setSelectionRange(0,0);});await page.locator('#project').evaluate(e=>e.textContent='Demo project · examples/demo');
 await page.locator('#pdf').evaluate(e=>e.querySelectorAll('.sync-marker').forEach(m=>m.remove()));await page.locator('#editor').focus();
 const output=path.join(base,'docs/images/workspace.png');await page.screenshot({path:output});console.log(output);
}finally{await browser?.close();server.kill();fs.rmSync(temp,{recursive:true,force:true})}})().catch(e=>{console.error(e);process.exitCode=1});
