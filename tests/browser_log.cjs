// SPDX-License-Identifier: Apache-2.0
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),{spawn}=require('child_process');
(async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'localtex-log-'));fs.writeFileSync(path.join(temp,'main.tex'),'\\documentclass{article}\n\\begin{document}test\\end{document}');
 const server=spawn(process.env.PYTHON||'python3',['-u',path.join(__dirname,'../server.py'),temp,'--port','0','--no-browser'],{env:{...process.env,LOCALTEX_RECENTS:path.join(temp,'recents.json')}});let browser;
 try{
  const url=await new Promise((resolve,reject)=>{let out='';const timer=setTimeout(()=>reject(Error('startup timeout')),10000);server.stdout.on('data',c=>{out+=c;const m=out.match(/Open: (http:\/\/\S+)/);if(m){clearTimeout(timer);resolve(m[1]);}});server.on('error',reject);});
  browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--no-proxy-server']});
  const page=await browser.newPage({viewport:{width:1500,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
  let output=Array.from({length:300},(_,i)=>i===20?'Needle <script>alert(1)</script>':i===120?'needle [a.*]':i===250?'NEEDLE':'ordinary log line '+i).join('\n'),done=false,starts=0,polls=0;
  await page.route('**/api/build/start',r=>{starts++;return r.fulfill({json:{id:'log-test'}})});
  await page.route('**/api/build?**',r=>{polls++;return r.fulfill({json:{state:done?'done':'running',output,result:done?{ok:false,target:'main.tex',output,log:output,diagnostics:[]}:undefined}})});
  await page.goto(url);await page.waitForFunction(()=>!document.querySelector('#editor').readOnly);
  await page.locator('#editor').focus();await page.keyboard.press('Control+Enter');await page.waitForFunction(()=>document.querySelector('#console').textContent.includes('Needle'));
  await page.locator('#logBtn').click();await page.locator('#console').waitFor();await page.locator('#console').focus();await page.keyboard.press('Control+f');await page.locator('#logFindBar').waitFor();
  assert.equal(await page.locator('#sourceFindBar').isVisible(),false);
  await page.locator('#logQuery').fill('needle');await page.waitForFunction(()=>document.querySelector('#logMatches').textContent==='1 / 3');
  assert.equal(await page.locator('#console mark').count(),3);assert.equal(await page.locator('#console script').count(),0);
  await page.keyboard.press('Enter');assert.equal(await page.locator('#logMatches').textContent(),'2 / 3');assert.equal(await page.evaluate(()=>document.activeElement.id),'logQuery');
  await page.keyboard.press('Shift+Enter');assert.equal(await page.locator('#logMatches').textContent(),'1 / 3');await page.locator('#logPrev').click();assert.equal(await page.locator('#logMatches').textContent(),'3 / 3');await page.locator('#logNext').click();assert.equal(await page.locator('#logMatches').textContent(),'1 / 3');
  const top=await page.locator('#console').evaluate(e=>e.scrollTop);output+='\nnew streamed line';await page.waitForFunction(()=>document.querySelector('#console').textContent.endsWith('new streamed line'));
  assert(Math.abs(await page.locator('#console').evaluate(e=>e.scrollTop)-top)<2,'Streaming must preserve search position');
  await page.locator('#logCase').click();await page.waitForFunction(()=>document.querySelector('#logMatches').textContent==='1 / 1');assert.equal(await page.locator('#console mark.current').textContent(),'needle');
  await page.locator('#logQuery').fill('[a.*]');await page.waitForFunction(()=>document.querySelector('#logMatches').textContent==='1 / 1');assert.equal(await page.locator('#console mark').textContent(),'[a.*]');
  await page.locator('#logQuery').fill('missing');await page.waitForFunction(()=>document.querySelector('#logMatches').textContent==='0 / 0');await page.keyboard.press('Enter');
  await page.locator('#logQuery').fill('');await page.waitForFunction(()=>!document.querySelector('#console mark')); // empty query has no decorations
  await page.locator('#logQuery').fill('needle');await page.waitForFunction(()=>document.querySelector('#logMatches').textContent==='1 / 1');await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement.id),'console');assert.equal(await page.locator('#console mark').count(),0);
  const frame=await page.locator('header').boundingBox();await page.keyboard.press('PageDown');await page.keyboard.press('PageUp');await page.waitForTimeout(100);assert.equal((await page.locator('header').boundingBox()).y,frame.y);assert.equal(await page.evaluate(()=>scrollY),0);
  await page.keyboard.press('Control+f');await page.locator('#logFindBar').waitFor();await page.locator('#showProblems').click();assert.equal(await page.locator('#logFindBar').isVisible(),false);
  await page.locator('#logFindBtn').click();assert.equal(await page.locator('#console').isVisible(),true);
  await page.locator('#logFindClose').click();await page.locator('#console').evaluate(e=>{e.scrollTop=0;e.dispatchEvent(new Event('scroll'));});
  const held=await page.locator('#console').evaluate(e=>e.scrollTop);output+='\nwhile reading';await page.waitForFunction(()=>document.querySelector('#console').textContent.endsWith('while reading'));assert.equal(await page.locator('#console').evaluate(e=>e.scrollTop),held);
  await page.locator('#console').evaluate(e=>{e.scrollTop=e.scrollHeight;e.dispatchEvent(new Event('scroll'));});output+='\nfollowing again';await page.waitForFunction(()=>document.querySelector('#console').textContent.endsWith('following again'));assert(await page.locator('#console').evaluate(e=>e.scrollHeight-e.clientHeight-e.scrollTop<5));await page.locator('#logFindBtn').click();
  console.log('PASS log Ctrl+F, case/literal search, count/cycling, no HTML injection, Escape/focus, native paging and stream position');
  for(const viewport of [{width:800,height:600},{width:400,height:600},{width:320,height:480},{width:1280,height:180}]){
   await page.setViewportSize(viewport);await page.locator('#logQuery').fill('needle');await page.waitForFunction(()=>document.querySelector('#logMatches').textContent==='1 / 1');
   const layout=await page.evaluate(()=>({root:scrollY,width:innerWidth,controls:[...document.querySelectorAll('#logFindBar input,#logFindBar button,#closeConsole,#showProblems,#showRawLog')].map(e=>({left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right}))}));
   assert.equal(layout.root,0);for(const r of layout.controls){assert(r.left>=0&&r.right<=layout.width+1,JSON.stringify({viewport,r}));}
   await page.keyboard.press('Escape');await page.keyboard.press('PageDown');await page.keyboard.press('PageUp');assert.equal(await page.evaluate(()=>scrollY),0);await page.keyboard.press('Control+f');
  }
  await page.setViewportSize({width:1500,height:1000});
  output='x '.repeat(200000)+'\nfinal marker';await page.locator('#logQuery').fill('x');await page.waitForFunction(()=>document.querySelector('#logMatches').textContent.endsWith('/ 200000'));
  assert(await page.locator('#console mark').count()<=1000);await page.locator('#logPrev').click();assert.equal(await page.locator('#logMatches').textContent(),'200000 / 200000');
  await page.locator('#logQuery').fill('x');await page.locator('#logQuery').fill('final marker');await page.waitForFunction(()=>document.querySelector('#logMatches').textContent==='1 / 1');
  assert.equal(await page.locator('#console mark.current').textContent(),'final marker');
  await page.locator('#logQuery').fill('x');await page.keyboard.press('Escape');await page.waitForTimeout(100);assert.equal(await page.locator('#console mark').count(),0);await page.keyboard.press('Control+f');await page.locator('#logQuery').fill('final marker');await page.waitForFunction(()=>document.querySelector('#logMatches').textContent==='1 / 1');
  output+='\nfinal marker';await page.waitForFunction(()=>document.querySelector('#logMatches').textContent==='1 / 2');
  done=true;await page.waitForFunction(()=>document.querySelector('#cancelBuild').classList.contains('hidden'));assert.equal(starts,1);assert(polls>2);assert.equal(await page.locator('#logFindBar').isVisible(),true);
  await page.locator('#closeConsole').click();assert.equal(await page.evaluate(()=>document.activeElement.id),'editor');await page.keyboard.press('Control+f');await page.locator('#sourceFindBar').waitFor();await page.keyboard.press('Escape');
  await page.route('**/api/build/cancel',r=>{done=true;return r.fulfill({json:{ok:true}})});done=false;output='cancel this build';await page.keyboard.press('Control+Enter');await page.waitForFunction(()=>!document.querySelector('#cancelBuild').classList.contains('hidden'));await page.locator('#logBtn').click();await page.locator('#logFindBtn').click();await page.locator('#logQuery').fill('cancel');await page.locator('#cancelBuild').click();await page.waitForFunction(()=>document.querySelector('#cancelBuild').classList.contains('hidden'));assert.equal(starts,2);
  assert.deepEqual(errors,[]);console.log('PASS narrow/short UI, 200,000 matches with bounded DOM, obsolete search cancellation, streamed updates, build completion and keyboard recovery');
 }finally{await browser?.close();server.kill();fs.rmSync(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
