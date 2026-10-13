// SPDX-License-Identifier: Apache-2.0
export function installNavigation({editor,api,activePath,buildTarget,drafts,openFile,jump,edit,save,refresh,selected,busy,renameState,status,action,highlightBrackets}) {
  const $=id=>document.getElementById(id);let sequence=0,timer,mode="text",cachedSymbols=[];
  const overrides=()=>Object.fromEntries([...drafts()].map(([p,d])=>[p,d.text]));
  function row(label,detail,callback){
    const b=document.createElement("button");b.className="project-result";
    const name=document.createElement("span");name.textContent=label;const small=document.createElement("small");small.textContent=detail;
    b.append(name,small);b.onclick=action(callback);$("projectResults").append(b);
  }
  async function search(){
    const token=++sequence,query=$("projectQuery").value,caseSensitive=$("projectCase").getAttribute("aria-pressed")==="true";
    mode=$("navigationMode").value;
    $("projectSearchStatus").textContent="Searching…";
    try{
      if(mode==="text"){
        const result=await api("/api/search",{query,caseSensitive,drafts:overrides()});if(token!==sequence)return;
        $("projectResults").replaceChildren();
        for(const hit of result.matches)row(hit.text,hit.path+":"+hit.line,async()=>{
          $("projectSearchDialog").close();if(await openFile(hit.path))jump(hit.line,hit.column);
        });
        $("projectSearchStatus").textContent=result.matches.length+" matches"+(result.truncated?" · limited to first 500":"");
      }else{
        const {symbols}=await api("/api/symbols",{drafts:overrides()});if(token!==sequence)return;cachedSymbols=symbols;
        const compare=s=>caseSensitive?s:s.toLowerCase(),needle=compare(query);
        const found=symbols.filter(s=>s.kind===mode && compare([s.key,s.title,s.author,s.year].filter(Boolean).join(" ")).includes(needle));
        $("projectResults").replaceChildren();
        for(const symbol of found.slice(0,500))row(symbol.key+(symbol.title?" — "+symbol.title:""),[symbol.author,symbol.year,symbol.path+":"+symbol.line].filter(Boolean).join(" · "),async()=>{
          $("projectSearchDialog").close();if(await openFile(symbol.path))jump(symbol.line,1);
        });
        $("projectSearchStatus").textContent=found.length+" "+mode+" entries · click to open definition";
      }
    }catch(e){if(token===sequence)$("projectSearchStatus").textContent=e.message;}
  }
  function show(initialMode="text",query=null){
    if(query===null)query=initialMode==="text"?editor.value.slice(editor.selectionStart,editor.selectionEnd):"";
    $("navigationMode").value=initialMode;$("projectQuery").value=query;
    $("projectSearchDialog").showModal();$("projectQuery").focus();$("projectQuery").select();search();
  }
  $("projectQuery").oninput=()=>{clearTimeout(timer);timer=setTimeout(search,180);};
  $("projectQuery").onkeydown=e=>{if(e.key==="Enter"){e.preventDefault();search();}};
  $("navigationMode").onchange=search;
  $("projectCase").onclick=()=>{const b=$("projectCase");b.setAttribute("aria-pressed",b.getAttribute("aria-pressed")!=="true");search();};
  $("projectSearchClose").onclick=()=>{$("projectSearchDialog").close();sequence++;};
  async function definition(){
    const pos=editor.selectionStart,text=editor.value;
    const pattern=/\\(input|include|ref|eqref|pageref|autoref|cref|Cref|cite|citep|citet|autocite|parencite|textcite)\*?(?:\[[^\]]*\]){0,2}\{([^{}]+)\}/g;
    let match=[...text.matchAll(pattern)].find(m=>pos>=m.index && pos<=m.index+m[0].length);
    if(match){
      const command=match[1],key=match[2].split(",")[0].trim();
      if(["input","include"].includes(command)){
        const base=activePath().split("/").slice(0,-1).join("/");
        const targetBase=(buildTarget()||activePath()).split("/").slice(0,-1).join("/");
        const normalize=path=>{
          const parts=[];for(const part of path.split("/")){if(part==="."||!part)continue;if(part===".."){if(!parts.length)return null;parts.pop();}else parts.push(part);}return parts.join("/");
        };
        const candidates=[(targetBase?targetBase+"/":"")+key,(base?base+"/":"")+key,key].map(normalize).filter(Boolean).flatMap(p=>/\.[a-z]+$/i.test(p)?[p]:[p,p+".tex"]);
        const entries=await api("/api/files");
        const found=candidates.find(p=>entries.files.includes(p));
        if(found){await openFile(found);jump(1,1);return;}
        status("Included file not found inside this project.");return;
      }
      show(command.toLowerCase().includes("cite")?"citation":"label",key);return;
    }
    const commands=[...text.matchAll(/\\([a-zA-Z]+)/g)].find(m=>pos>=m.index && pos<=m.index+m[0].length);
    if(commands)show("command",commands[1]);
    else status("Put the cursor on an input, reference, citation or custom command.");
  }
  function rename(){
    if(busy())return;
    const item=selected();if(!item.path){status("Select a file or folder to move.");return;}
    $("renameSource").textContent=item.path;$("renamePath").value=item.path;$("renameError").textContent="";
    $("renameDialog").showModal();$("renamePath").focus();$("renamePath").select();
  }
  $("renameClose").onclick=()=> $("renameDialog").close();
  $("renameSave").onclick=action(async()=>{
    if(busy())return;
    try{
      await save();
      const old=$("renameSource").textContent,next=$("renamePath").value.replace(/\\/g,"/");
      await api("/api/rename",{path:old,newPath:next});await renameState(old,next);await refresh();
      $("renameDialog").close();status("Moved to "+next+". Update any TeX paths that refer to it.");
    }catch(e){$("renameError").textContent=e.message;}
  });
  function lineOperation(kind){
    if(editor.readOnly)return;
    const text=editor.value,start=editor.selectionStart,end=editor.selectionEnd;
    const first=(start===0?0:text.lastIndexOf("\n",start-1)+1);
    let last=text.indexOf("\n",end>start&&text[end-1]==="\n"?end-1:end);if(last<0)last=text.length;
    const block=text.slice(first,last);
    if(kind==="duplicate"){
      edit(block+"\n"+block,first,last);editor.setSelectionRange(first+block.length+1,first+block.length+1+block.length);
    }else if(kind==="up" && first>0){
      const previous=text.lastIndexOf("\n",first-2)+1,previousText=text.slice(previous,first-1);
      edit(block+"\n"+previousText,previous,last);editor.setSelectionRange(previous+start-first,previous+end-first);
    }else if(kind==="down" && last<text.length){
      let next=text.indexOf("\n",last+1);if(next<0)next=text.length;
      const nextText=text.slice(last+1,next),offset=nextText.length+1;
      edit(nextText+"\n"+block,first,next);editor.setSelectionRange(start+offset,end+offset);
    }
  }
  editor.addEventListener("keydown",e=>{
    if(e.key==="F12" || (e.ctrlKey&&e.key==="b")){e.preventDefault();e.stopImmediatePropagation();action(definition)();}
    else if(e.altKey&&e.shiftKey && e.key.toLowerCase()==="d"){e.preventDefault();e.stopImmediatePropagation();lineOperation("duplicate");}
    else if(e.altKey && !e.shiftKey && ["ArrowUp","ArrowDown"].includes(e.key)){e.preventDefault();e.stopImmediatePropagation();lineOperation(e.key==="ArrowUp"?"up":"down");}
  },true);
  editor.addEventListener("click",e=>{if(e.altKey&&!(e.ctrlKey||e.metaKey))action(definition)();});
  function brackets(){
    const text=editor.value,pos=editor.selectionStart;
    let at=/[()[\]{}]/.test(text[pos]||"")?pos:/[()[\]{}]/.test(text[pos-1]||"")?pos-1:-1;
    if(at<0 || (at>0&&text[at-1]==="\\")){highlightBrackets([]);return;}
    const pairs={"(":")","[":"]","{":"}"};const char=text[at],forward=!!pairs[char],other=forward?pairs[char]:Object.keys(pairs).find(k=>pairs[k]===char);
    let depth=0,found=-1;
    for(let i=at;i>=0&&i<text.length;i+=forward?1:-1){
      if(i>0&&text[i-1]==="\\")continue;
      if(text[i]===char)depth++;if(text[i]===other&&--depth===0){found=i;break;}
    }
    highlightBrackets(found>=0?[at,found]:[at]);
    if(found>=0){
      const line=text.slice(0,found).split("\n").length,col=found-text.lastIndexOf("\n",found-1);
      $("bracketStatus").textContent="Bracket ↔ "+line+":"+col;
    }else $("bracketStatus").textContent="Unmatched bracket";
    $("bracketStatus").onclick=()=>{if(found>=0){editor.focus();editor.setSelectionRange(found,found+1);}};
  }
  editor.addEventListener("keyup",()=>{$("bracketStatus").textContent="";brackets();});
  editor.addEventListener("click",()=>{$("bracketStatus").textContent="";brackets();});
  return {show,rename,definition};
}
