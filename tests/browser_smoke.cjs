// SPDX-License-Identifier: Apache-2.0
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),{spawn,execFileSync}=require('child_process');
(async()=>{
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'localtex-browser-')),root=path.join(temp,'project');fs.mkdirSync(root);fs.mkdirSync(path.join(root,'nested/deep'),{recursive:true});fs.writeFileSync(path.join(root,'main.tex'),'\\documentclass{article}\n\\begin{document}Test\\end{document}');
const server=spawn(process.env.PYTHON||'python3',['-u',path.join(__dirname,'../server.py'),root,'--port','0','--no-browser','--workspace',path.join(temp,'imports')],{env:{...process.env,DISPLAY:'',WAYLAND_DISPLAY:'',LOCALTEX_RECENTS:path.join(temp,'recents.json')}});let browser;
try{
const url=await new Promise((resolve,reject)=>{let out='';const timer=setTimeout(()=>reject(Error('Server startup timed out')),10000);server.stdout.on('data',chunk=>{out+=chunk;const match=out.match(/Open: (http:\/\/[^\s]+)/);if(match){clearTimeout(timer);resolve(match[1]);}});server.on('error',reject);server.on('exit',code=>{clearTimeout(timer);reject(Error('Server exited: '+code));});});
browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--no-proxy-server']});
const page=await browser.newPage({viewport:{width:1500,height:1000}});let searchRequests=0;page.on('request',r=>{if(new URL(r.url()).pathname==='/api/search')searchRequests++;});const faults=[];page.on('pageerror',e=>faults.push(e.message));page.setDefaultTimeout(15000);
await page.addInitScript(()=>{
 window.blockEarliestFind=false;
 window.addEventListener('keydown',e=>{if(window.blockEarliestFind&&(e.ctrlKey||e.metaKey)&&e.shiftKey&&(e.code==='KeyF'||e.key.toLowerCase()==='f')){e.preventDefault();e.stopImmediatePropagation();}},true);
});
await page.goto(url);await page.waitForFunction(()=>document.querySelector('#editor')&&!document.querySelector('#editor').readOnly);
await page.waitForFunction(()=>document.querySelector('#lineNumbers').childNodes.length===document.querySelector('#editor').value.split('\n').length);assert.equal(await page.locator('#lineNumbers').evaluate(e=>e.firstChild.textContent),'1');
assert(await page.locator('#fileTree details').count()>0);assert(await page.locator('#fileTree details').evaluateAll(nodes=>nodes.every(n=>!n.open)));
await page.locator('#expandTree').click();assert(await page.locator('#fileTree details').evaluateAll(nodes=>nodes.every(n=>n.open)));
await page.locator('summary[data-tree-path="nested/deep"]').click();await page.locator('#refreshFiles').click();await page.waitForFunction(()=>document.querySelector('#fileTree details[data-directory="nested"]').open&&!document.querySelector('#fileTree details[data-directory="nested/deep"]').open);
await page.locator('#foldTree').click();assert(await page.locator('#fileTree details').evaluateAll(nodes=>nodes.every(n=>!n.open)));
await page.locator('#fileFilter').fill('nested');await page.waitForFunction(()=>document.querySelector('#fileTree details')?.open);
await page.locator('#fileFilter').fill('');await page.waitForFunction(()=>[...document.querySelectorAll('#fileTree details')].every(n=>!n.open));
console.log('PASS subfolders start folded; expand/fold all, manual state across refresh and filter reveals matches without losing folded state');

// Native paging must never reveal the caret by scrolling a layout frame.
fs.writeFileSync(path.join(root,'paging.tex'),Array.from({length:400},(_,i)=>'paging line '+i+' '+('wrapped source words '.repeat(8))).join('\n'));
await page.locator('#refreshFiles').click();await page.locator('button[data-path="paging.tex"]').click();
await page.waitForFunction(()=>document.querySelector('#files').value==='paging.tex'&&!document.querySelector('#editor').readOnly);
for(const viewport of [{width:1500,height:1000},{width:800,height:600},{width:400,height:600},{width:1280,height:160}]){
 await page.setViewportSize(viewport);
 for(const query of ['', 'paging line 200','paging line 399']){
  await page.locator('#editor').evaluate(e=>{e.focus({preventScroll:true});e.setSelectionRange(0,0);e.scrollTop=0;});
  await page.keyboard.press('Control+f');await page.locator('#sourceQuery').fill(query);
  if(query)await page.keyboard.press('Enter');
  const selected=await page.locator('#editor').evaluate(e=>[e.selectionStart,e.selectionEnd]);
  await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement.id),'editor');
  assert.deepEqual(await page.locator('#editor').evaluate(e=>[e.selectionStart,e.selectionEnd]),selected);
  for(const key of ['PageDown','PageUp','PageDown','PageDown','PageUp']){
   await page.keyboard.press(key);await page.waitForTimeout(60);
   const frame=await page.evaluate(()=>({root:scrollY,body:document.body.scrollTop,header:document.querySelector('header').getBoundingClientRect().top,
    ancestors:[...document.querySelectorAll('.editor-pane,.editor-stack,.source-area,.workspace,#panes')].map(e=>e.scrollTop)}));
   assert.deepEqual(frame,{root:0,body:0,header:0,ancestors:[0,0,0,0,0]},JSON.stringify({viewport,query,key,frame}));
  }
 }
}
await page.setViewportSize({width:1500,height:1000});
await page.locator('#editor').evaluate(e=>{e.focus();e.setSelectionRange(0,0);e.scrollTop=0;});await page.keyboard.press('PageDown');await page.waitForTimeout(100);
assert(await page.locator('#editor').evaluate(e=>e.scrollTop>0),'Native source paging remains enabled');
await page.locator('button[data-path="main.tex"]').click();
await page.locator('#editorTabs .editor-tab').filter({hasText:'paging.tex'}).locator('.close-editor-tab').click();
fs.unlinkSync(path.join(root,'paging.tex'));await page.locator('#refreshFiles').click();
console.log('PASS Ctrl+F/Escape preserves focus/selection; native Page Up/Down cannot displace UI in desktop, narrow and compressed viewports');



await page.locator('#browseServerBtn').click();const picker=page.locator('.server-picker');await picker.waitFor();
await picker.locator('input').fill(root);await picker.locator('[data-go]').click();await picker.locator('.picker-entry').filter({hasText:'main.tex'}).waitFor();
page.once('dialog',d=>d.accept('web folder'));await picker.locator('[data-folder]').click();await picker.locator('.picker-entry').filter({hasText:'web folder'}).waitFor();
page.once('dialog',d=>d.accept('web.tex'));await picker.locator('[data-file]').click();await picker.locator('.picker-entry').filter({hasText:'web.tex'}).click();await picker.locator('[data-open]').click();
await page.waitForFunction(()=>document.querySelector('#files').value==='web.tex'&&!document.querySelector('#editor').readOnly);
console.log('PASS web server picker navigation, create folder/TeX source, select and open project without desktop');
await page.locator('summary[data-tree-path="web folder"]').click();const tex=Buffer.from('hello uploaded\n'),image=Buffer.from([0,255,1,2]);
await page.locator('#uploadFiles').setInputFiles([{name:'上传.tex',mimeType:'text/plain',buffer:tex},{name:'image.png',mimeType:'image/png',buffer:image}]);
await page.waitForSelector('button[data-path="web folder/image.png"]');assert.deepEqual(fs.readFileSync(path.join(root,'web folder/image.png')),image);
await page.locator('button[data-path="web folder/上传.tex"]').click();await page.waitForFunction(()=>document.querySelector('#files').value==='web folder/上传.tex'&&document.querySelector('#editor').value.includes('hello uploaded'));await page.locator('#editor').fill('unsaved uploaded edit');await page.locator('#newEditorView').click();
await page.locator('button[data-path="web folder/上传.tex"]').dragTo(page.locator('#treeRoot'));
await page.waitForSelector('button[data-path="上传.tex"]');assert.equal(fs.readFileSync(path.join(root,'上传.tex'),'utf8'),'unsaved uploaded edit');assert.equal(await page.locator('#editor').inputValue(),'unsaved uploaded edit');
assert.equal(await page.locator('#editorTabs [role=tab]').filter({hasText:'上传.tex'}).count(),2);
await page.locator('button[data-path="上传.tex"]').dragTo(page.locator('summary[data-tree-path="web folder"]'));await page.waitForSelector('button[data-path="web folder/上传.tex"]');
await page.locator('#uploadFiles').setInputFiles([{name:'上传.tex',mimeType:'text/plain',buffer:Buffer.from('overwrite')}]);await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('already exists'));assert.equal(fs.readFileSync(path.join(root,'web folder/上传.tex'),'utf8'),'unsaved uploaded edit');
console.log('PASS binary/text uploads, resource tree visibility, drag moves with saved draft and shared views remapped, collision rejects overwrite');
await page.locator('button[data-path="web folder/上传.tex"]').dragTo(page.locator('.root-drop-space'));await page.waitForSelector('button[data-path="上传.tex"]');assert.equal(fs.readFileSync(path.join(root,'上传.tex'),'utf8'),'unsaved uploaded edit');
console.log('PASS moves from subfolder to root through both explicit tree root row and root whitespace drop area');

await page.locator('summary[data-tree-path="web folder"]').evaluate(node=>{const transfer=new DataTransfer();transfer.items.add(new File(['dropped source'],'dropped.tex',{type:'text/plain'}));node.dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true}));});
await page.waitForSelector('button[data-path="web folder/dropped.tex"]');assert.equal(fs.readFileSync(path.join(root,'web folder/dropped.tex'),'utf8'),'dropped source');
console.log('PASS external file drop uploads exact bytes into target folder');


let downloads=0;page.on('download',()=>downloads++);
fs.writeFileSync(path.join(root,'web folder','preview.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="30" height="20"><rect width="30" height="20" fill="red"/></svg>');fs.writeFileSync(path.join(root,'unsupported.bin'),Buffer.from([0,1,2]));
await page.locator('#refreshFiles').click();await page.locator('button[data-path="web folder/preview.svg"]').click();await page.waitForFunction(()=>document.querySelector('#assetImage').naturalWidth===30);assert.equal(downloads,0);assert(await page.locator('#assetPreview').isVisible());

assert.equal(await page.locator('#assetPreview').evaluate(e=>e.matches(':modal')),false);
await page.locator('#assetZoomIn').click();assert.equal(await page.locator('#assetZoomStatus').textContent(),'120%');await page.locator('#assetActual').click();assert.equal(await page.locator('#assetZoomStatus').textContent(),'100%');
const zoomPrevented=await page.locator('#assetViewport').evaluate(e=>{const event=new WheelEvent('wheel',{deltaY:-80,ctrlKey:true,bubbles:true,cancelable:true,clientX:e.getBoundingClientRect().left+100,clientY:e.getBoundingClientRect().top+100});e.dispatchEvent(event);return event.defaultPrevented;});assert(zoomPrevented);assert(parseInt(await page.locator('#assetZoomStatus').textContent())>100);await page.locator('#assetFit').click();assert.equal(await page.locator('#assetZoomStatus').textContent(),'100%');
await page.locator('#rootSelect').click();assert.equal(await page.locator('#assetPreview').evaluate(e=>e.open),false);
await page.locator('button[data-path="web folder/preview.svg"]').click();await page.waitForFunction(()=>document.querySelector('#assetImage').naturalWidth===30);await page.keyboard.press('Escape');assert.equal(await page.locator('#assetPreview').evaluate(e=>e.open),false);
await page.locator('button[data-path="web folder/preview.svg"]').click();await page.waitForFunction(()=>document.querySelector('#assetImage').naturalWidth===30);
console.log('PASS non-modal preview, click outside acts normally and closes preview, Escape close and independent image zoom/fit');
const imageDownload=page.waitForEvent('download');await page.locator('#assetDownload').click();assert.equal((await imageDownload).suggestedFilename(),'preview.svg');await page.locator('#assetClose').click();
await page.locator('button[data-path="unsupported.bin"]').click();assert((await page.locator('#assetMessage').textContent()).includes('Unsupported'));assert.equal(downloads,1);await page.locator('#assetClose').click();
await page.locator('button[data-path="上传.tex"]').click();await page.waitForFunction(()=>document.querySelector('#files').value==='上传.tex');await page.locator('#editor').fill('export unsaved edit');const single=page.waitForEvent('download');await page.locator('#downloadFileBtn').click();const fileDownload=await single;assert.equal(fs.readFileSync(await fileDownload.path(),'utf8'),'export unsaved edit');
const zipped=page.waitForEvent('download');await page.locator('#downloadProjectBtn').click();const archive=await zipped;assert(archive.suggestedFilename().endsWith('.zip'));assert.equal(fs.readFileSync(await archive.path()).subarray(0,2).toString(),'PK');
console.log('PASS SVG in-app preview, unsupported-format message without automatic download, explicit file/ZIP downloads and unsaved draft saved before export');
await page.locator('#editor').evaluate(e=>{e.focus();e.setSelectionRange(0,6);window.blockFind=event=>{if(event.key.toLowerCase()==='f'){event.preventDefault();event.stopImmediatePropagation();}};e.addEventListener('keydown',window.blockFind,true);});
await page.keyboard.press('Control+Shift+f');await page.locator('#projectSearchDialog').waitFor();assert.equal(await page.locator('#projectQuery').inputValue(),'export');
await page.waitForFunction(()=>document.querySelector('#projectSearchStatus').textContent.includes('matches'));assert(await page.locator('.project-result').count()>0);
await page.locator('#projectSearchClose').click();await page.locator('#editor').evaluate(e=>{e.focus();e.setSelectionRange(0,6);});
await page.keyboard.press('Control+f');await page.locator('#sourceFindBar').waitFor();assert.equal(await page.locator('#sourceQuery').inputValue(),'export');await page.keyboard.press('Escape');
await page.locator('#editor').evaluate(e=>{e.removeEventListener('keydown',window.blockFind,true);delete window.blockFind;e.focus();e.setSelectionRange(7,14);});
await page.locator('#projectSearchBtn').click();assert.equal(await page.locator('#projectQuery').inputValue(),'unsaved');await page.locator('#projectSearchClose').click();
await page.locator('#editor').evaluate(e=>{e.focus();e.setSelectionRange(0,0);});await page.keyboard.press('Control+Shift+f');assert.equal(await page.locator('#projectQuery').inputValue(),'');await page.locator('#projectSearchClose').click();
console.log('PASS Ctrl+Shift+F and Ctrl+F with selected editor text and an editor key interceptor; toolbar prefills project search; empty selection opens blank search');
for(const intercept of [false,true]){
 await page.evaluate(value=>window.blockEarliestFind=value,intercept);
 await page.locator('#editor').evaluate(e=>{e.focus();e.setSelectionRange(0,6);});
 const requestsBefore=searchRequests;
 await page.keyboard.down('Control');await page.keyboard.down('Shift');await page.keyboard.press('KeyF');await page.keyboard.up('Shift');await page.keyboard.up('Control');
 await page.locator('#projectSearchDialog').waitFor();assert.equal(await page.locator('#projectQuery').inputValue(),'export');
 await page.waitForFunction(()=>document.querySelector('#projectSearchStatus').textContent.includes('matches'));assert(await page.locator('.project-result').count()>0);assert.equal(searchRequests,requestsBefore+1,'one search request per physical shortcut');
 await page.locator('#projectSearchClose').click();assert.equal(await page.locator('#editor').inputValue(),'export unsaved edit');
}
await page.evaluate(()=>window.blockEarliestFind=false);
for(const key of ['F','Process']){
 await page.locator('#editor').evaluate((editor,key)=>{editor.focus();editor.setSelectionRange(7,14);editor.dispatchEvent(new KeyboardEvent('keydown',{key,code:'KeyF',ctrlKey:true,shiftKey:true,isComposing:key==='Process',bubbles:true,cancelable:true}));editor.dispatchEvent(new KeyboardEvent('keyup',{key,code:'KeyF',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}));},key);
 await page.locator('#projectSearchDialog').waitFor();assert.equal(await page.locator('#projectQuery').inputValue(),'unsaved');await page.locator('#projectSearchClose').click();
}
await page.locator('#editor').evaluate(e=>{e.focus();e.setSelectionRange(0,1);});await page.keyboard.press('Control+d');await page.waitForFunction(()=>document.querySelector('#multiStatus').textContent.includes('2 cursors'));
await page.keyboard.press('Control+Shift+F');await page.locator('#projectSearchDialog').waitFor();assert.equal(await page.locator('#projectQuery').inputValue(),'e');await page.locator('#projectSearchClose').click();await page.locator('#editor').focus();await page.keyboard.press('Escape');
console.log('PASS physical Ctrl+Shift+F with selected text, earlier window interception, uppercase/IME key reports and grouped selection; source unchanged');
await page.locator('#editor').evaluate(e=>{e.scrollTop=0;e.scrollLeft=0;});await page.locator('#editor').dblclick({position:{x:25,y:25}});
assert.equal(await page.locator('#editor').evaluate(e=>e.value.slice(e.selectionStart,e.selectionEnd)),'export');
await page.keyboard.press('Control+Shift+F');await page.locator('#projectSearchDialog').waitFor();assert.equal(await page.locator('#projectQuery').inputValue(),'export');await page.waitForFunction(()=>document.querySelector('#projectSearchStatus').textContent.includes('matches'));await page.locator('.project-result').first().click();await page.waitForFunction(()=>!document.querySelector('#projectSearchDialog').open);assert.equal(await page.locator('#editor').inputValue(),'export unsaved edit');
console.log('PASS real source double-click word selection followed by Ctrl+Shift+F, completed search and opening a result');




const icons=await page.locator('.file-actions button').evaluateAll(buttons=>buttons.map(b=>({title:b.title,label:b.getAttribute('aria-label'),icon:!!b.querySelector('svg'),width:b.getBoundingClientRect().width})));assert(icons.every(b=>b.title&&b.label&&b.icon&&b.width===28));
await page.locator('#outlinePanel summary').click();await page.waitForFunction(()=>!document.querySelector('#outlinePanel').open&&Object.keys(localStorage).some(k=>k.startsWith('localtex-v2:')&&JSON.parse(localStorage[k]).outline===false));
await page.reload();await page.waitForFunction(()=>!document.querySelector('#editor').readOnly);assert.equal(await page.locator('#outlinePanel').evaluate(e=>e.open),false);
await page.locator('#outlinePanel summary').click();await page.waitForFunction(()=>document.querySelector('#outlinePanel').open);
console.log('PASS compact accessible icon controls and collapsible outline preference survives reload');
const sidebarOrder=await page.evaluate(()=>{const sidebar=document.querySelector('#sidebar');return sidebar.firstElementChild.classList.contains('side-heading')&&!!(document.querySelector('#outlinePanel').compareDocumentPosition(document.querySelector('#buildPanel'))&Node.DOCUMENT_POSITION_FOLLOWING);});assert(sidebarOrder);
await page.locator('#buildPanel summary').click();await page.waitForFunction(()=>!document.querySelector('#buildPanel').open&&Object.keys(localStorage).some(k=>k.startsWith('localtex-v2:')&&JSON.parse(localStorage[k]).buildPanel===false));await page.reload();await page.waitForFunction(()=>!document.querySelector('#editor').readOnly);assert.equal(await page.locator('#buildPanel').evaluate(e=>e.open),false);assert.equal(await page.locator('#compileBtn').isVisible(),false);
await page.locator('#buildPanel summary').click();assert(await page.locator('#compileBtn').isVisible());
console.log('PASS file tree first, build target below outline, build folding and persistence across reload');
const viewsBefore=await page.locator('#editorTabs [role=tab]').count(),draftBefore=await page.locator('#editor').inputValue();
await page.keyboard.press('Control+Alt+n');await page.waitForFunction(n=>document.querySelectorAll('#editorTabs [role=tab]').length===n,viewsBefore+1);
await page.locator('#editorTabs [role=tab][aria-selected=false]').first().click({button:'middle'});await page.waitForFunction(n=>document.querySelectorAll('#editorTabs [role=tab]').length===n,viewsBefore);
assert.equal(await page.locator('#editor').inputValue(),draftBefore);
await page.keyboard.press('Control+Alt+n');await page.waitForFunction(n=>document.querySelectorAll('#editorTabs [role=tab]').length===n,viewsBefore+1);
await page.locator('#editorTabs [role=tab][aria-selected=true]').click({button:'middle'});await page.waitForFunction(n=>document.querySelectorAll('#editorTabs [role=tab]').length===n,viewsBefore);
assert.equal(await page.locator('#editor').inputValue(),draftBefore);console.log('PASS middle-click closes inactive and active subtabs while keeping shared draft');
const stress=await browser.newPage();await stress.goto(new URL('/projects',url).href);
await stress.setContent('<textarea id="editor" style="height:400px;padding:0"></textarea><div id="diagnosticLayer"></div><div id="gutters"></div><div id="problemSummary"></div><button id="logBtn"></button><div id="problemList"></div><div id="console"></div><button id="showProblems"></button><button id="showRawLog"></button><select id="problemFilter"><option value="all">All</option><option value="error">Errors</option><option value="warning">Warnings</option></select>');
const diagnosticsStress=await stress.evaluate(async()=>{
 const {installDiagnostics}=await import('/diagnostics.js'),editor=document.querySelector('#editor'),drafts=new Map([['main.tex',{text:'original'}]]);let measures=0,jumped=null;
 const lines=Array.from({length:10000},(_,i)=>({top:i*20,height:20,gutter:document.createElement('div')}));lines.layoutRevision=1;
 document.querySelector('#gutters').append(...lines.map(e=>e.gutter));editor.value='line\n'.repeat(10000);
 const diagnostics=installDiagnostics({editor,activePath:()=> 'main.tex',drafts:()=>drafts,measure:()=>{measures++;return lines;},openFile:async()=>true,jump:line=>jumped=line,status:()=>{},action:fn=>fn});
 const paint=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
 const warnings=Array.from({length:20000},(_,i)=>({severity:'warning',path:'main.tex',line:i%10000+1,message:'Warning '+i}));
 diagnostics.set({target:'main.tex',diagnostics:warnings},new Map([['main.tex','original']]));await paint();
 const warningMeasure=measures,warningMarkers=document.querySelectorAll('.diagnostic-line,.line-warning').length,initialRows=document.querySelectorAll('.problem-row').length;
 const first=document.querySelector('.problem-row');for(let i=0;i<100;i++){diagnostics.render();diagnostics.update();}await paint();const reused=first===document.querySelector('.problem-row');
 document.querySelector('.problem-more').click();const moreRows=document.querySelectorAll('.problem-row').length;
 const errors=Array.from({length:10000},(_,i)=>({severity:'error',path:'main.tex',line:i+1,message:'Error '+i}));
 diagnostics.set({target:'main.tex',diagnostics:[...warnings,...errors,errors[0]]},new Map([['main.tex','original']]));await paint();
 const errorMarkers=document.querySelectorAll('.diagnostic-line').length;
 editor.scrollTop=1000;for(let i=0;i<100;i++)diagnostics.update();const before=measures;await paint();const scrollMeasures=measures-before,scrolled=document.querySelectorAll('.diagnostic-line').length,visibleTitle=document.querySelector('.line-error')?.title;
 drafts.set('main.tex',{text:'modified'});diagnostics.render();await paint();const staleMarkers=document.querySelectorAll('.diagnostic-line,.line-error').length;
 document.querySelector('.problem-row').click();await paint();
 return {warningMeasure,warningMarkers,initialRows,reused,moreRows,errorMarkers,scrollMeasures,scrolled,visibleTitle,staleMarkers,jumped,summary:document.querySelector('#problemSummary').textContent};
});
assert.equal(diagnosticsStress.warningMeasure,0);assert.equal(diagnosticsStress.warningMarkers,0);assert.equal(diagnosticsStress.initialRows,200);assert(diagnosticsStress.reused);assert.equal(diagnosticsStress.moreRows,400);
assert(diagnosticsStress.errorMarkers>0&&diagnosticsStress.errorMarkers<30);assert.equal(diagnosticsStress.scrollMeasures,1);assert(diagnosticsStress.scrolled<30);assert.notEqual(diagnosticsStress.visibleTitle,'Error 0');assert.equal(diagnosticsStress.staleMarkers,0);assert.equal(diagnosticsStress.jumped,1);assert(diagnosticsStress.summary.includes('20000 warnings'));
await stress.close();console.log('PASS 20,000 warnings / 10,001 errors: no warning geometry work, batched problem rows, visible deduplicated error markers, coalesced scrolling and stale-marker removal');



await page.locator('#setupNotice details').evaluate(e=>e.open=true);await page.locator('#setupNotice input').fill(root);const toolsResponse=page.waitForResponse(r=>r.url().endsWith('/api/tools'));await page.getByRole('button',{name:'Apply TeX path',exact:true}).click();await toolsResponse;await page.waitForFunction(expected=>document.querySelector('#setupNotice input').value===expected&&document.querySelector('#setupNotice').textContent.includes('Detected tools:'),root);
assert.equal(JSON.parse(fs.readFileSync(path.join(temp,'tool-path.json'),'utf8')).texPath,root);
await page.locator('#setupNotice input').fill('');const clearTools=page.waitForResponse(r=>r.url().endsWith('/api/tools'));await page.getByRole('button',{name:'Apply TeX path',exact:true}).click();await clearTools;await page.waitForFunction(()=>document.querySelector('#setupNotice input').value==='');
console.log('PASS UI TeX directory setting persists and can be cleared');
await page.goto(new URL('/projects',url).href);await page.locator('#homeOpenFile').click();await page.locator('.server-picker').waitFor();assert((await page.locator('.picker-notice').textContent()).includes('browser picker'));await page.keyboard.press('Escape');await page.waitForFunction(()=>document.querySelector('#homeStatus').textContent==='Open cancelled.');
console.log('PASS unavailable native picker falls back automatically; cancel leaves landing page intact');
execFileSync(process.env.PYTHON||'python3',['-c',`import zipfile,sys
from pathlib import Path
root=Path(sys.argv[1])
for name,items in [('Paper.zip',{'Wrapped/main.tex':'Imported source','Wrapped/refs.bib':'@article{key}'}),('empty.zip',{'notes.txt':'No TeX'}),('unsafe.zip',{'../escape.tex':'Unsafe'})]:
 with zipfile.ZipFile(root/name,'w',zipfile.ZIP_DEFLATED) as z:
  for filename,text in items.items():z.writestr(filename,text)
`,temp]);
assert((await page.locator('#importDestination').textContent()).includes(path.join(temp,'imports')));
assert(await page.locator('#homeStatus').evaluate(e=>e.previousElementSibling.classList.contains('home-actions')&&!!(e.compareDocumentPosition(document.querySelector('#recentProjects'))&Node.DOCUMENT_POSITION_FOLLOWING)));
for(const name of ['empty.zip','unsafe.zip']){
 await page.locator('#projectZip').setInputFiles(path.join(temp,name));
 await page.waitForFunction(()=>document.querySelector('#homeStatus').textContent&&!document.querySelector('#homeStatus').textContent.includes('Uploading'));
 assert.equal(await page.locator('#homeImportZip').isEnabled(),true);assert(page.url().includes('/projects'));
 assert.equal(fs.existsSync(path.join(temp,'escape.tex')),false);
}
for(let i=1;i<=2;i++){
 await page.locator('#projectZip').setInputFiles(path.join(temp,'Paper.zip'));
 await page.waitForFunction(()=>document.querySelector('#editor')&&!document.querySelector('#editor').readOnly&&document.querySelector('#editor').value==='Imported source');
 const folder=path.join(temp,'imports',i===1?'Paper':'Paper (2)');assert.equal(fs.readFileSync(path.join(folder,'main.tex'),'utf8'),'Imported source');assert.equal(fs.readFileSync(path.join(folder,'refs.bib'),'utf8'),'@article{key}');
 await page.goto(new URL('/projects',url).href);await page.locator('.recent-project').first().waitFor();
 assert((await page.locator('.recent-project').first().textContent()).includes(folder));
}
assert.deepEqual(faults,[]);console.log('PASS landing ZIP upload, rejection remains usable, automatic editor opening, numbered collision folders and recents');}finally{await browser?.close();server.kill();await new Promise(resolve=>server.exitCode!==null?resolve():server.once('exit',resolve));fs.rmSync(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exit(1);});
