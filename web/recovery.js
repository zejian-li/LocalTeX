// SPDX-License-Identifier: Apache-2.0
import {sessionStore,localStore,randomId} from "/storage.js";
export function installRecovery({editor,drafts,activePath,api,openFile,changed,status,action}) {
  let root="",slot=sessionStore.getItem("localtex-draft-slot")||randomId(),timer;
  const sender=randomId();let channel;
  const claimed=new Set();
  async function claim() {
    if(typeof BroadcastChannel!=="undefined") {
      channel=new BroadcastChannel("localtex-recovery-tabs");
      channel.onmessage=event=>{
        const m=event.data;
        if(m.slot===slot && m.sender!==sender) {
          if(m.type==="probe")channel.postMessage({type:"occupied",slot,sender});
          else if(m.type==="occupied"){slot=randomId();sessionStore.setItem("localtex-draft-slot",slot);}
        }
      };
      channel.postMessage({type:"probe",slot,sender});await new Promise(r=>setTimeout(r,60));
    }
    sessionStore.setItem("localtex-draft-slot",slot);
  }
  const key=()=> "localtex-recovery:"+root+":"+slot;
  function capture(immediate=false) {
    if(!root||!localStore.available)return;
    const save=()=>{
      let old;
      try{old=JSON.parse(localStore.getItem(key())||"{}");}catch{status("An unreadable browser backup was preserved. Save your work to disk.");return;}
      const pending=new Map((old.entries||[]).map(e=>[e.path,e]));
      for(const [path,d] of drafts()){
        if(d.text!==d.saved){claimed.add(path);pending.set(path,{path,text:d.text,saved:d.saved,version:d.version,start:d.start,end:d.end,time:pending.get(path)?.text===d.text?(pending.get(path).time||old.time):Date.now()});}
        else if(claimed.has(path)){pending.delete(path);claimed.delete(path);}
      }
      const entries=[...pending.values()];
      try {
        if(entries.length)localStore.setItem(key(),JSON.stringify({root,slot,time:Date.now(),entries}));
        else localStore.removeItem(key());
        const count=recovered().length;$("historyBtn").textContent=count?"Recovery "+count:"History";
      } catch{status("Browser draft backup is full or unavailable; save your work to disk.");}
    };
    clearTimeout(timer);if(immediate)save();else timer=setTimeout(save,180);
  }
  function recovered() {
    if(!localStore.available)return [];
    const result=[];
    for(let i=0;i<localStore.length;i++){
      const k=localStore.key(i);if(!k.startsWith("localtex-recovery:"+root+":"))continue;
      try{const data=JSON.parse(localStore.getItem(k));for(const item of data.entries||[])result.push({...item,key:k,time:item.time||data.time,archived:String(data.slot).startsWith("archive-"),otherTab:data.slot!==slot});}catch{}
    }
    return result.sort((a,b)=>b.time-a.time);
  }
  const $=id=>document.getElementById(id);
  let selected=null, request=0, load=0;
  async function inspect(item,mode) {
    selected={item,mode};$("restoreDraft").disabled=true;$("downloadVersion").disabled=false;
    $("recoveryLabel").textContent=item.path+" · "+new Date(item.time*(mode==="snapshot"?1000:1)).toLocaleString();
    $("recoveryPreview").value=item.text||"";
    $("recoveryConflict").classList.add("hidden");
    let disk;
    try{disk=await api("/api/file?path="+encodeURIComponent(item.path));}
    catch{if(selected?.item===item)$("currentPreview").value="Disk file is unavailable. Copy the selected text, or recreate/restore the file before recovering.";return;}
    if(selected?.item!==item)return;
    selected.disk=disk;
    $("currentPreview").value=disk.text;
    $("recoveryUseDisk").checked=false;
    $("recoveryConflict").classList.toggle("hidden",mode!=="draft"||item.version===disk.version);
    $("restoreDraft").disabled=false;
  }
  async function show() {
    capture(true);const generation=++load;request++;$("historyList").replaceChildren();selected=null;$("restoreDraft").disabled=true;$("downloadVersion").disabled=true;
    $("historyDialog").showModal();
    const heading=document.createElement("h3");heading.textContent="Browser drafts · all files in this folder";$("historyList").append(heading);
    $("recoveryPreview").value="";$("currentPreview").value="";$("recoveryLabel").textContent="Choose a draft or snapshot to inspect";
    for(const item of recovered()){
      const row=document.createElement("div");row.className="history-row";
      const button=document.createElement("button");button.textContent="Draft · "+item.path+" · "+new Date(item.time).toLocaleString()+(item.archived?" · preserved before restore":item.otherTab?" · another tab":"");
      button.title=button.textContent;button.onclick=action(()=>{request++;return inspect(item,"draft");});
      const discard=document.createElement("button");discard.textContent="Discard backup";discard.onclick=()=>{
        const stored=JSON.parse(localStore.getItem(item.key)||"{}");
        stored.entries=(stored.entries||[]).filter(x=>x.path!==item.path);
        if(stored.entries.length)localStore.setItem(item.key,JSON.stringify(stored));else localStore.removeItem(item.key);
        row.remove();
      };
      row.append(button,discard);$("historyList").append(row);
    }
    if(activePath()){
      const heading=document.createElement("h3");heading.textContent="Saved versions · "+activePath();$("historyList").append(heading);
      let result;
      try{result=await api("/api/history?path="+encodeURIComponent(activePath()));}
      catch(error){const note=document.createElement("p");note.textContent="Saved history unavailable: "+error.message;$("historyList").append(note);return;}
      if(!$("historyDialog").open || generation!==load)return;
      const {snapshots,unreadable}=result;
      if(unreadable){const note=document.createElement("p");note.textContent=unreadable+" unreadable snapshot(s) preserved on disk; other versions remain available.";$("historyList").append(note);}
      if(!snapshots.length){const note=document.createElement("p");note.textContent="No saved versions yet.";$("historyList").append(note);}
      for(const snapshot of snapshots){
        const button=document.createElement("button");button.className="history-entry";
        button.textContent="Snapshot · "+new Date(snapshot.time*1000).toLocaleString()+" · "+snapshot.path;
        button.title=button.textContent;
        button.onclick=action(async()=>{const ticket=++request;const item=await api("/api/snapshot?path="+encodeURIComponent(snapshot.path)+"&id="+snapshot.id);if(ticket===request && $("historyDialog").open)await inspect(item,"snapshot");});
        $("historyList").append(button);
      }
    }
    if(!$("historyList").children.length)$("historyList").textContent="No recoverable drafts or saved snapshots yet.";
  }
  $("historyClose").onclick=()=> $("historyDialog").close();
  $("historyDialog").addEventListener("close",()=>{request++;load++;selected=null;});
  $("downloadVersion").onclick=()=>{
    if(!selected)return;const link=document.createElement("a");
    link.href=URL.createObjectURL(new Blob([selected.item.text],{type:"text/plain;charset=utf-8"}));
    link.download=selected.item.path.split("/").pop();link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);
  };
  $("restoreDraft").onclick=action(async()=>{
    if(!selected)return;
    const {item,mode,disk}=selected;
    if(!(await openFile(item.path)))return;
    const d=drafts().get(item.path);
    // Preserve any displaced unsaved content before changing the editor or save base.
    if(d.text!==d.saved && d.text!==item.text){
      if(!localStore.available)throw Error("Cannot preserve the current unsaved draft: browser backup is unavailable. Save it to disk before restoring history.");
      const archiveSlot="archive-"+randomId();
      localStore.setItem("localtex-recovery:"+root+":"+archiveSlot,JSON.stringify({root,slot:archiveSlot,time:Date.now(),entries:[{path:item.path,text:d.text,saved:d.saved,version:d.version,start:d.start,end:d.end,time:Date.now()}]}));
    }
    if(d.text!==d.saved && !localStore.available)throw Error("Browser backup failed. Your current draft was kept; save it before restoring history.");
    // Drafts with a changed disk version remain conflicts: preserve their original base.
    const conflicts=mode==="draft" && item.version!==d.version;
    if($("recoveryUseDisk").checked){d.version=disk.version;d.saved=disk.text;}
    else if(conflicts){d.version=item.version;d.saved=item.saved;status("Recovered draft conflicts with the disk file. Compare before saving.");}
    claimed.add(item.path);
    editor.value=item.text;editor.setSelectionRange(Math.min(item.start||0,item.text.length),Math.min(item.end||item.start||0,item.text.length));
    changed({recovery:true});capture(true);$("historyDialog").close();
    if(!conflicts||$("recoveryUseDisk").checked)status("Restored to an unsaved draft; autosave paused. Inspect it, then Save.");
  });
  document.addEventListener("visibilitychange",()=>{if(document.hidden)capture(true);});
  window.addEventListener("pagehide",()=>capture(true));
  return {claim,capture,show,configure(projectRoot){capture(true);root=projectRoot;
    const count=recovered().length;$("historyBtn").textContent=count?"Recovery "+count:"History";},
    remap(oldPath,newPath){for(const item of recovered()){
      if(item.path===oldPath || item.path.startsWith(oldPath+"/")){
        const stored=JSON.parse(localStore.getItem(item.key));for(const entry of stored.entries)if(entry.path===oldPath||entry.path.startsWith(oldPath+"/"))entry.path=newPath+entry.path.slice(oldPath.length);
        localStore.setItem(item.key,JSON.stringify(stored));
      }
    }}
  };
}
