// SPDX-License-Identifier: Apache-2.0
import {sessionStore,randomId} from "/storage.js";
// View state is separate from document state: every path has exactly one draft.
export function installEditorViews({editor,bar,activePath,drafts,open,changedView,getRanges,setRanges,getViewport,restoreViewport,status,action}){
  let views=[],active=null,key="",timer,dragged=null;
  const uuid=randomId;
  function persist(immediate=false){
    const write=()=>{if(key)try{sessionStore.setItem(key,JSON.stringify({active,views}));}catch{}};
    clearTimeout(timer);if(immediate)write();else timer=setTimeout(write,500);
  }
  function capture(anchor=false){
    const view=views.find(v=>v.id===active);if(!view || view.path!==activePath())return;
    Object.assign(view,{start:editor.selectionStart,end:editor.selectionEnd,direction:editor.selectionDirection,top:editor.scrollTop,left:editor.scrollLeft,ranges:getRanges()});if(anchor)Object.assign(view,getViewport());persist();
  }
  function insertBesideActive(view){const at=views.findIndex(v=>v.id===active);views.splice(at<0?views.length:at+1,0,view);}
  function clearDrag(){dragged=null;for(const row of bar.children)row.classList.remove('dragging','drop-before','drop-after');}
  function render(scrollActive=true){
    bar.replaceChildren();
    for(const view of views){
      const row=document.createElement('div');row.className='editor-tab'+(view.id===active?' active':'');
      const tab=document.createElement('button');tab.setAttribute('role','tab');tab.setAttribute('aria-selected',view.id===active);tab.dataset.viewId=view.id;
      const siblings=views.filter(v=>v.path===view.path),number=siblings.indexOf(view)+1;
      tab.textContent=view.path.split('/').pop()+(siblings.length>1?' · '+number:'')+(drafts().get(view.path)?.text!==drafts().get(view.path)?.saved?' ●':'');
      tab.title=view.path+' · independent cursor/scroll position · shared draft';tab.onclick=action(async()=>{if(await open(view.path,view.id))editor.focus();});
      tab.draggable=true;tab.addEventListener('dragstart',e=>{capture(true);dragged=view.id;e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/x-localtex-view',view.id);row.classList.add('dragging');});
      tab.addEventListener('dragend',clearDrag);
      row.addEventListener('dragover',e=>{if(!dragged||dragged===view.id)return;e.preventDefault();e.dataTransfer.dropEffect='move';
        for(const other of bar.children)other.classList.remove('drop-before','drop-after');
        row.classList.add(e.clientX<row.getBoundingClientRect().left+row.offsetWidth/2?'drop-before':'drop-after');
        const box=bar.getBoundingClientRect();if(e.clientX<box.left+30)bar.scrollLeft-=24;else if(e.clientX>box.right-30)bar.scrollLeft+=24;
      });
      row.addEventListener('dragleave',()=>row.classList.remove('drop-before','drop-after'));
      row.addEventListener('drop',e=>{if(!dragged||dragged===view.id)return;e.preventDefault();
        const moved=views.find(v=>v.id===dragged),after=e.clientX>=row.getBoundingClientRect().left+row.offsetWidth/2;
        if(!moved)return;views.splice(views.indexOf(moved),1);views.splice(views.indexOf(view)+(after?1:0),0,moved);
        clearDrag();render(false);persist();
      });
      const close=document.createElement('button');close.className='close-editor-tab';close.textContent='×';close.title='Close this view (draft is kept)';close.setAttribute('aria-label','Close view of '+view.path);
      close.onclick=action(async()=>{
        const at=views.indexOf(view);if(at<0)return;capture(true);views.splice(at,1);persist();
        if(active===view.id){active=null;const next=views[Math.min(at,views.length-1)];if(next)await open(next.path,next.id);else changedView();}
        render();
      });
      row.addEventListener('mousedown',e=>{if(e.button===1)e.preventDefault();});
      row.addEventListener('mouseup',e=>{if(e.button===1)e.preventDefault();});
      row.addEventListener('auxclick',e=>{if(e.button===1){e.preventDefault();close.click();}});
      row.append(tab,close);bar.append(row);
    }
    if(scrollActive)bar.querySelector('[aria-selected=true]')?.scrollIntoView({block:'nearest',inline:'nearest'});
  }
  function mapOffset(offset,edits){
    let delta=0;
    for(const edit of edits){
      if(offset<edit.start)break;
      if(offset<=edit.end)return edit.start+delta+(offset===edit.end?edit.text.length:Math.min(Math.max(0,offset-edit.start),edit.text.length));
      delta+=edit.text.length-(edit.end-edit.start);
    }
    return offset+delta;
  }
  function record(path,oldText,newText,hints){
    if(oldText===newText)return;
    const other=views.filter(v=>v.path===path && v.id!==active);
    if(other.length){
      let edits=hints;
      if(!edits){let start=0,end=0;while(start<oldText.length&&start<newText.length&&oldText[start]===newText[start])start++;
        while(end<oldText.length-start&&end<newText.length-start&&oldText[oldText.length-1-end]===newText[newText.length-1-end])end++;
        edits=[{start,end:oldText.length-end,text:newText.slice(start,newText.length-end)}];}
      for(const view of other){
        view.start=mapOffset(view.start,edits);view.end=mapOffset(view.end,edits);if(Number.isFinite(view.anchor))view.anchor=mapOffset(view.anchor,edits);
        view.ranges=(view.ranges||[]).map(r=>({...r,start:mapOffset(r.start,edits),end:mapOffset(r.end,edits)}));
      }
    }
  }
  function badges(){for(const row of bar.children){const id=row.firstChild?.dataset.viewId,v=views.find(v=>v.id===id);if(!v)continue;
    const label=row.firstChild.textContent.replace(/ ●$/,''),draft=drafts().get(v.path),next=label+(draft&&draft.text!==draft.saved?' ●':'');if(row.firstChild.textContent!==next)row.firstChild.textContent=next;
  }}
  function activate(path,id){
    let view=id?views.find(v=>v.id===id&&v.path===path):views.find(v=>v.path===path&&v.id===active)||views.find(v=>v.path===path);
    if(!view){const d=drafts().get(path);view={id:uuid(),path,start:d?.start||0,end:d?.end||0,top:d?.top||0,left:d?.left||0,ranges:[]};insertBesideActive(view);}
    active=view.id;render();persist();return view;
  }
  function restore(view){
    const length=editor.value.length;editor.setSelectionRange(Math.min(view.start||0,length),Math.min(view.end||0,length),view.direction||'none');
    editor.scrollTop=Number.isFinite(view.anchor)?restoreViewport(view):view.top||0;editor.scrollLeft=view.left||0;setRanges(view.ranges||[]);
  }
  async function duplicate(){if(!activePath())return;capture(true);const current=views.find(v=>v.id===active),view={...current,id:uuid(),ranges:[]};insertBesideActive(view);await open(view.path,view.id);editor.focus();}
  async function cycle(direction){if(views.length<2)return;capture(true);const at=views.findIndex(v=>v.id===active),next=views[(at+direction+views.length)%views.length];await open(next.path,next.id);editor.focus();}
  window.addEventListener('keydown',e=>{if(e.altKey&&!e.ctrlKey&&!e.metaKey&&['PageUp','PageDown'].includes(e.key)){e.preventDefault();action(()=>cycle(e.key==='PageUp'?-1:1))();return;}if((e.ctrlKey||e.metaKey)&&e.altKey&&!e.getModifierState('AltGraph')){
    if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();action(()=>cycle(e.key==='ArrowLeft'?-1:1))();}
    else if(e.key.toLowerCase()==='n'){e.preventDefault();action(duplicate)();}
  }});
  window.addEventListener('pagehide',()=>{capture();persist(true);});
  return {capture,record,activate,restore,duplicate,cycle,render,badges,
    configure(root,files){persist(true);clearTimeout(timer);key='localtex-views:'+root;views=[];active=null;
      try{const state=JSON.parse(sessionStore.getItem(key)||'{}');if(Array.isArray(state.views)){
        const ids=new Set();views=state.views.filter(v=>v&&typeof v.id==='string'&&!ids.has(v.id)&&ids.add(v.id)&&files.includes(v.path)&&!v.path.toLowerCase().endsWith('.pdf')).map(v=>({...v,start:Number.isFinite(v.start)?Math.max(0,v.start):0,end:Number.isFinite(v.end)?Math.max(0,v.end):0,top:Number.isFinite(v.top)?Math.max(0,v.top):0,left:Number.isFinite(v.left)?Math.max(0,v.left):0,ranges:[]}));active=state.active;
      }}catch{}render();return views.find(v=>v.id===active)||null;
    },remap(oldPath,newPath){for(const view of views)if(view.path===oldPath||view.path.startsWith(oldPath+'/'))view.path=newPath+view.path.slice(oldPath.length);render();persist();},
    removePaths(test){views=views.filter(v=>!test(v.path));if(!views.some(v=>v.id===active))active=null;render();persist();}
  };
}
