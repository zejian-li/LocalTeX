// SPDX-License-Identifier: Apache-2.0
import {sessionStore,localStore} from "/storage.js";
import {chooseProject,showDependencyStatus} from "/file-picker.js";
import {installEditorViews} from "/editor-views.js";
import {installMultiCursor} from "/multi-cursor.js";
import {createSourceRenderer} from "/source-renderer.js";
import {installNavigation} from "/navigation.js";
import {installRecovery} from "/recovery.js";
import {installLogSearch} from "/log-search.js";
import {installBuildControls} from "/build-controls.js";
import { installDiagnostics } from "/diagnostics.js";
import { installAutocomplete } from "/autocomplete.js";
import * as pdfjs from "/vendor/pdf.mjs";
import { EventBus, PDFViewer, PDFLinkService, PDFFindController } from "/vendor/pdf_viewer.mjs";
pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.mjs";
const $ = id => document.getElementById(id);
const editor = $("editor"), pdf = $("pdf"), drafts = new Map();
var diagnostics,recovery,buildControls,editorViews,multiCursor;
const logSearch=installLogSearch({showRaw:()=>$("showRawLog").click()});
let bracketOffsets=[];
let config, activePath, busy = false, pdfDoc, loading = false, pdfLoading = false;
let projectId=new URLSearchParams(location.search).get("project"), buildTarget=null, shownPdf=null, directories=[], switching=false, createKind="file";
let layoutLines=[];
const sourceRenderer=createSourceRenderer({editor,highlight:$("highlight"),mirror:$("sourceMirror"),numbers:$("lineNumbers")});
let sourceFrame=0;
let selectedTree={path:"",kind:"folder"}, currentMatch=null, pendingDelete=null, deletionHistory=[];
let fileList = [], saveChain = Promise.resolve(), autoTimer, outlineTimer, lineCount = 0;
const expandedDirs=new Set();
let pdfReady=Promise.resolve();
let sourceSequence=0,sourceController=null,filesSequence=0,pdfIntent=0,pdfVersion=null,syncSequence=0;
let lastPane = "source", pdfLocation, prefs = {}, prefKey;
const eventBus = new EventBus();
const linkService = new PDFLinkService({eventBus, externalLinkTarget:2, ignoreDestinationZoom:true});
const findController = new PDFFindController({eventBus, linkService});
const viewer = new PDFViewer({container:pdf, viewer:$("viewer"), eventBus, linkService,
  findController, removePageBorders:true, maxCanvasPixels:16777216, imageResourcesPath:"/vendor/images/"});
linkService.setViewer(viewer);

function status(text) { $("status").textContent = text; }
function persist() { if(prefKey) try { localStore.setItem(prefKey,JSON.stringify(prefs)); } catch {} }
function remember() {
  if (!activePath) return;
  const draft=drafts.get(activePath);if(!draft)return;
  editorViews?.record(activePath,draft.text,editor.value,multiCursor?.hints());
  Object.assign(draft, {text:editor.value, start:editor.selectionStart,
    end:editor.selectionEnd, top:editor.scrollTop, left:editor.scrollLeft});
  editorViews?.capture();
}
function isDirty() { return [...drafts.values()].some(d=>d.text!==d.saved); }
function dirtyUI() {
  editorViews?.badges();
  $("dirty").textContent = isDirty() ? "● unsaved" : "";
  const title=(isDirty()?"● ":"")+(activePath||"LocalTeX")+" — LocalTeX";
  if(document.title!==title)document.title=title;
  for(const btn of $("fileTree").querySelectorAll("button[data-path]")) {
    const d=drafts.get(btn.dataset.path);
    btn.classList.toggle("active",btn.dataset.path===activePath);
    btn.classList.toggle("viewing",btn.dataset.path===shownPdf);
    const label=btn.dataset.name+(d && d.text!==d.saved ? " ●" : "");
    if(btn.textContent!==label)btn.textContent=label;
  }
}
function error(err) {
  status("Error · "+err.message);
  logSearch.set(String(err));
  $("consolePanel").classList.remove("hidden");
  $("showRawLog").click();
}
function action(fn) { return (...args)=>Promise.resolve().then(()=>fn(...args)).catch(error); }
async function api(url,data,{signal,timeout=url==='/api/project/open'&&!data?.path?330000:30000}={}) {
  const controller=new AbortController(),abort=()=>controller.abort();
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const timer=setTimeout(abort,timeout);
  try{
    const res=await fetch(url,{signal:controller.signal,cache:"no-store",headers:{"Content-Type":"application/json",
      ...(projectId?{"X-LocalTeX-Project":projectId}:{})},...(data===undefined?{}:{method:"POST",body:JSON.stringify(data)})});
    const result=await res.json();
    if(!res.ok){const error=Error(result.error||res.statusText);error.code=result.code;throw error;}
    return result;
  }catch(error){
    if(controller.signal.aborted&&!signal?.aborted)throw Error('Request timed out. Check the server connection and try again.');
    throw error;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
function deadline(promise,ms,message,onTimeout=()=>{}){
  let timer;const limit=new Promise((_,reject)=>{timer=setTimeout(()=>{onTimeout();reject(Error(message));},ms);});
  return Promise.race([promise,limit]).finally(()=>clearTimeout(timer));
}
function measureSource() {layoutLines=sourceRenderer.measure(prefs.wrap!==false);}
function requestSourceUI(){if(!sourceFrame)sourceFrame=requestAnimationFrame(()=>{sourceFrame=0;updateSourceUI();});}
function updateSourceUI() {
  if(sourceFrame){cancelAnimationFrame(sourceFrame);sourceFrame=0;}
  measureSource();renderHighlight();
  $("gutter").scrollTop=editor.scrollTop;
  diagnostics?.update();multiCursor?.paint();
  const c=cursor(),label="Ln "+c.line+", Col "+c.column;
  if($("cursorStatus").textContent!==label)$("cursorStatus").textContent=label;
}
new ResizeObserver(requestSourceUI).observe(editor);
function changed(options={}) {
  if(options.recovery){$("autosave").checked=false;prefs.autosave=false;persist();}
  currentMatch=null;bracketOffsets=[];
  remember();recovery?.capture();dirtyUI();requestSourceUI();diagnostics?.render();
  clearTimeout(outlineTimer);outlineTimer=setTimeout(updateOutline,400);
  clearTimeout(autoTimer);
  if($("autosave").checked) autoTimer=setTimeout(action(async()=>{if(!busy) await save();}),1200);
}
function updateOutline() {
  $("outline").replaceChildren();
  editor.value.split("\n").forEach((line,i)=>{
    const m=line.match(/^\s*\\(chapter|section|subsection|subsubsection)\*?(?:\[[^\]]*\])?\{([^}]+)\}/);
    if(!m) return;
    const btn=document.createElement("button");
    btn.textContent=m[2];btn.title="Line "+(i+1);
    btn.style.paddingLeft=(8+["chapter","section","subsection","subsubsection"].indexOf(m[1])*7)+"px";
    btn.onclick=()=>jumpSource(i+1,1);$("outline").append(btn);
  });
}
function isPdf(path) {return /\.pdf$/i.test(path);}
function isText(path){return /\.(tex|bib|sty|cls|txt|md|csv|tikz|bst|cfg|def)$/i.test(path);}
function targetPdf() {return buildTarget?buildTarget.replace(/\.tex$/i,".pdf"):null;}
function pdfUrl(path) {return "/api/pdf?project="+encodeURIComponent(projectId)+"&path="+encodeURIComponent(path);}
function updateBuildUI() {
  $("downloadProjectBtn").disabled=busy||switching;
  $("target").value=buildTarget || "";
  $("compileBtn").disabled=busy || !buildTarget;
  $("compileCurrent").disabled=busy || !/\.tex$/i.test(activePath || "");
  $("buildHint").textContent=buildTarget?"Output: "+targetPdf()+" · working directory: "+(buildTarget.split("/").slice(0,-1).join("/") || "project root"):"Create or select a .tex file to compile.";
}
function renderFiles() {
  const filter=$("fileFilter").value.toLowerCase();
  const root={dirs:new Map(),files:[]};
  function dirNode(path) {
    let node=root;
    for(const part of path.split("/").filter(Boolean)) {
      if(!node.dirs.has(part))node.dirs.set(part,{dirs:new Map(),files:[]});
      node=node.dirs.get(part);
    }
    return node;
  }
  for(const dir of directories) if(!filter || dir.toLowerCase().includes(filter))dirNode(dir);
  for(const path of fileList.filter(p=>p.toLowerCase().includes(filter))) {
    const parts=path.split("/"),name=parts.pop();dirNode(parts.join("/")).files.push({path,name});
  }
  function draw(node,parent,prefix="") {
    for(const [name,child] of node.dirs) {
      const directory=prefix+name,details=document.createElement("details");details.dataset.directory=directory;
      details.open=!!filter || expandedDirs.has(directory);
      details.addEventListener('toggle',()=>{
        if(!details.isConnected || filter)return;
        if(details.open)expandedDirs.add(directory);else expandedDirs.delete(directory);
      });
      const title=document.createElement("summary");title.textContent=name;title.title=prefix+name+"/";title.dataset.treePath=prefix+name;
      title.onclick=()=>selectTree(prefix+name,"folder");enableFileDrag(title,prefix+name);enableFolderDrop(title,prefix+name);
      enableFolderDrop(details,prefix+name);details.append(title);parent.append(details);draw(child,details,prefix+name+"/");
    }
    for(const {path,name} of node.files) {
      const btn=document.createElement("button");btn.dataset.path=path;btn.dataset.name=name;btn.title=path;btn.dataset.treePath=path;
      if(isPdf(path))btn.className="pdf-file";
      btn.onclick=action(()=>{if(isPdf(path))return openPdf(path);if(isText(path))return openFile(path);return previewAsset(path);});enableFileDrag(btn,path);enableFolderDrop(btn,prefix.replace(/\/$/,''));parent.append(btn);
    }
  }
  const rootRow=document.createElement('button');rootRow.id='treeRoot';rootRow.className='tree-root';rootRow.dataset.treePath='';rootRow.textContent='⌂ Project root';rootRow.title='Drop files here to move them to the project root';rootRow.onclick=()=>selectTree('','folder');enableFolderDrop(rootRow,'');
  $("fileTree").replaceChildren(rootRow);draw(root,$("fileTree"));
  const rootSpace=document.createElement('div');rootSpace.className='root-drop-space';rootSpace.textContent='Drop into project root';enableFolderDrop(rootSpace,'');$("fileTree").append(rootSpace);dirtyUI();updateTreeSelection();
}
async function refreshFiles() {
  const sequence=++filesSequence,project=projectId;
  let list;
  try{list=await api("/api/files");}catch(error){if(sequence!==filesSequence||project!==projectId)return;throw error;}
  if(sequence!==filesSequence||project!==projectId)return;
  fileList=list.files;directories=list.directories;
  $("files").replaceChildren(...fileList.filter(isText).map(p=>new Option(p,p)));
  $("files").value=activePath || config.mainTex || "";
  const targets=fileList.filter(p=>/\.tex$/i.test(p));
  if(!targets.includes(buildTarget))buildTarget=targets.includes(config.mainTex)?config.mainTex:targets[0] || null;
  $("target").replaceChildren(...targets.map(p=>new Option(p,p)));
  updateBuildUI();renderFiles();
}
async function setTarget(path) {
  if(busy || switching){updateBuildUI();return;}
  buildTarget=path;prefs.target=path;persist();updateBuildUI();
  const out=targetPdf();
  if(fileList.includes(out))await reloadPdf(out);
  else await clearPdf("Not built yet: "+out);
}
async function openPdf(path) {
  if(busy || switching)return;
  await reloadPdf(path);if(shownPdf!==path)return;selectTree(path,"file");status("Viewing "+path);dirtyUI();
}
async function openFile(path,viewId) {
  completion.dismiss();
  if(switching) return false;
  const sequence=++sourceSequence,project=projectId;
  sourceController?.abort();const controller=new AbortController();sourceController=controller;
  loading=true;editor.readOnly=true;
  try {
    remember();editorViews?.capture(true);recovery?.capture(true);multiCursor?.clear(activePath!==path);
    if(!path)return false;
    if(!drafts.has(path)) {
      const f=await api("/api/file?path="+encodeURIComponent(path),undefined,{signal:controller.signal});
      if(sequence!==sourceSequence||project!==projectId)return false;
      drafts.set(path,{text:f.text,saved:f.text,version:f.version,start:0,end:0,top:0,left:0});
    }
    if(sequence!==sourceSequence||project!==projectId)return false;
    const sameDocument=activePath===path;
    activePath=path;currentMatch=null;bracketOffsets=[];selectTree(path,"file");editor.readOnly=false;editor.placeholder="";const d=drafts.get(path);
    if(!sameDocument || editor.value!==d.text)editor.value=d.text;
    const view=editorViews?.activate(path,viewId);
    if(view)editorViews.restore(view);else{editor.setSelectionRange(d.start,d.end);editor.scrollTop=d.top;editor.scrollLeft=d.left;}
    if(![...$("files").options].some(o=>o.value===path)) $("files").add(new Option(path,path));
    $("files").value=path;
    lineCount=0;updateSourceUI();updateOutline();dirtyUI();updateBuildUI();
    return true;
  }catch(error){if(sequence!==sourceSequence||project!==projectId||controller.signal.aborted)return false;throw error;}
  finally {if(sequence===sourceSequence){loading=false;sourceController=null;editor.readOnly=!activePath || switching;}}
}
function save() {
  clearTimeout(autoTimer);
  const work=async()=>{
    remember();
    for(const [path,d] of drafts) {
      if(d.text===d.saved) continue;
      const text=d.text;
      try {
        const result=await api("/api/save",{path,text,version:d.version});
        d.saved=text;d.version=result.version;
      } catch(err) {
        $("autosave").checked=false;prefs.autosave=false;persist();throw err;
      }
    }
    recovery?.capture(true);dirtyUI();
    $("saveStatus").textContent="Saved "+new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
    if(!busy) status("Saved");
  };
  const result=saveChain.then(work);saveChain=result.catch(()=>{});return result;
}
function cursor() {return {path:activePath,...sourceRenderer.position(editor.selectionStart)};}
function jumpSource(line,column,focus=true) {
  const lines=editor.value.split("\n");
  const n=Math.max(0,Math.min(lines.length-1,line-1));
  const start=lines.slice(0,n).reduce((s,v)=>s+v.length+1,0);
  const pos=start+Math.min(Math.max(0,column-1),lines[n].length);
  if(focus)editor.focus();editor.setSelectionRange(pos,pos);
  measureSource();
  const css=getComputedStyle(editor), entry=layoutLines[n], mirror=$("sourceMirror");
  let y=entry.top;
  if(prefs.wrap!==false && entry.node.firstChild) {
    const range=document.createRange();
    const offset=Math.min(Math.max(0,column-1),entry.node.firstChild.length);
    range.setStart(entry.node.firstChild,offset);range.collapse(true);
    const r=range.getBoundingClientRect();
    if(r.height)y=r.top-mirror.getBoundingClientRect().top;
  }
  editor.scrollTop=Math.max(0,y+parseFloat(css.paddingTop)-editor.clientHeight/2);
  editor.scrollLeft=prefs.wrap!==false?0:Math.max(0,(column-1)*parseFloat(css.fontSize)*.6-editor.clientWidth/2);
  updateSourceUI();
}

// PDF.js owns page layout, text selection, search and zoom coordinates.
eventBus.on("pagechanging",({pageNumber})=>{$("pageNumber").value=pageNumber;});
eventBus.on("updateviewarea",({location})=>{pdfLocation=location;});
eventBus.on("scalechanging",({scale,presetValue})=>{
  const value=presetValue || String(scale);
  if([...$("zoom").options].some(o=>o.value===value)) $("zoom").value=value;
  else { $("customZoom").hidden=false;$("customZoom").textContent=Math.round(scale*100)+"%";$("zoom").value="custom"; }
  $("zoomStatus").textContent=Math.round(scale*100)+"%";
  prefs.zoom=value;persist();
  document.querySelectorAll(".sync-marker").forEach(m=>m.remove());
});
function matchCount({matchesCount}) {
  if(matchesCount) $("pdfMatches").textContent=matchesCount.current+" / "+matchesCount.total;
}
eventBus.on("updatefindmatchescount",matchCount);
eventBus.on("updatefindcontrolstate",matchCount);
async function clearPdf(message="Choose a PDF or compile a target.") {
  pdfIntent++;
  const old=pdfDoc;pdfDoc=null;shownPdf=null;pdfVersion=null;pdfLocation=null;
  viewer.setDocument(null);linkService.setDocument(null);
  $("pdfPath").textContent="No PDF selected";$("pageCount").textContent="/ 0";
  $("pdfEmpty").textContent=message;$("pdfEmpty").classList.remove("hidden");
  $("openPdfTab").removeAttribute("href");
  if(old)await deadline(old.destroy(),5000,'PDF cleanup timed out.').catch(()=>{});
}
async function reloadPdf(path=shownPdf || targetPdf()) {
  if(!path)return;
  const intent=++pdfIntent,project=projectId;
  if(pdfLoading)await pdfReady;
  if(intent!==pdfIntent||project!==projectId)return;
  pdfLoading=true;
  let resolvePdf;pdfReady=new Promise(resolve=>resolvePdf=resolve);
  $("target").disabled=true;
  const oldDoc=pdfDoc,oldPath=shownPdf,oldVersion=pdfVersion,oldLocation=path===shownPdf?pdfLocation:null;
  const scale=viewer.currentScaleValue || prefs.zoom || "page-width";
  let task,next,handler,committed=false;
  try {
    const version=await api('/api/pdf/state?path='+encodeURIComponent(path));
    task=pdfjs.getDocument({url:pdfUrl(path)+"&version="+encodeURIComponent(version.version)+"&t="+Date.now(),
      cMapUrl:"/vendor/cmaps/",cMapPacked:true,standardFontDataUrl:"/vendor/standard_fonts/",isEvalSupported:false});
    next=await deadline(task.promise,60000,'PDF loading timed out. Retry Reload PDF.',()=>task.destroy().catch(()=>{}));
    const latest=await api('/api/pdf/state?path='+encodeURIComponent(path));
    if(latest.version!==version.version)throw Error('PDF changed while loading. Retry Reload PDF after the build finishes.');
    if(project!==projectId||intent!==pdfIntent)return;
    const ready=new Promise(resolve=>{handler=resolve;eventBus.on("pagesinit",handler);});
    pdfDoc=next;shownPdf=path;pdfVersion=version.version;pdfLocation=null;linkService.setDocument(next);viewer.setDocument(next);
    await deadline(ready,30000,'PDF initialization timed out. Retry Reload PDF.');
    if(project!==projectId||intent!==pdfIntent){
      if(pdfDoc===next){pdfDoc=oldDoc;shownPdf=oldPath;pdfVersion=oldVersion;pdfLocation=oldLocation;linkService.setDocument(oldDoc);viewer.setDocument(oldDoc);}
      return;
    }
    $("pdfPath").textContent=path;$("pdfPath").title=path;$("openPdfTab").href=pdfUrl(path);dirtyUI();
    viewer.currentScaleValue=scale;
    $("pageCount").textContent="/ "+next.numPages;$("pageNumber").max=next.numPages;$("pdfEmpty").classList.add("hidden");
    if(oldLocation)viewer.scrollPageIntoView({pageNumber:Math.min(next.numPages,oldLocation.pageNumber),destArray:[null,{name:"XYZ"},oldLocation.left,oldLocation.top,null],allowNegativeOffset:true});
    if($("pdfQuery").value)pdfFind("");
    committed=true;
  }catch(error){
    if(pdfDoc===next){pdfDoc=oldDoc;shownPdf=oldPath;pdfVersion=oldVersion;pdfLocation=oldLocation;linkService.setDocument(oldDoc);viewer.setDocument(oldDoc);}
    $("pdfPath").textContent=shownPdf||'No PDF selected';$("pdfPath").title=shownPdf||'';
    $("pageCount").textContent='/ '+(pdfDoc?.numPages||0);$("pdfEmpty").classList.toggle('hidden',!!pdfDoc);
    if(shownPdf)$("openPdfTab").href=pdfUrl(shownPdf);else $("openPdfTab").removeAttribute('href');
    throw error;
  }finally{
    if(handler)eventBus.off("pagesinit",handler);
    const dispose=committed?oldDoc:(next||task);
    if(dispose)dispose.destroy().catch(()=>{});
    pdfLoading=false;$("target").disabled=busy;resolvePdf();
  }
}
function syncable(path) {return /\.(tex|tikz|sty|cls|def|cfg)$/i.test(path||"");}
async function quietSync(fn) {
  try{await fn();}catch(error){
    if(error.code==='STALE_PDF'){
      try{await reloadPdf();status('PDF changed on disk and was refreshed. Try SyncTeX again.');}catch(refreshError){status(refreshError.message);}
    }else status(error.message||"No source/PDF match here.");
  }
}
async function forward(location=cursor()) {
  if(!syncable(location.path))return;
  if(busy || pdfLoading) return;
  if(!pdfDoc) throw Error("Compile the document first.");
  const doc=pdfDoc,project=projectId,request=++syncSequence;
  const match=await api("/api/sync/forward",{...location,pdf:shownPdf,pdfVersion});
  if(doc!==pdfDoc||project!==projectId||request!==syncSequence) return;
  const page=await pdfDoc.getPage(match.page);
  if(doc!==pdfDoc||project!==projectId||request!==syncSequence)return;
  viewer.scrollPageIntoView({pageNumber:match.page,
    destArray:[null,{name:"XYZ"},match.x,page.view[3]-match.y,null],allowNegativeOffset:true});
  const pv=viewer.getPageView(match.page-1);
  if(!pv.pdfPage) pv.setPdfPage(page);
  const [x,y]=pv.viewport.convertToViewportPoint(match.x,page.view[3]-match.y);
  const marker=document.createElement("div");marker.className="sync-marker";
  marker.style.left=x+"px";marker.style.top=y+"px";pv.div.append(marker);
  const r=marker.getBoundingClientRect(), box=pdf.getBoundingClientRect();
  pdf.scrollTop+=r.top-box.top-pdf.clientHeight/2;
  setTimeout(()=>marker.remove(),1800);viewer.update();
  status("Synced to page "+match.page+(isDirty()?" · edits pending; recompile to update mapping":""));
}
async function reverseAt(div,clientX,clientY) {
  if(busy || pdfLoading)return;
  if(!div || !pdfDoc) return;
  const doc=pdfDoc,path=shownPdf,version=pdfVersion,project=projectId,intent=sourceSequence,request=++syncSequence;
  const n=Number(div.dataset.pageNumber), pv=viewer.getPageView(n-1);
  const page=await doc.getPage(n);
  if(doc!==pdfDoc||project!==projectId||request!==syncSequence||!div.isConnected)return;
  const r=div.getBoundingClientRect();
  const [x,y]=pv.viewport.convertToPdfPoint(
    (clientX-r.left)*pv.viewport.width/r.width,
    (clientY-r.top)*pv.viewport.height/r.height);
  const match=await api("/api/sync/reverse",{page:n,x,y:page.view[3]-y,pdf:path,pdfVersion:version});
  if(doc!==pdfDoc||project!==projectId||intent!==sourceSequence||request!==syncSequence||!syncable(match.path))return;
  if(await openFile(match.path)) {
    jumpSource(match.line,match.column);status(match.path+" · line "+match.line);
  }
}
pdf.addEventListener("dblclick",e=>{if(!e.shiftKey&&!e.target.closest(".annotationLayer a"))quietSync(()=>reverseAt(e.target.closest(".page"),e.clientX,e.clientY));});
async function reverseVisible() {
  if(!pdfDoc)return;
  const box=pdf.getBoundingClientRect(),div=viewer.getPageView(viewer.currentPageNumber-1)?.div;
  if(!div)return;
  const page=div.getBoundingClientRect(),left=Math.max(box.left,page.left),right=Math.min(box.right,page.right),top=Math.max(box.top,page.top),bottom=Math.min(box.bottom,page.bottom);
  if(right>left&&bottom>top)await reverseAt(div,(left+right)/2,(top+bottom)/2);
}
function zoomBy(factor,origin) {
  if(!pdfDoc || pdfLoading) return;
  if(origin) {
    const rect=pdf.getBoundingClientRect();
    origin=[origin[0]-rect.left+pdf.offsetLeft,origin[1]-rect.top+pdf.offsetTop];
  }
  viewer.updateScale({scaleFactor:factor,origin,drawingDelay:150});
}
pdf.addEventListener("wheel",e=>{
  if(!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();e.stopPropagation();
  const delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?pdf.clientHeight:1);
  zoomBy(Math.exp(-Math.max(-150,Math.min(150,delta))*.005),[e.clientX,e.clientY]);
},{passive:false});
// Safari-style gesture events, for browsers that do not encode pinch as ctrl+wheel.
let gestureScale=1;
pdf.addEventListener("gesturestart",e=>{e.preventDefault();gestureScale=1;},{passive:false});
pdf.addEventListener("gesturechange",e=>{
  e.preventDefault();zoomBy(e.scale/gestureScale,[e.clientX,e.clientY]);gestureScale=e.scale;
},{passive:false});
pdf.addEventListener("gestureend",e=>e.preventDefault(),{passive:false});
function pdfFind(type="again",previous=false) {
  eventBus.dispatch("find",{source:window,type,query:$("pdfQuery").value,
    caseSensitive:$("pdfCase").getAttribute("aria-pressed")==="true",entireWord:false,highlightAll:true,findPrevious:previous,matchDiacritics:false});
}
function openSearch(pane) {
  const id=pane==="pdf"?"pdf":"source";
  if(id==="source") {
    const selected=editor.value.slice(editor.selectionStart,editor.selectionEnd);
    if(selected){$("sourceQuery").value=selected;currentMatch=null;}
  }
  $(id+"FindBar").classList.remove("hidden");
  if(id==="source"){if($("sourceQuery").value)sourceFind(false,true);else renderHighlight();}
  $(id+"Query").focus();$(id+"Query").select();
}
function closeSearch(pane,restoreFocus=true) {
  if($(pane+"FindBar").classList.contains("hidden"))return;
  $(pane+"FindBar").classList.add("hidden");
  if(pane==="pdf") eventBus.dispatch("findbarclose",{source:window});else {
    const start=editor.selectionStart,end=editor.selectionEnd,direction=editor.selectionDirection;
    currentMatch=null;renderHighlight();
    if(restoreFocus){editor.focus({preventScroll:true});editor.setSelectionRange(start,end,direction);remember();requestSourceUI();}
  }
}
function editSelection(text,start=editor.selectionStart,end=editor.selectionEnd) {
  editor.focus();editor.setSelectionRange(start,end);
  // Retains native textarea undo history in Chrome/Edge, unlike assigning .value.
  if(!document.execCommand("insertText",false,text)) editor.setRangeText(text,start,end,"end");
  changed();
}
function lineEdit(kind) {
  const start=editor.value.lastIndexOf("\n",editor.selectionStart-1)+1;
  const endPos=editor.selectionEnd;
  const lineEnd=editor.value.indexOf("\n",endPos>editor.selectionStart && editor.value[endPos-1]==="\n"?endPos-1:endPos);
  const end=lineEnd<0?editor.value.length:lineEnd;
  const lines=editor.value.slice(start,end).split("\n");
  const uncomment=kind==="comment" && lines.every(s=>/^\s*%/.test(s)||!s.trim());
  const out=lines.map(s=>kind==="indent"?"  "+s:kind==="unindent"?s.replace(/^( {1,2}|\t)/,""):
    uncomment?s.replace(/^(\s*)% ?/,"$1"):"% "+s).join("\n");
  editSelection(out,start,end);editor.setSelectionRange(start,start+out.length);
}
async function compile(target=buildTarget,clean=false) {
  if(pdfLoading)await pdfReady;
  if(busy || switching || !target) return;
  busy=true;updateBuildUI();$("target").disabled=true;clearTimeout(autoTimer);
  const location=cursor();
  try {
    await save();status("Compiling "+target+"…");
    const snapshots=new Map([...drafts].map(([path,d])=>[path,d.text]));
    const result=await buildControls.build(target,clean);
    diagnostics.set(result,snapshots,{keepRaw:logSearch.active()});
    logSearch.set((result.log||result.output||result.error||"")+(result.log && result.log!==result.output?"\n\n--- Build process output ---\n"+(result.output||""):""));
    if(!result.ok) {$("consolePanel").classList.remove("hidden");status(result.cancelled?"Build cancelled":"Compilation failed");if(result.cancelled)$("showRawLog").click();return;}
    await refreshFiles();await reloadPdf(result.pdfPath);if(!logSearch.active())$("consolePanel").classList.add("hidden");status("Compiled "+target+(result.diagnostics?.length?" · "+result.diagnostics.length+" problems":""));busy=false;
    try {await forward(location);} catch{}
  } finally {
    busy=false;$("target").disabled=false;updateBuildUI();
    if($("autosave").checked && isDirty()) autoTimer=setTimeout(action(save),1200);
  }
}
let resizeTimer;
new ResizeObserver(()=>{
  clearTimeout(resizeTimer);
  resizeTimer=setTimeout(()=>{
    if(!pdfDoc || pdfLoading) return;
    const scale=viewer.currentScaleValue;
    if(scale==="page-width" || scale==="page-fit") viewer.currentScaleValue=scale;
    viewer.update();
  },80);
}).observe(pdf);
function setSplit(value,savePref=true) {
  value=Math.max(20,Math.min(80,value));
  $("panes").style.setProperty("--split",value+"%");
  $("splitter").setAttribute("aria-valuenow",Math.round(value));
  if(savePref){prefs.split=value;persist();}
}
const splitter=$("splitter");
splitter.onpointerdown=e=>{
  if(e.button!==0)return;
  e.preventDefault();splitter.setPointerCapture(e.pointerId);document.body.classList.add("resizing");
};
splitter.onpointermove=e=>{
  if(!splitter.hasPointerCapture(e.pointerId))return;
  const r=$("panes").getBoundingClientRect();setSplit((e.clientX-r.left)/r.width*100);
};
function endResize(e) {
  if(splitter.hasPointerCapture(e.pointerId))splitter.releasePointerCapture(e.pointerId);
  document.body.classList.remove("resizing");viewer.update();
}
splitter.onpointerup=endResize;splitter.onpointercancel=endResize;
splitter.ondblclick=()=>setSplit(50);
splitter.onkeydown=e=>{
  if(e.key==="ArrowLeft" || e.key==="ArrowRight") {e.preventDefault();setSplit(Number(splitter.getAttribute("aria-valuenow"))+(e.key==="ArrowLeft"?-2:2));}
};
function applyPrefs() {
  $("outlinePanel").open=prefs.outline!==false;
  $("buildPanel").open=prefs.buildPanel!==false;
  document.body.classList.toggle("dark",!!prefs.dark);
  pdf.classList.toggle("night",!!prefs.pdfDark);$("pdfDarkBtn").setAttribute("aria-pressed",!!prefs.pdfDark);
  $("sidebar").classList.toggle("hidden",prefs.sidebar===false);
  $("sidebarBtn").setAttribute("aria-pressed",prefs.sidebar!==false);
  $("autosave").checked=!!prefs.autosave;
  document.documentElement.style.setProperty("--source-font",(prefs.font || 15)+"px");
  editor.wrap=prefs.wrap===false?"off":"soft";
  editor.classList.toggle("wrapped",prefs.wrap!==false);
  $("wrapBtn").setAttribute("aria-pressed",prefs.wrap!==false);
  $("syntaxBtn").setAttribute("aria-pressed",prefs.syntax!==false);
  setSplit(prefs.split || 50,false);updateSourceUI();
}
function bind(id,fn) {$(id).addEventListener("click",action(fn));}
editor.addEventListener("input",changed);
editor.addEventListener("scroll",()=>{$("gutter").scrollTop=editor.scrollTop;syncHighlight();diagnostics?.update();});
editor.addEventListener("click",requestSourceUI);
editor.addEventListener("keyup",requestSourceUI);
editor.addEventListener("keydown",e=>{
  if(e.key==="Tab") {e.preventDefault();if(e.shiftKey)lineEdit("unindent");else if(editor.selectionStart!==editor.selectionEnd)lineEdit("indent");else editSelection("  ");}
  else if((e.ctrlKey||e.metaKey)&&e.key==="/") {e.preventDefault();lineEdit("comment");}
});
document.querySelector(".editor-pane").addEventListener("pointerdown",()=>lastPane="source");
document.querySelector(".pdf-pane").addEventListener("pointerdown",()=>lastPane="pdf");
editor.addEventListener("focus",()=>lastPane="source");
pdf.addEventListener("focus",()=>lastPane="pdf");
$("files").addEventListener("change",action(e=>openFile(e.target.value)));
$("fileFilter").addEventListener("input",renderFiles);
$("autosave").onchange=()=>{prefs.autosave=$("autosave").checked;persist();clearTimeout(autoTimer);if(prefs.autosave && isDirty())autoTimer=setTimeout(action(save),1200);};
$("zoom").onchange=()=>{if($("zoom").value!=="custom"&&pdfDoc)viewer.currentScaleValue=$("zoom").value;};
$("pageNumber").onchange=()=>{if(pdfDoc)viewer.currentPageNumber=Math.max(1,Math.min(pdfDoc.numPages,parseInt($("pageNumber").value)||1));};
$("pdfQuery").oninput=()=>pdfFind("");
$("pdfQuery").onkeydown=e=>{if(e.key==="Enter"&&!e.ctrlKey&&!e.metaKey){e.preventDefault();e.stopPropagation();pdfFind("again",e.shiftKey);}};
$("sourceQuery").onkeydown=e=>{if(e.key==="Enter"&&!e.ctrlKey&&!e.metaKey){e.preventDefault();e.stopPropagation();sourceFind(e.shiftKey);}};
bind("saveBtn",save);bind("compileBtn",()=>compile());bind("refreshFiles",refreshFiles);
bind("reloadPdfBtn",async()=>{if(!busy)await reloadPdf();});
bind("logBtn",()=>{const hidden=$("consolePanel").classList.toggle("hidden");if(hidden){logSearch.close(false);editor.focus({preventScroll:true});}});
bind("closeConsole",()=>{logSearch.close(false);$("consolePanel").classList.add("hidden");editor.focus({preventScroll:true});});
bind("sidebarBtn",()=>{prefs.sidebar=prefs.sidebar===false;persist();applyPrefs();});
bind("themeBtn",()=>{prefs.dark=!prefs.dark;persist();applyPrefs();});
bind("pdfDarkBtn",()=>{prefs.pdfDark=!prefs.pdfDark;persist();applyPrefs();});
bind("fontDown",()=>{prefs.font=Math.max(11,(prefs.font||15)-1);persist();applyPrefs();});
bind("fontUp",()=>{prefs.font=Math.min(26,(prefs.font||15)+1);persist();applyPrefs();});
bind("zoomOut",()=>viewer.decreaseScale());bind("zoomIn",()=>viewer.increaseScale());
bind("prevPage",()=>{if(pdfDoc)viewer.currentPageNumber=Math.max(1,viewer.currentPageNumber-1);});
bind("nextPage",()=>{if(pdfDoc)viewer.currentPageNumber=Math.min(pdfDoc.numPages,viewer.currentPageNumber+1);});
bind("sourceFindBtn",()=>openSearch("source"));bind("pdfFindBtn",()=>openSearch("pdf"));
bind("sourceSyncBtn",()=>quietSync(()=>forward()));bind("pdfSyncBtn",()=>quietSync(reverseVisible));
bind("sourceFindClose",()=>closeSearch("source"));bind("pdfFindClose",()=>closeSearch("pdf"));
bind("sourceNext",()=>sourceFind());bind("sourcePrev",()=>sourceFind(true));
bind("replaceOne",replaceOne);bind("replaceAll",replaceAll);
bind("pdfNext",()=>pdfFind());bind("pdfPrev",()=>pdfFind("again",true));
bind("helpBtn",()=>$("help").showModal());bind("helpClose",()=>$("help").close());
// Recognize the physical key too: input methods can report "Process" rather
// than F. A release fallback covers integrations that consume keydown first.
let findHandled=false;
function isFindShortcut(e){return (e.ctrlKey||e.metaKey)&&!e.altKey&&
  (e.key?.toLowerCase()==="f"||e.code==="KeyF"||e.keyCode===70);}
function runFindShortcut(e){
  e.preventDefault();e.stopPropagation();completion.dismiss();
  if(e.shiftKey)navigation.show();else openSearch(lastPane);
}
window.addEventListener("keydown",e=>{
  if(isFindShortcut(e)){findHandled=true;runFindShortcut(e);}
  else if(["Control","Meta","Shift"].includes(e.key))findHandled=false;
},true);
window.addEventListener("keyup",e=>{
  if(isFindShortcut(e)){
    if(!findHandled)runFindShortcut(e);
    findHandled=false;
  }else if(["Control","Meta","Shift"].includes(e.key))findHandled=false;
},true);
window.addEventListener("keydown",e=>{
  if(e.ctrlKey||e.metaKey) {
    if(e.key.toLowerCase()==="s" || e.key==="Enter") {e.preventDefault();action(e.key==="Enter"?(e.shiftKey?()=>compile():compileCurrentSource):save)();}
  }
  if(e.key==="Escape"&&(!$("sourceFindBar").classList.contains("hidden")||!$("pdfFindBar").classList.contains("hidden"))) {
    e.preventDefault();const pdfFocused=$("pdfFindBar").contains(document.activeElement);
    closeSearch("source",!pdfFocused);closeSearch("pdf");
  }
});
window.addEventListener("beforeunload",e=>{remember();if(isDirty()){e.preventDefault();e.returnValue="";}});
async function configure(next,preferInitial=false) {
  logSearch.reset();
  sourceSequence++;filesSequence++;sourceController?.abort();sourceController=null;loading=false;
  recovery.configure(next.projectRoot);
  config=next;projectId=next.projectId;sessionStore.setItem("localtex-project",projectId);
  history.replaceState(null,"","/editor?project="+encodeURIComponent(projectId));
  completion.reset();diagnostics.reset();
  $("project").textContent=next.projectRoot;$("project").title=next.projectRoot;
  prefKey="localtex-v2:"+next.projectRoot;
  try{prefs=JSON.parse(localStore.getItem(prefKey)||"{}");}catch{prefs={};}
  selectedTree={path:"",kind:"folder"};currentMatch=null;expandedDirs.clear();
  try{deletionHistory=JSON.parse(sessionStore.getItem("localtex-trash:"+next.projectRoot)||"[]");}catch{deletionHistory=[];}
  $("undoDelete").disabled=!deletionHistory.length;
  activePath=null;drafts.clear();editor.value="";editor.readOnly=true;editor.placeholder="Create or open a source file to begin.";$("saveStatus").textContent="";
  $("fileFilter").value="";buildTarget=prefs.target || next.mainTex;
  await clearPdf();applyPrefs();await refreshFiles();
  await completion.refresh();await buildControls.load();multiCursor.clear();
  const restored=editorViews.configure(next.projectRoot,fileList);
  const initial=(preferInitial?next.mainTex:null) || restored?.path || next.mainTex || fileList.find(isText);
  if(initial)await openFile(initial,initial===restored?.path?restored.id:undefined);
  if(fileList.includes(targetPdf()))await reloadPdf(targetPdf());
  else status(buildTarget?"Ready · compile "+buildTarget:"Empty project · create a file to begin.");
}
async function openProject(kind,web=false) {
  if(busy || pdfLoading || loading || switching)return;
  clearTimeout(autoTimer);
  switching=true;busy=true;editor.readOnly=true;updateBuildUI();
  try {
    await save();status("Choose a file or folder…");
    const next=await chooseProject(api,kind,web,config.projectRoot);
    if(next.cancelled){status("Open cancelled");return;}
    switching=false;await configure(next,true);
  } finally {switching=false;busy=false;editor.readOnly=!activePath;updateBuildUI();}
}
function showCreate(kind) {
  if(switching)return;
  createKind=kind;$("createTitle").textContent=kind==="file"?"New file":"New folder";
  $("createPath").value=selectedTree.kind==="folder"?selectedTree.path:selectedTree.path.split("/").slice(0,-1).join("/");
  if($("createPath").value)$("createPath").value+="/";
  $("createError").textContent="";$("createDialog").showModal();$("createPath").focus();
}
$("createForm").addEventListener("submit",async e=>{
  e.preventDefault();
  try {
    const result=await api("/api/create",{kind:createKind,path:$("createPath").value,text:""});
    await refreshFiles();$("createDialog").close();
    if(createKind==="file")await openFile(result.path);else selectTree(result.path,"folder");
    status("Created "+result.path);
  }catch(err){$("createError").textContent=err.message;}
});
bind("newFile",()=>showCreate("file"));bind("newFolder",()=>showCreate("folder"));
bind("createCancel",()=>$("createDialog").close());
bind("openFileBtn",()=>openProject("file"));bind("openFolderBtn",()=>openProject("folder"));
bind("browseServerBtn",()=>openProject("folder",true));
let draggedFile=null;
function enableFileDrag(node,path){node.draggable=true;node.ondragstart=e=>{if(busy||switching){e.preventDefault();return;}draggedFile=path;document.body.classList.add('file-dragging');e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/x-localtex-file',path);};node.ondragend=()=>{draggedFile=null;document.body.classList.remove('file-dragging');document.querySelectorAll('.file-drop-target').forEach(n=>n.classList.remove('file-drop-target'));};}
function enableFolderDrop(node,folder){node.ondragover=e=>{if(!draggedFile&&!e.dataTransfer.types.includes('Files'))return;e.preventDefault();e.stopPropagation();e.dataTransfer.dropEffect=draggedFile?'move':'copy';node.classList.add('file-drop-target');};node.ondragleave=()=>node.classList.remove('file-drop-target');node.ondrop=action(async e=>{
  if(e.dataTransfer.files.length){e.preventDefault();e.stopPropagation();node.classList.remove('file-drop-target');await uploadFiles([...e.dataTransfer.files],folder);return;}
  e.preventDefault();e.stopPropagation();node.classList.remove('file-drop-target');const old=draggedFile;draggedFile=null;document.body.classList.remove('file-dragging');if(!old||busy||switching)return;
  const next=(folder?folder+'/':'')+old.split('/').pop();if(next===old)return;
  await save();await api('/api/rename',{path:old,newPath:next});await renameState(old,next);await refreshFiles();status('Moved '+old+' → '+next);
});}
enableFolderDrop($("rootSelect"),'');
enableFolderDrop($("fileTree"),'');
bind("uploadBtn",()=>$("uploadFiles").click());
$("uploadFiles").onchange=action(async()=>{
  const folder=selectedTree.kind==='folder'?selectedTree.path:selectedTree.path.split('/').slice(0,-1).join('/');
  try{await uploadFiles([...$("uploadFiles").files],folder);}finally{$("uploadFiles").value='';}
});
async function uploadFiles(files,folder){
  if(busy||switching)throw Error('Wait for the current operation before uploading.');
  let uploaded=0;try{for(const file of files){
    if(file.size>10*1024*1024)throw Error(file.name+': upload limit is 10 MiB per file.');
    const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let at=0;at<bytes.length;at+=32768)binary+=String.fromCharCode(...bytes.subarray(at,at+32768));
    await api('/api/upload',{path:(folder?folder+'/':'')+file.name,content:btoa(binary)});uploaded++;
  }status('Uploaded '+uploaded+' file(s)');}catch(e){throw Error((uploaded?'Uploaded '+uploaded+' file(s); ':'')+e.message);}finally{await refreshFiles();}
}
bind("compileCurrent",compileCurrentSource);
bind("wrapBtn",()=>{prefs.wrap=prefs.wrap===false;persist();applyPrefs();});
$("target").addEventListener("change",action(e=>setTarget(e.target.value)));
function selectTree(path,kind) {
  selectedTree={path,kind};updateTreeSelection();
}
function updateTreeSelection() {
  for(const el of $("fileTree").querySelectorAll("[data-tree-path]"))
    el.classList.toggle("tree-selected",el.dataset.treePath===selectedTree.path);
  $("rootSelect").classList.toggle("tree-selected",selectedTree.path==="");
  $("deleteBtn").disabled=!selectedTree.path || busy || switching;
  $("downloadFileBtn").disabled=selectedTree.kind!=='file' || busy || switching;
}
let previewPath=null,imageScale=1;
const assetViewport=$("assetViewport"),assetImage=$("assetImage");
function imageZoom(scale,origin=[assetViewport.clientWidth/2,assetViewport.clientHeight/2]){
  if(!assetImage.naturalWidth)return;
  const oldWidth=assetImage.naturalWidth*imageScale,oldHeight=assetImage.naturalHeight*imageScale;
  const x=(assetViewport.scrollLeft+origin[0]-Math.max(0,(assetViewport.clientWidth-oldWidth)/2))/imageScale;
  const y=(assetViewport.scrollTop+origin[1]-Math.max(0,(assetViewport.clientHeight-oldHeight)/2))/imageScale;
  imageScale=Math.max(.05,Math.min(8,scale));
  const width=assetImage.naturalWidth*imageScale,height=assetImage.naturalHeight*imageScale;
  const canvasWidth=Math.max(assetViewport.clientWidth,width),canvasHeight=Math.max(assetViewport.clientHeight,height);
  Object.assign($("assetCanvas").style,{width:canvasWidth+'px',height:canvasHeight+'px'});
  Object.assign(assetImage.style,{width:width+'px',height:height+'px',left:(canvasWidth-width)/2+'px',top:(canvasHeight-height)/2+'px'});
  assetViewport.scrollLeft=x*imageScale+(canvasWidth-width)/2-origin[0];assetViewport.scrollTop=y*imageScale+(canvasHeight-height)/2-origin[1];
  $("assetZoomStatus").textContent=Math.round(imageScale*100)+'%';
}
function fitImage(){if(assetImage.naturalWidth)imageZoom(Math.min(1,assetViewport.clientWidth/assetImage.naturalWidth,assetViewport.clientHeight/assetImage.naturalHeight));assetViewport.scrollTop=assetViewport.scrollLeft=0;}
function previewAsset(path){
  selectTree(path,'file');previewPath=path;$("assetName").textContent=path;$("assetName").title=path;
  const image=$("assetImage"),supported=/\.(png|jpe?g|gif|webp|bmp|avif|ico|svg)$/i.test(path);
  image.removeAttribute('src');image.classList.toggle('hidden',!supported);image.alt=path;
  $("assetZoomBar").classList.toggle('hidden',!supported);assetViewport.classList.toggle('hidden',!supported);imageScale=1;$("assetZoomStatus").textContent='';
  $("assetMessage").textContent=supported?'Loading image…':'Unsupported preview format. You can download this file.';
  if(!$("assetPreview").open)$("assetPreview").show();
  if(supported){image.onload=()=>{$("assetMessage").textContent=image.naturalWidth+' × '+image.naturalHeight+' pixels';fitImage();};image.onerror=()=>{$("assetMessage").textContent='This image could not be displayed. You can download the original file.';image.classList.add('hidden');assetViewport.classList.add('hidden');$("assetZoomBar").classList.add('hidden');};image.src='/api/image?project='+encodeURIComponent(projectId)+'&path='+encodeURIComponent(path);}
}
async function downloadFile(path){if(!path)return;await save();const a=document.createElement('a');a.href='/api/asset?project='+encodeURIComponent(projectId)+'&path='+encodeURIComponent(path);a.download=path.split('/').pop();a.click();}
bind('assetClose',()=>$("assetPreview").close());bind('assetDownload',()=>downloadFile(previewPath));
$("assetPreview").addEventListener('close',()=>{if(!$("assetPreview").open){$("assetImage").removeAttribute('src');previewPath=null;}});
document.addEventListener('pointerdown',e=>{if($("assetPreview").open&&!$("assetPreview").contains(e.target))$("assetPreview").close();},true);
window.addEventListener('keydown',e=>{if(e.key==='Escape'&&$("assetPreview").open){e.preventDefault();e.stopImmediatePropagation();$("assetPreview").close();}},true);
bind('assetZoomOut',()=>imageZoom(imageScale/1.2));bind('assetZoomIn',()=>imageZoom(imageScale*1.2));bind('assetFit',fitImage);bind('assetActual',()=>imageZoom(1));
assetViewport.addEventListener('wheel',e=>{if(!e.ctrlKey&&!e.metaKey)return;e.preventDefault();e.stopPropagation();const box=assetViewport.getBoundingClientRect(),delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?assetViewport.clientHeight:1);imageZoom(imageScale*Math.exp(-Math.max(-150,Math.min(150,delta))*.005),[e.clientX-box.left,e.clientY-box.top]);},{passive:false});
let imageGestureScale=1;
assetViewport.addEventListener('gesturestart',e=>{e.preventDefault();imageGestureScale=imageScale;},{passive:false});
assetViewport.addEventListener('gesturechange',e=>{e.preventDefault();const box=assetViewport.getBoundingClientRect();imageZoom(imageGestureScale*e.scale,[e.clientX-box.left,e.clientY-box.top]);},{passive:false});
assetViewport.addEventListener('gestureend',e=>e.preventDefault(),{passive:false});
new ResizeObserver(()=>{if($("assetPreview").open&&assetImage.naturalWidth)imageZoom(imageScale);}).observe(assetViewport);
bind('downloadFileBtn',()=>downloadFile(selectedTree.kind==='file'?selectedTree.path:null));
bind('downloadProjectBtn',async()=>{await save();const a=document.createElement('a');a.href='/api/project/download?project='+encodeURIComponent(projectId);a.download='project.zip';a.click();});
function foldTree(open){
  expandedDirs.clear();
  for(const directory of directories)if(open)expandedDirs.add(directory);
  for(const details of $('fileTree').querySelectorAll('details')){
    if(open)expandedDirs.add(details.dataset.directory);
    details.open=open;
  }
}
bind('expandTree',()=>foldTree(true));bind('foldTree',()=>foldTree(false));
const fileIcons={
  newFile:['New file','M14 2H4v20h16V8z M14 2v6h6 M8 15h8 M12 11v8'],
  newFolder:['New folder','M2 6V4h7l2 3h11v14H2z M9 14h8 M13 10v8'],
  uploadBtn:['Upload files','M12 16V3 M7 8l5-5 5 5 M3 16v5h18v-5'],
  renameBtn:['Move or rename','M12 2v20 M2 12h20 M8 6l4-4 4 4 M8 18l4 4 4-4 M6 8l-4 4 4 4 M18 8l4 4-4 4'],
  deleteBtn:['Delete selected file or folder','M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7'],
  rootSelect:['Select project root; drop files here to move to root','M3 11l9-8 9 8 M5 9v12h14V9 M9 21v-8h6v8'],
  undoDelete:['Undo last deletion','M3 10h10a7 7 0 0 1 0 14 M3 10l5-5 M3 10l5 5'],
  downloadFileBtn:['Download selected file','M14 2H4v20h16V8z M14 2v6h6 M12 10v8 M8 14l4 4 4-4'],
  downloadProjectBtn:['Download entire project as ZIP','M3 3h18v18H3z M9 3v5h6 M12 10v8 M8 14l4 4 4-4'],
  expandTree:['Expand all folders','M4 8l8-5 8 5 M4 16l8 5 8-5'],
  foldTree:['Fold all folders','M4 3l8 5 8-5 M4 21l8-5 8 5']
};
for(const [id,[label,path]] of Object.entries(fileIcons)){const button=$(id);button.title=label;button.setAttribute('aria-label',label);button.innerHTML='<svg aria-hidden="true" viewBox="0 0 24 24"><path d="'+path+'"/></svg>';}
$("outlinePanel").addEventListener('toggle',()=>{if(config){const open=$("outlinePanel").open;if(prefs.outline!==open){prefs.outline=open;persist();}}});
$("buildPanel").addEventListener('toggle',()=>{if(config){const open=$("buildPanel").open;if(prefs.buildPanel!==open){prefs.buildPanel=open;persist();}}});
let findCache={};
function sourceResults() {
  const query=$("sourceQuery").value;
  if(!query)return [];
  const text=editor.value,caseSensitive=$("sourceCase").getAttribute("aria-pressed")==="true";
  if(findCache.text===text && findCache.query===query && findCache.caseSensitive===caseSensitive)return findCache.hits;
  const escaped=query.replace(/[.*+?^$(){}|[\]\\]/g,"\\$&");
  const hits=[...text.matchAll(new RegExp(escaped,caseSensitive?"g":"gi"))].map(m=>({start:m.index,end:m.index+m[0].length}));
  findCache={text,query,caseSensitive,hits};return hits;
}
function renderHighlight() {
  const searching=!$("sourceFindBar").classList.contains("hidden") && !!$("sourceQuery").value;
  const enabled=prefs.syntax!==false || searching || bracketOffsets.length>0;
  document.querySelector(".editor-stack").classList.toggle("colored",enabled);
  if(!enabled)return;
  const hits=searching?sourceResults():[];
  sourceRenderer.render({syntax:prefs.syntax!==false && /\.(tex|sty|cls|tikz|bib|bst)$/i.test(activePath||""),
    hits,brackets:bracketOffsets,current:currentMatch,
    searchKey:searching?$("sourceQuery").value+"|"+$("sourceCase").getAttribute("aria-pressed"):""});
  const index=hits.findIndex(h=>currentMatch && h.start===currentMatch.start);
  const count=searching?(index<0?0:index+1)+" / "+hits.length:"";
  if($("sourceMatches").textContent!==count)$("sourceMatches").textContent=count;
  syncHighlight();
}
function syncHighlight() {
  const el=$("highlight");
  el.style.width=editor.clientWidth+"px";
  el.classList.toggle("wrapped",prefs.wrap!==false);
  el.style.transform="translate("+(-editor.scrollLeft)+"px,"+(-editor.scrollTop)+"px)";
}
function sourceFind(previous=false, reset=false) {
  const hits=sourceResults();
  if(!hits.length){currentMatch=null;renderHighlight();status("No source matches");$("sourceQuery").focus();return;}
  let index=currentMatch && !reset?hits.findIndex(h=>h.start===currentMatch.start):-1;
  if(index>=0)index=(index+(previous?-1:1)+hits.length)%hits.length;
  else {
    index=previous?hits.findLastIndex(h=>h.start<editor.selectionStart):hits.findIndex(h=>h.start>=editor.selectionStart);
    if(index<0)index=previous?hits.length-1:0;
  }
  currentMatch=hits[index];
  const before=editor.value.slice(0,currentMatch.start);
  const line=before.split("\n").length,column=before.length-before.lastIndexOf("\n");
  jumpSource(line,column,false);
  editor.setSelectionRange(currentMatch.start,currentMatch.end);
  updateSourceUI();renderHighlight();$("sourceQuery").focus({preventScroll:true});
  status("Source match "+(index+1)+" / "+hits.length+" · line "+line);
}
function replaceOne() {
  const focus=document.activeElement, hits=sourceResults();
  const hit=hits.find(h=>h.start===editor.selectionStart && h.end===editor.selectionEnd);
  if(hit){editSelection($("replacement").value,hit.start,hit.end);currentMatch=null;}
  sourceFind();if(focus?.id==="replacement")focus.focus();
}
function replaceAll() {
  const hits=sourceResults(),focus=document.activeElement;
  if(!hits.length)return;
  let start=0,out="";
  for(const hit of hits){out+=editor.value.slice(start,hit.start)+$("replacement").value;start=hit.end;}
  out+=editor.value.slice(start);
  editSelection(out,0,editor.value.length);currentMatch=null;renderHighlight();
  if(focus?.id==="replacement")focus.focus();else $("sourceQuery").focus();
  status("Replaced "+hits.length+" occurrences");
}
async function compileCurrentSource() {
  if(!/\.tex$/i.test(activePath || "")){status("Open a .tex source file to compile.");return;}
  await compile(activePath);
}
function requestDelete() {
  if(!selectedTree.path || busy || switching || pdfLoading || loading)return;
  pendingDelete={...selectedTree};
  $("deleteDescription").textContent=pendingDelete.path+(pendingDelete.kind==="folder"?" and all its contents":"");
  $("deleteError").textContent="";$("deleteDialog").showModal();
}
async function deleteSelected() {
  if(!pendingDelete || busy)return;
  const selected=pendingDelete;
  busy=true;switching=true;editor.readOnly=true;updateBuildUI();
  $("deleteConfirm").disabled=true;clearTimeout(autoTimer);
  const affected=p=>p && (p===selected.path || p.startsWith(selected.path+"/"));
  try{
    await save();
    const result=await api("/api/delete",{path:selected.path});
    deletionHistory.push(result);sessionStore.setItem("localtex-trash:"+config.projectRoot,JSON.stringify(deletionHistory));
    $("undoDelete").disabled=false;
    for(const path of [...drafts.keys()])if(affected(path))drafts.delete(path);
    editorViews.removePaths(affected);multiCursor.clear();
    if(affected(activePath)){
      activePath=null;editor.value="";editor.placeholder="Open a source file to begin.";currentMatch=null;
      updateSourceUI();updateOutline();
    }
    if(affected(shownPdf))await clearPdf();
    selectTree(selected.path.split("/").slice(0,-1).join("/"),"folder");
    await refreshFiles();prefs.target=buildTarget;persist();dirtyUI();
    $("deleteDialog").close();pendingDelete=null;
    status("Moved to local trash: "+selected.path);
  }catch(err){$("deleteError").textContent=err.message;}
  finally{busy=false;switching=false;editor.readOnly=!activePath;$("deleteConfirm").disabled=false;updateBuildUI();updateTreeSelection();}
}
async function undoDelete() {
  if(!deletionHistory.length || busy || switching)return;
  const result=await api("/api/restore",{token:deletionHistory.at(-1).token});
  deletionHistory.pop();sessionStore.setItem("localtex-trash:"+config.projectRoot,JSON.stringify(deletionHistory));
  $("undoDelete").disabled=!deletionHistory.length;await refreshFiles();
  selectTree(result.path,result.kind);status("Restored "+result.path);
}

$("sourceQuery").oninput=()=>{currentMatch=null;sourceFind(false,true);};
$("sourceCase").onclick=()=>{const b=$("sourceCase");b.setAttribute("aria-pressed",b.getAttribute("aria-pressed")!=="true");currentMatch=null;sourceFind(false,true);};
$("pdfCase").onclick=()=>{const b=$("pdfCase");b.setAttribute("aria-pressed",b.getAttribute("aria-pressed")!=="true");pdfFind("");};
bind("syntaxBtn",()=>{prefs.syntax=prefs.syntax===false;persist();applyPrefs();});
bind("rootSelect",()=>selectTree("","folder"));
bind("deleteBtn",requestDelete);bind("deleteConfirm",deleteSelected);
bind("deleteCancel",()=>{$("deleteDialog").close();pendingDelete=null;});
bind("undoDelete",undoDelete);
recovery=installRecovery({editor,drafts:()=>drafts,activePath:()=>activePath,api,openFile,changed,status,action});
buildControls=installBuildControls({setLog:(value)=>logSearch.set(value,{stream:true}),api,settingsTarget:()=>buildTarget,files:()=>fileList,busy:()=>busy,status,action});
async function renameState(oldPath,newPath){
  const remap=path=>path && (path===oldPath||path.startsWith(oldPath+"/"))?newPath+path.slice(oldPath.length):path;
  recovery.remap(oldPath,newPath);
  for(const [path,d] of [...drafts])if(remap(path)!==path){drafts.delete(path);drafts.set(remap(path),d);}
  editorViews.remap(oldPath,newPath);
  activePath=remap(activePath);buildTarget=remap(buildTarget);selectedTree.path=remap(selectedTree.path);
  prefs.target=buildTarget;persist();
  if(shownPdf && remap(shownPdf)!==shownPdf)await reloadPdf(remap(shownPdf));
  await buildControls.load();await completion.refresh();updateSourceUI();dirtyUI();
}
multiCursor=installMultiCursor({editor,layer:$("multiCursorLayer"),measure:()=>{measureSource();return layoutLines;},
  position:offset=>sourceRenderer.position(offset),write:editSelection,status,
  notify(textChanged=true){if(textChanged)changed();else{remember();requestSourceUI();}}});
editorViews=installEditorViews({editor,bar:$("editorTabs"),activePath:()=>activePath,drafts:()=>drafts,open:openFile,
  changedView(){activePath=null;multiCursor.clear();editor.value="";editor.readOnly=true;editor.placeholder="Open a source file to begin.";$("files").value="";updateSourceUI();dirtyUI();updateBuildUI();},
  getRanges:()=>multiCursor.ranges(),setRanges:ranges=>multiCursor.restore(ranges),status,action,
  getViewport(){measureSource();const scroll=editor.scrollTop;let at=0;while(at+1<layoutLines.length&&layoutLines[at+1].top<=scroll)at++;
    return {anchor:layoutLines[at]?.start||0,anchorPixels:scroll-(layoutLines[at]?.top||0)};},
  restoreViewport(view){measureSource();const at=sourceRenderer.position(Math.min(view.anchor,editor.value.length)).line-1;return (layoutLines[at]?.top||0)+(view.anchorPixels||0);}});
bind("newEditorView",()=>editorViews.duplicate());
editor.addEventListener("scroll",()=>editorViews.capture());
let resumeTimer;
function refreshOnResume(){
  clearTimeout(resumeTimer);resumeTimer=setTimeout(()=>{
    if(config&&!busy&&!loading&&!switching&&!document.hidden)action(refreshFiles)();
  },250);
}
window.addEventListener('focus',refreshOnResume);
window.addEventListener('online',refreshOnResume);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshOnResume();});
const navigation=installNavigation({editor,api,activePath:()=>activePath,buildTarget:()=>buildTarget,drafts:()=>drafts,openFile,jump:jumpSource,
  edit:editSelection,save,refresh:refreshFiles,selected:()=>selectedTree,busy:()=>busy,renameState,status,action,highlightBrackets:offsets=>{bracketOffsets=offsets;renderHighlight();}});
bind("projectSearchBtn",()=>navigation.show());bind("renameBtn",()=>navigation.rename());
bind("historyBtn",()=>recovery.show());bind("buildSettingsBtn",()=>buildControls.show());
bind("cleanBuildBtn",()=>compile(buildTarget,true));
diagnostics=installDiagnostics({editor,activePath:()=>activePath,drafts:()=>drafts,openFile,jump:jumpSource,
  measure:()=>{measureSource();return layoutLines;},status,action,onView:raw=>logSearch.visible(raw)});
const completion=installAutocomplete({editor,popup:$("completionPopup"),api,edit:editSelection,
  enabled:()=>!multiCursor.active() && /\.(tex|sty|cls|tikz)$/i.test(activePath||""),
  drafts:()=>drafts,measure:()=>{measureSource();return layoutLines;}});
action(async()=>{
  await showDependencyStatus(api,$("setupNotice"),[$("openFileBtn"),$("openFolderBtn")]);
  await recovery.claim();
  let next;
  try{next=await api("/api/config");}catch{location.replace("/projects");return;}
  await configure(next);
  if(!config.synctex)status("synctex missing from PATH");
})();
