// SPDX-License-Identifier: Apache-2.0
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),{spawn}=require('child_process');
(async()=>{const temp=fs.mkdtempSync(path.join(os.tmpdir(),'lt-storage-'));fs.writeFileSync(path.join(temp,'main.tex'),'original source');const server=spawn(process.env.PYTHON||'python3',['-u',path.join(__dirname,'../server.py'),temp,'--port','0','--no-browser'],{env:{...process.env,LOCALTEX_RECENTS:path.join(temp,'recent.json')}});let browser;try{
 const url=await new Promise((resolve,reject)=>{let out='';server.stdout.on('data',d=>{out+=d;const m=out.match(/Open: (http:\/\/\S+)/);if(m)resolve(m[1])});server.on('error',reject)});
 browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader']});
 for(const mode of ['session','local','both','quota','uuid']){
  const context=await browser.newContext();await context.addInitScript(mode=>{
   if(mode==='uuid')Object.defineProperty(crypto,'randomUUID',{value:undefined});
   else if(mode==='quota')Storage.prototype.setItem=function(){throw new DOMException('Storage full','QuotaExceededError')};
   else for(const name of ['sessionStorage','localStorage'])if(mode==='both'||name.startsWith(mode))Object.defineProperty(window,name,{get(){throw new DOMException('Storage disabled','SecurityError')}});
  },mode);
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);await page.goto(url);await page.waitForFunction(()=>!document.querySelector('#editor').readOnly);
  if(mode!=='uuid')assert(await page.locator('#storageNotice').isVisible());
  const text='saved with '+mode;await page.locator('#editor').fill(text);await page.keyboard.press('Control+s');await page.waitForFunction(()=>document.querySelector('#saveStatus').textContent.includes('Saved'));
  assert.equal(fs.readFileSync(path.join(temp,'main.tex'),'utf8'),text);
  await page.locator('#newEditorView').click();assert.equal(await page.locator('#editorTabs [role=tab]').count(),2);await page.reload();await page.waitForFunction(()=>!document.querySelector('#editor').readOnly);
  assert.equal(await page.locator('#editor').inputValue(),text);
  if(['local','both','quota'].includes(mode)){
   await page.locator('#editor').fill('preserve this unsaved draft');await page.locator('#historyBtn').click();await page.locator('.history-entry').first().click();await page.waitForFunction(()=>!document.querySelector('#restoreDraft').disabled);
   await page.locator('#restoreDraft').click();await page.waitForFunction(()=>document.querySelector('#console').textContent.includes('browser backup is unavailable'));
   assert.equal(await page.locator('#editor').inputValue(),'preserve this unsaved draft');await page.locator('#historyClose').click();
  }
  assert.deepEqual(errors,[]);await context.close();console.log('PASS editing/save/reload/views with '+mode+' unavailable; protected unsaved draft recovery');
 }
}finally{await browser?.close();server.kill();fs.rmSync(temp,{recursive:true,force:true})}})().catch(e=>{console.error(e);process.exitCode=1});
