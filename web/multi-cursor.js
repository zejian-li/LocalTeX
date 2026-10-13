// SPDX-License-Identifier: Apache-2.0
// Extra cursors are decorations over the native textarea. A batch replacement
// uses one native editing command, preserving an atomic Undo for all positions.
export function installMultiCursor({editor,layer,measure,position,write,notify,status}){
  let extra=[],pending=null,applying=false,editHints=null,frame=0,pendingHistory=null,pendingInput=null;
  let undo=[],redo=[];
  const primary=()=>({start:editor.selectionStart,end:editor.selectionEnd,direction:editor.selectionDirection});
  const all=()=>[...extra,primary()].sort((a,b)=>a.start-b.start||a.end-b.end);
  function merge(ranges){
    const sorted=ranges.map(r=>({...r,start:Math.max(0,Math.min(r.start,editor.value.length)),end:Math.max(0,Math.min(r.end,editor.value.length))})).sort((a,b)=>a.start-b.start||a.end-b.end),out=[];
    for(const range of sorted){const last=out.at(-1);if(last && (range.start<last.end || range.start===last.start&&range.end===last.end))last.end=Math.max(last.end,range.end);else out.push(range);}return out;
  }
  function set(ranges,main=ranges.at(-1)){
    const normalized=merge(ranges);const p=normalized.find(r=>main && r.start<=main.start&&r.end>=main.end)||normalized.at(-1);
    extra=normalized.filter(r=>r!==p);if(p)editor.setSelectionRange(p.start,p.end,p.direction||'none');schedule();
  }
  const snapshot=()=>({ranges:all().map(r=>({...r})),primary:primary()});
  function clear(resetHistory=false){if(resetHistory){undo=[];redo=[];pendingInput=null;pendingHistory=null;}extra=[];pending=null;layer.replaceChildren();document.getElementById('multiStatus').textContent='';}
  function diff(before,after){let start=0,end=0;while(start<before.length&&start<after.length&&before[start]===after[start])start++;
    while(end<before.length-start&&end<after.length-start&&before[before.length-1-end]===after[after.length-1-end])end++;
    return [{start,end:before.length-end,text:after.slice(start,after.length-end),removed:before.slice(start,before.length-end)}];
  }
  function record(edits,before,after){undo.push({edits,before,after});redo=[];if(undo.length>500)undo.shift();}
  function replay(text,edits,backward){
    let delta=0;const changes=edits.map(e=>{const start=e.start+delta;delta+=e.text.length-e.removed.length;return backward?{start,end:start+e.text.length,text:e.removed,removed:e.text}:e;});
    for(const e of changes.slice().reverse()){if(text.slice(e.start,e.end)!==e.removed)return null;text=text.slice(0,e.start)+e.text+text.slice(e.end);}return text;
  }
  function restoreHistory({type,text,before}){
    const backward=type==='historyUndo',from=backward?undo:redo,to=backward?redo:undo;let candidate=text,matched=0;
    // Browsers may combine adjacent native commands into one undo unit.
    for(let i=from.length-1;i>=0;i--){candidate=replay(candidate,from[i].edits,backward);if(candidate===null)break;if(candidate===editor.value){matched=from.length-i;break;}}
    if(matched){let entry;while(matched--) {entry=from.pop();to.push(entry);}const state=backward?entry.before:entry.after;set(state.ranges,state.primary);}
    else{
      // Unknown native operations still keep the group, rebased through the edit.
      const [edit]=diff(text,editor.value),map=offset=>offset<edit.start?offset:offset>edit.end?offset+edit.text.length-(edit.end-edit.start):edit.start+Math.min(offset-edit.start,edit.text.length);
      const ranges=before.ranges.map(r=>({...r,start:map(r.start),end:map(r.end)})),p={...before.primary,start:map(before.primary.start),end:map(before.primary.end)};
      set(ranges,p);undo=[];redo=[];
    }
  }
  function schedule(){if(!extra.length&&!layer.childNodes.length)return;if(!frame)frame=requestAnimationFrame(()=>{frame=0;paint();});}
  function paint(){
    layer.replaceChildren();document.getElementById('multiStatus').textContent=extra.length?(extra.length+1)+' cursors · Esc clears':'';
    if(!extra.length)return;
    const lines=measure(),css=getComputedStyle(editor),padX=parseFloat(css.paddingLeft),padY=parseFloat(css.paddingTop),lineHeight=parseFloat(css.lineHeight);
    const draw=(rect,kind)=>{if(rect.top+rect.height<0 || rect.top>editor.clientHeight)return;const marker=document.createElement('div');marker.className=kind;
      Object.assign(marker.style,{left:rect.left+'px',top:rect.top+'px',height:rect.height+'px',width:Math.max(2,rect.width||0)+'px'});layer.append(marker);};
    for(const selection of extra){
      const first=position(selection.start).line-1,last=position(selection.end).line-1,head=selection.direction==='backward'?selection.start:selection.end,caretLine=position(head).line-1;
      for(let index=first;index<=last;index++){
        const entry=lines[index];if(!entry||entry.top+entry.height<editor.scrollTop-padY||entry.top>editor.scrollTop+editor.clientHeight)continue;
        const node=entry.node.firstChild;if(!node)continue;const start=Math.max(0,selection.start-entry.start),end=Math.min(entry.text.length,selection.end-entry.start),base=entry.node.getBoundingClientRect();
        const range=document.createRange();range.setStart(node,Math.min(start,node.length));range.setEnd(node,Math.max(0,Math.min(end,node.length)));
        if(selection.end>selection.start){for(const rect of range.getClientRects())draw({left:padX+rect.left-base.left-editor.scrollLeft,top:padY+entry.top+rect.top-base.top-editor.scrollTop,height:rect.height||lineHeight,width:rect.width},'secondary-selection');}
        if(index===caretLine){
          const end=Math.max(0,head-entry.start);
          const caret=document.createRange();caret.setStart(node,Math.max(0,Math.min(end,node.length)));caret.collapse(true);let rect=caret.getBoundingClientRect(),x=rect.left-base.left,y=rect.top-base.top;
          if(!rect.height){if(end>0){caret.setStart(node,end-1);caret.setEnd(node,end);rect=caret.getBoundingClientRect();x=rect.right-base.left;y=rect.top-base.top;}else{x=0;y=0;}}
          draw({left:padX+x-editor.scrollLeft,top:padY+entry.top+y-editor.scrollTop,height:lineHeight,width:2},'secondary-caret');
        }
      }
    }
  }
  function batch(edits){
    if(editor.readOnly)return;
    const p=primary(),ranges=all(),before=snapshot();
    edits=edits.sort((a,b)=>a.start-b.start||a.end-b.end);
    // Combine overlapping deletion regions without applying any bytes twice.
    const clean=[];for(const edit of edits){const last=clean.at(-1);if(last && edit.start<last.end){last.end=Math.max(last.end,edit.end);}else clean.push({...edit,text:edit.text.replace(/\r\n?/g,'\n')});}
    if(!clean.length)return;
    function map(offset){let shift=0;for(const edit of clean){if(offset<edit.start)break;if(offset<=edit.end)return edit.start+shift+edit.text.length;shift+=edit.text.length-(edit.end-edit.start);}return offset+shift;}
    const next=ranges.map(r=>({start:map(r.end),end:map(r.end)})),main=next[ranges.findIndex(r=>r.start===p.start&&r.end===p.end)];
    const begin=clean[0].start,end=clean.at(-1).end,source=editor.value;let text='',at=begin;
    for(const edit of clean){text+=source.slice(at,edit.start)+edit.text;at=edit.end;}text+=source.slice(at,end);
    applying=true;editHints=clean;
    try{write(text,begin,end);set(next,main);if(source!==editor.value)record(clean.map(e=>({...e,removed:source.slice(e.start,e.end)})),before,snapshot());notify();}finally{applying=false;editHints=null;pendingInput=null;}
  }
  const prev=(text,offset)=>offset>1&&/[\uDC00-\uDFFF]/.test(text[offset-1])&&/[\uD800-\uDBFF]/.test(text[offset-2])?offset-2:Math.max(0,offset-1);
  const next=(text,offset)=>offset+1<text.length&&/[\uD800-\uDBFF]/.test(text[offset])&&/[\uDC00-\uDFFF]/.test(text[offset+1])?offset+2:Math.min(text.length,offset+1);
  function insert(text,distribute=false){const ranges=all(),pieces=distribute?text.replace(/\r\n?/g,'\n').split('\n'):[];batch(ranges.map((r,i)=>({...r,text:pieces.length===ranges.length?pieces[i]:text})));}
  editor.addEventListener('pointerdown',e=>{
    if((e.ctrlKey||e.metaKey)&&!e.altKey&&e.button===0){pending=primary();}
    else if(!e.altKey){clear();}
  },true);
  editor.addEventListener('click',e=>{
    if(pending && (e.ctrlKey||e.metaKey)&&!e.altKey){const selected=primary(),prior=pending;pending=null;set([...extra,prior,selected],selected);notify(false);}
  },true);
  editor.addEventListener('beforeinput',e=>{
    if(applying)return;
    if(e.inputType==='historyUndo'||e.inputType==='historyRedo'){pendingHistory={type:e.inputType,text:editor.value,before:snapshot()};return;}
    pendingHistory=null;pendingInput={text:editor.value,before:snapshot()};
    if(!extra.length)return;
    if(e.isComposing || !e.cancelable){clear();status('Composition input uses one cursor.');return;}
    const ranges=all(),text=editor.value,type=e.inputType;let edits;
    if(type==='insertText' && e.data!==null)edits=ranges.map(r=>({...r,text:e.data}));
    else if(type==='insertLineBreak'||type==='insertParagraph')edits=ranges.map(r=>{const before=text.slice(text.lastIndexOf('\n',r.start-1)+1,r.start),indent=before.match(/^\s*/)[0];return {...r,text:'\n'+indent};});
    else if(type.startsWith('delete'))edits=ranges.map(r=>{
      let start=r.start,end=r.end;if(start===end){
        if(type==='deleteContentBackward')start=prev(text,start);
        else if(type==='deleteContentForward')end=next(text,end);
        else if(type==='deleteWordBackward')start-=text.slice(0,start).match(/\s*\S+\s*$/)?.[0].length||0;
        else if(type==='deleteWordForward')end+=text.slice(end).match(/^\s*\S+\s*/)?.[0].length||0;
        else if(/LineBackward$/.test(type))start=text.lastIndexOf('\n',start-1)+1;
        else if(/LineForward$/.test(type)){const at=text.indexOf('\n',end);end=at<0?text.length:at;}
        else return null;
      }return {start,end,text:''};});
    if(!edits || edits.some(edit=>!edit)){clear();return;}
    e.preventDefault();e.stopImmediatePropagation();batch(edits);
  },true);
  editor.addEventListener('input',()=>{
    if(applying)return;
    if(pendingHistory){const state=pendingHistory;pendingHistory=null;restoreHistory(state);pendingInput=null;}
    else if(pendingInput){if((undo.length||redo.length)&&pendingInput.text!==editor.value)record(diff(pendingInput.text,editor.value),pendingInput.before,snapshot());pendingInput=null;}
    else{undo=[];redo=[];}
  },true);
  editor.addEventListener('paste',e=>{if(!extra.length)return;e.preventDefault();e.stopImmediatePropagation();insert(e.clipboardData.getData('text/plain'),true);},true);
  function copy(e,cut){if(!extra.length)return;const selected=all().filter(r=>r.end>r.start);if(!selected.length)return;e.preventDefault();e.stopImmediatePropagation();e.clipboardData.setData('text/plain',selected.map(r=>editor.value.slice(r.start,r.end)).join('\n'));if(cut)batch(selected.map(r=>({...r,text:''})));}
  editor.addEventListener('copy',e=>copy(e,false),true);editor.addEventListener('cut',e=>copy(e,true),true);
  editor.addEventListener('keydown',e=>{
    if((e.ctrlKey||e.metaKey)&&!e.altKey&&e.key.toLowerCase()==='d'){
      e.preventDefault();e.stopImmediatePropagation();const text=editor.value,p=primary();
      if(p.start===p.end){const left=text.slice(0,p.start).match(/[\w@:-]+$/)?.[0].length||0,right=text.slice(p.end).match(/^[\w@:-]+/)?.[0].length||0;set([{start:p.start-left,end:p.end+right}]);}
      else{const query=text.slice(p.start,p.end),existing=all();let at=text.indexOf(query,p.end);
        while(at>=0&&existing.some(r=>r.start===at&&r.end===at+query.length))at=text.indexOf(query,at+query.length);
        if(at<0){at=text.indexOf(query);while(at>=0&&existing.some(r=>r.start===at&&r.end===at+query.length))at=text.indexOf(query,at+query.length);}
        if(at>=0)set([...existing,{start:at,end:at+query.length}],{start:at,end:at+query.length});else status('No more occurrences.');
      }notify(false);return;
    }
    if(!extra.length)return;
    if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();clear();notify(false);return;}
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='a'){clear();return;}
    if(e.key==='Tab'){e.preventDefault();e.stopImmediatePropagation();if(!e.shiftKey)insert('  ');else batch(all().map(r=>{const before=editor.value.slice(0,r.start),length=before.endsWith('\t')?1:before.match(/ {1,2}$/)?.[0].length||0;return {start:r.start-length,end:r.start,text:''};}));return;}
    if(!e.altKey && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key)){
      e.preventDefault();e.stopImmediatePropagation();const text=editor.value,lines=measure(),old=all(),p=primary(),nextRanges=old.map(r=>{
        const anchor=r.direction==='backward'?r.end:r.start,head=r.direction==='backward'?r.start:r.end,pos=position(head),entry=lines[pos.line-1];let target=head;
        if(e.key==='ArrowLeft')target=!e.shiftKey&&r.end>r.start?r.start:(e.ctrlKey||e.metaKey)?head-(text.slice(0,head).match(/\s*\S+\s*$/)?.[0].length||0):prev(text,head);
        if(e.key==='ArrowRight')target=!e.shiftKey&&r.end>r.start?r.end:(e.ctrlKey||e.metaKey)?head+(text.slice(head).match(/^\s*\S+\s*/)?.[0].length||0):next(text,head);
        if(e.key==='Home')target=(e.ctrlKey||e.metaKey)?0:entry.start;
        if(e.key==='End')target=(e.ctrlKey||e.metaKey)?text.length:entry.start+entry.text.length;
        if(e.key==='ArrowUp'||e.key==='ArrowDown'){const line=lines[Math.max(0,Math.min(lines.length-1,pos.line-1+(e.key==='ArrowUp'?-1:1)))];target=line.start+Math.min(pos.column-1,line.text.length);}
        return e.shiftKey?{start:Math.min(anchor,target),end:Math.max(anchor,target),direction:target<anchor?'backward':'forward'}:{start:target,end:target};
      });set(nextRanges,nextRanges[old.findIndex(r=>r.start===p.start&&r.end===p.end)]);notify(false);
    }
  },true);
  editor.addEventListener('scroll',schedule);editor.addEventListener('keyup',schedule);
  new ResizeObserver(schedule).observe(editor);
  return {active:()=>extra.length>0,clear,paint:schedule,ranges:()=>extra.map(r=>({...r})),restore(ranges){set([...ranges,primary()],primary());},hints:()=>editHints};
}
