// SPDX-License-Identifier: Apache-2.0
export function installDiagnostics({editor,activePath,drafts,openFile,jump,measure,status,action,onView=()=>{}}) {
  const $=id=>document.getElementById(id),pageSize=200;
  let records=[],snapshots=new Map(),target=null,filter='all',raw=false;
  let revision=0,markerKey='',renderKey='',marked=new Set(),markersCache=[],frame=0,shown=pageSize;
  let errorsByPath=new Map(),paths=[],groups={all:[],error:[],warning:[]};
  const editable=path=>/\.(tex|tikz|bib|sty|cls|txt|md|cfg|def|bst)$/i.test(path||'');
  function stale(path) {return snapshots.has(path) && drafts().get(path)?.text!==snapshots.get(path);}
  function clearMarkers() {
    $('diagnosticLayer').replaceChildren();markersCache=[];
    for(const gutter of marked){gutter.classList.remove('line-error','line-warning');gutter.removeAttribute('title');}marked.clear();
  }
  function markers() {
    const path=activePath(),outdated=stale(path),relevant=outdated?null:errorsByPath.get(path);
    if(!relevant?.length){if(markerKey!=='empty'){clearMarkers();markerKey='empty';}return;}
    const lines=measure(),top=parseFloat(getComputedStyle(editor).paddingTop)||0;
    const scroll=editor.scrollTop,bottom=scroll+editor.clientHeight;
    // Error lines are indexed once per build. Only visit the visible slice.
    let low=0,high=relevant.length;
    while(low<high){const mid=(low+high)>>1,entry=lines[relevant[mid].number-1];
      if(entry && top+entry.top+entry.height<scroll)low=mid+1;else high=mid;}
    const visible=[];
    for(let i=low;i<relevant.length;i++){
      const record=relevant[i],entry=lines[record.number-1];if(!entry)break;
      if(top+entry.top>bottom)break;visible.push({record,entry});
    }
    const key=[path,revision,lines.layoutRevision,top,...visible.map(v=>v.record.number)].join('|');
    if(key!==markerKey){
      markerKey=key;clearMarkers();const fragment=document.createDocumentFragment();
      for(const {record,entry} of visible){
        const gutter=entry.gutter;if(gutter){marked.add(gutter);gutter.classList.add('line-error');gutter.title=record.message;}
        const marker=document.createElement('div');marker.className='diagnostic-line error';marker.style.height=entry.height+'px';
        fragment.append(marker);markersCache.push({marker,top:top+entry.top});
      }
      $('diagnosticLayer').append(fragment);
    }
    for(const entry of markersCache)entry.marker.style.top=(entry.top-scroll)+'px';
  }
  function update(){if(!frame)frame=requestAnimationFrame(()=>{frame=0;markers();});}
  function render() {
    // A file's stale state is checked once, rather than once per warning.
    const stalePaths=new Set(paths.filter(stale));
    const key=[revision,target,filter,shown,...stalePaths].join('|');
    if(key===renderKey){update();return;}renderKey=key;
    const errors=groups.error.length,warnings=groups.warning.length;
    $('problemSummary').textContent=target?target+' · '+errors+' errors · '+warnings+' warnings':'No compilation yet';
    $('logBtn').textContent=records.length?'Problems '+records.length:'Log';$('logBtn').classList.toggle('has-errors',errors>0);
    const list=$('problemList'),scroll=list.scrollTop,fragment=document.createDocumentFragment(),selected=groups[filter]||records;
    for(const d of selected.slice(0,shown)) {
      const row=document.createElement('button');row.className='problem-row '+d.severity;
      const title=document.createElement('span');title.className='problem-message';title.textContent=d.message;
      const location=document.createElement('small');
      location.textContent=(d.path||'Build')+(d.line?':'+d.line+(d.endLine?'–'+d.endLine:''):'')+
        (stalePaths.has(d.path)?' · source changed; recompile':'')+(d.path&&!editable(d.path)?' · generated file; see raw log':'');
      row.append(title,location);row.onclick=action(async()=>{
        if(!d.path||!editable(d.path)){raw=true;view();return;}
        if(await openFile(d.path)){jump(d.line||1,1);status(stale(d.path)?'Source changed since this build; recompile to update line numbers.':d.message);update();}
      });fragment.append(row);
    }
    if(selected.length>shown){const more=document.createElement('button');more.className='problem-more';more.textContent='Show next '+Math.min(pageSize,selected.length-shown)+' ('+shown+' of '+selected.length+' shown)';more.onclick=()=>{shown+=pageSize;render();};fragment.append(more);}
    list.replaceChildren(fragment);if(!selected.length)list.textContent=target?'No matching problems reported.':'Compile a document to see its errors and warnings.';
    list.scrollTop=scroll;view();update();
  }
  function view() {
    $('problemList').classList.toggle('hidden',raw);$('console').classList.toggle('hidden',!raw);
    $('showProblems').setAttribute('aria-pressed',!raw);$('showRawLog').setAttribute('aria-pressed',raw);$('problemFilter').classList.toggle('hidden',raw);onView(raw);
  }
  $('showProblems').onclick=()=>{raw=false;view();};$('showRawLog').onclick=()=>{raw=true;view();};
  $('problemFilter').onchange=e=>{filter=e.target.value;shown=pageSize;render();};
  return {
    set(result,sourceSnapshots,{keepRaw=false}={}){
      revision++;records=[...(result.diagnostics||[])].sort((a,b)=>(a.severity==='error'?0:1)-(b.severity==='error'?0:1));
      groups={all:records,error:records.filter(d=>d.severity==='error'),warning:records.filter(d=>d.severity!=='error')};
      paths=[...new Set(records.map(d=>d.path))];errorsByPath=new Map();
      for(const d of groups.error){if(!d.path||!Number.isInteger(d.line)||d.line<1)continue;
        let index=errorsByPath.get(d.path);if(!index){index=new Map();errorsByPath.set(d.path,index);}
        const end=Number.isInteger(d.endLine)?d.endLine:d.line;
        for(let number=d.line;number<=Math.min(end,d.line+300);number++){
          // One overlay per line even when the log reports it many times.
          if(!index.has(number))index.set(number,{number,message:String(d.message).slice(0,2000)});
        }
      }
      for(const [path,index] of errorsByPath)errorsByPath.set(path,[...index.values()].sort((a,b)=>a.number-b.number));
      target=result.target;snapshots=sourceSnapshots;filter='all';shown=pageSize;$('problemFilter').value=filter;raw=keepRaw;render();
    },
    reset(){revision++;records=[];groups={all:[],error:[],warning:[]};paths=[];errorsByPath.clear();target=null;snapshots.clear();shown=pageSize;render();},
    update,render
  };
}
