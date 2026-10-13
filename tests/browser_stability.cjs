// SPDX-License-Identifier: Apache-2.0
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),{spawn,spawnSync}=require('child_process');
function smallPdf(label){
 const stream=`BT /F1 12 Tf 50 750 Td (${label}) Tj ET`,objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
 let data='%PDF-1.4\n',offsets=[0];objects.forEach((obj,i)=>{offsets.push(Buffer.byteLength(data));data+=`${i+1} 0 obj\n${obj}\nendobj\n`;});const start=Buffer.byteLength(data);data+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;return Buffer.from(data);
}
(async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'localtex-stability-')),root=path.join(temp,'project');fs.mkdirSync(root);
 for(const name of ['main','slow','latest','hung','recover','offline','sync'])fs.writeFileSync(path.join(root,name+'.tex'),name+' source\nsecond line\n');
 for(const name of ['one','two','broken','stalled','noinit'])fs.writeFileSync(path.join(root,name+'.pdf'),smallPdf(name));
 const realTools=spawnSync('pdflatex',['--version']).status===0&&spawnSync('synctex',['--version']).status===0;
 if(realTools){fs.mkdirSync(path.join(root,'chapters'));fs.writeFileSync(path.join(root,'chapters','part one.tex'),'Real browser synchronization target.\nSecond target line.\n');fs.writeFileSync(path.join(root,'real.tex'),'\\documentclass{article}\n\\begin{document}\n\\input{chapters/part one.tex}\n\\end{document}\n');const built=spawnSync('pdflatex',['-synctex=1','-interaction=nonstopmode','real.tex'],{cwd:root});assert.equal(built.status,0,built.stdout?.toString());}

 const server=spawn(process.env.PYTHON||'python3',['-u',path.join(__dirname,'../server.py'),root,'--port','0','--no-browser'],{env:{...process.env,LOCALTEX_RECENTS:path.join(temp,'recents.json')}});let browser;
 try{
  const url=await new Promise((resolve,reject)=>{let out='';const timer=setTimeout(()=>reject(Error('startup timeout')),10000);server.stdout.on('data',c=>{out+=c;const m=out.match(/Open: (http:\/\/\S+)/);if(m){clearTimeout(timer);resolve(m[1]);}});server.on('error',reject);});
  browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--no-proxy-server']});
  const page=await browser.newPage({viewport:{width:1500,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
  await page.goto(url);await page.waitForFunction(()=>!document.querySelector('#editor').readOnly);
  await page.locator('#fileFilter').fill('tex');
  let releaseSlow,slowStarted;const started=new Promise(r=>slowStarted=r),gate=new Promise(r=>releaseSlow=r);
  await page.route('**/api/file?**',async route=>{const name=new URL(route.request().url()).searchParams.get('path');if(name==='slow.tex'){slowStarted();await gate;}await route.continue().catch(()=>{});});
  await page.locator('button[data-path="slow.tex"]').click();await started;await page.locator('button[data-path="latest.tex"]').click();
  await page.waitForFunction(()=>document.querySelector('#files').value==='latest.tex'&&!document.querySelector('#editor').readOnly);releaseSlow();await page.unroute('**/api/file?**');assert.equal(await page.locator('#editor').inputValue(),'latest source\nsecond line\n');
  console.log('PASS filtered file clicks: latest intent supersedes a pending response without needing focus changes');
  let releaseList,listStarted,firstList=true;const listStart=new Promise(r=>listStarted=r),listGate=new Promise(r=>releaseList=r);
  await page.route('**/api/files',async route=>{if(firstList){firstList=false;listStarted();await listGate;await route.fulfill({json:{files:['bogus.tex'],directories:[]}}).catch(()=>{});}else await route.continue();});
  await page.locator('#refreshFiles').click();await listStart;const newestList=page.waitForResponse(r=>r.url().endsWith('/api/files'));await page.locator('#refreshFiles').click();await newestList;releaseList();await page.unroute('**/api/files');assert.equal(await page.locator('button[data-path="bogus.tex"]').count(),0);
  console.log('PASS out-of-order file-list refresh cannot replace the newer tree');

  // Shorten only app request/PDF deadlines to exercise failures without real waits.
  await page.evaluate(()=>{window.originalTimeout=window.setTimeout;window.setTimeout=(fn,ms,...args)=>window.originalTimeout(fn,[30000,60000].includes(ms)?500:ms,...args);});
  let releaseHung,hungStarted;const hung=new Promise(r=>hungStarted=r),hungGate=new Promise(r=>releaseHung=r);
  await page.route('**/api/file?**',async route=>{if(new URL(route.request().url()).searchParams.get('path')==='hung.tex'){hungStarted();await hungGate;}await route.continue().catch(()=>{});});
  await page.locator('button[data-path="hung.tex"]').click();await hung;await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('timed out')&&!document.querySelector('#editor').readOnly);
  releaseHung();await page.unroute('**/api/file?**');await page.locator('button[data-path="recover.tex"]').click();await page.waitForFunction(()=>document.querySelector('#files').value==='recover.tex'&&!document.querySelector('#editor').readOnly);
  await page.context().setOffline(true);await page.locator('button[data-path="offline.tex"]').click();await page.waitForFunction(()=>!document.querySelector('#editor').readOnly);await page.context().setOffline(false);
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.locator('button[data-path="offline.tex"]').click();await page.waitForFunction(()=>document.querySelector('#files').value==='offline.tex'&&!document.querySelector('#editor').readOnly);
  assert.equal(await page.locator('#editor').inputValue(),'offline source\nsecond line\n');console.log('PASS stalled/offline requests release editor state and reconnect succeeds');
  await page.locator('#fileFilter').fill('');
  await page.locator('button[data-path="one.pdf"]').click();await page.waitForFunction(()=>document.querySelector('#pdfPath').textContent==='one.pdf'&&document.querySelector('#pageCount').textContent==='/ 1');
  await page.route('**/api/pdf?**',route=>new URL(route.request().url()).searchParams.get('path')==='broken.pdf'?route.fulfill({contentType:'application/pdf',body:'not a PDF'}):route.continue());
  await page.locator('button[data-path="broken.pdf"]').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('Error'));await page.unroute('**/api/pdf?**');
  await page.locator('button[data-path="two.pdf"]').click();await page.waitForFunction(()=>document.querySelector('#pdfPath').textContent==='two.pdf');
  let releasePdf,pdfStarted;const pdfGate=new Promise(r=>releasePdf=r),pdfStart=new Promise(r=>pdfStarted=r);
  await page.route('**/api/pdf?**',async route=>{if(new URL(route.request().url()).searchParams.get('path')==='stalled.pdf'){pdfStarted();await pdfGate;}await route.continue().catch(()=>{});});
  await page.locator('button[data-path="stalled.pdf"]').click();await pdfStart;await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('PDF loading timed out'));releasePdf();await page.unroute('**/api/pdf?**');
  await page.locator('button[data-path="one.pdf"]').click();await page.waitForFunction(()=>document.querySelector('#pdfPath').textContent==='one.pdf');
  await page.evaluate(async()=>{const {EventBus}=await import('/vendor/pdf_viewer.mjs');window.originalDispatch=EventBus.prototype.dispatch;EventBus.prototype.dispatch=function(name,...args){if(window.blockInit&&name==='pagesinit')return;return window.originalDispatch.call(this,name,...args);};window.blockInit=true;});
  await page.locator('button[data-path="noinit.pdf"]').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('PDF initialization timed out'));await page.evaluate(()=>window.blockInit=false);
  await page.locator('button[data-path="two.pdf"]').click();await page.waitForFunction(()=>document.querySelector('#pdfPath').textContent==='two.pdf');console.log('PASS invalid PDF, stalled load and missing pagesinit recover without wedging the viewer');
  const project=new URL(page.url()).searchParams.get('project');let releaseSync,syncStarted,delaySync=false;
  await page.route('**/api/sync/**',async route=>{
   const data=route.request().postDataJSON();if(delaySync){syncStarted();await new Promise(r=>releaseSync=r);}
   const info=await page.request.get(new URL('/api/pdf/state?path='+encodeURIComponent(data.pdf),url).href,{headers:{'X-LocalTeX-Project':project}});const state=await info.json();
   if(data.pdfVersion!==state.version)return route.fulfill({status:409,json:{error:'PDF changed on disk',code:'STALE_PDF'}});
   return route.fulfill({json:route.request().url().endsWith('/forward')?{page:1,x:50,y:50}:{path:'sync.tex',line:2,column:1}});
  });
  await page.locator('#pdfSyncBtn').click();await page.waitForFunction(()=>document.querySelector('#files').value==='sync.tex');
  fs.writeFileSync(path.join(root,'two.pdf'),smallPdf('externally rebuilt PDF'));
  await page.locator('#pdfSyncBtn').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('was refreshed'));await page.locator('#pdfSyncBtn').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('sync.tex · line 2'));
  delaySync=true;const syncStart=new Promise(r=>syncStarted=r);await page.locator('#pdfSyncBtn').click();await syncStart;await page.locator('button[data-path="latest.tex"]').click();await page.waitForFunction(()=>document.querySelector('#files').value==='latest.tex');releaseSync();delaySync=false;
  await page.waitForResponse(r=>r.url().endsWith('/api/sync/reverse'));assert.equal(await page.locator('#files').inputValue(),'latest.tex');
  console.log('PASS reverse sync, stale on-disk PDF refresh and delayed sync cannot override a newer source selection');
  delaySync=true;const switchSync=new Promise(r=>syncStarted=r);await page.locator('#pdfSyncBtn').click();await switchSync;await page.locator('button[data-path="one.pdf"]').click();await page.waitForFunction(()=>document.querySelector('#pdfPath').textContent==='one.pdf');const oldSync=page.waitForResponse(r=>r.url().endsWith('/api/sync/reverse'));releaseSync();delaySync=false;await oldSync;assert.equal(await page.locator('#files').inputValue(),'latest.tex');
  console.log('PASS delayed reverse sync from an old PDF cannot redirect the current view');

  await page.evaluate(()=>{window.setTimeout=window.originalTimeout;});
  for(let i=0;i<12;i++){const name=i%2?'one.pdf':'two.pdf';await page.locator(`button[data-path="${name}"]`).click();await page.waitForFunction(name=>document.querySelector('#pdfPath').textContent===name,name);await page.locator('#fileFilter').fill('tex');const file=i%2?'latest.tex':'recover.tex';await page.locator(`button[data-path="${file}"]`).click();await page.waitForFunction(file=>document.querySelector('#files').value===file&&!document.querySelector('#editor').readOnly,file);await page.locator('#fileFilter').fill('');}
  assert.deepEqual(errors,[]);console.log('PASS repeated filtering/source/PDF cycles after failures; no uncaught page errors');
  if(realTools){
   await page.unroute('**/api/sync/**');await page.locator('button[data-path="real.pdf"]').click();await page.waitForFunction(()=>document.querySelector('#pdfPath').textContent==='real.pdf');
   await page.locator('#expandTree').click();await page.locator('button[data-path="chapters/part one.tex"]').click();await page.waitForFunction(()=>document.querySelector('#files').value==='chapters/part one.tex');
   await page.locator('#editor').evaluate(e=>{e.focus();e.setSelectionRange(5,5);});await page.locator('#sourceSyncBtn').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('Synced to page'));
   const marker=await page.locator('.sync-marker').boundingBox();assert(marker);await page.locator('button[data-path="latest.tex"]').click();await page.waitForFunction(()=>document.querySelector('#files').value==='latest.tex');await page.mouse.dblclick(marker.x+marker.width/2,marker.y+marker.height/2);
   await page.waitForFunction(()=>document.querySelector('#files').value==='chapters/part one.tex'&&document.querySelector('#status').textContent.includes('line'));
   console.log('PASS actual browser PDF.js forward and double-click reverse SyncTeX against a real compiled included file');
  }
  assert.deepEqual(errors,[]);

  const polling=await page.evaluate(async()=>{
   const {installBuildControls}=await import('/build-controls.js');let starts=0,polls=0;const states=[];
   const controls=installBuildControls({setLog:value=>{document.querySelector("#console").textContent=value;},api:async url=>{if(url==='/api/build/start'){starts++;return {id:'mock-job'};}if(url.startsWith('/api/build?')){polls++;if(polls<3)throw Error('temporary offline');return {state:'done',output:'completed',result:{ok:true,target:'main.tex'}};}return {targets:{}};},settingsTarget:()=> 'main.tex',files:()=>[],busy:()=>false,status:s=>states.push(s),action:fn=>fn});
   const result=await controls.build('main.tex');return {result,starts,polls,states,hidden:document.querySelector('#cancelBuild').classList.contains('hidden')};
  });assert(polling.result.ok);assert.equal(polling.starts,1);assert.equal(polling.polls,3);assert(polling.hidden);console.log('PASS build status reconnect retries reads without starting duplicate builds');

 }finally{await browser?.close();server.kill();await new Promise(r=>server.exitCode!==null?r():server.once('exit',r));fs.rmSync(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exit(1);});
