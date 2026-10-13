// SPDX-License-Identifier: Apache-2.0
// Incremental plain-textarea rendering. Line nodes survive edits elsewhere;
// lexer state propagates across lines only until the unchanged suffix converges.
export function lexLine(text, incoming="") {
  const tokens=[];let state=incoming,i=0;
  const add=(start,end,type)=>{if(end>start)tokens.push({start,end,type});};
  while(i<text.length){
    if(state){
      const start=i;let end=i;
      while(end<text.length){
        if(text[end]==="%")break;
        if(text.startsWith(state,end)){end+=state.length;state="";break;}
        // Escaped delimiters cannot end a math region.
        end+=text[end]==="\\"?Math.min(2,text.length-end):1;
      }
      add(start,end,"math");i=end;
      if(i<text.length && text[i]==="%"){add(i,text.length,"comment");i=text.length;}
      continue;
    }
    const start=i,c=text[i];
    if(c==="%"){add(i,text.length,"comment");break;}
    if(c==="$"){
      const delimiter=text.startsWith("$$",i)?"$$":"$";i+=delimiter.length;
      add(start,i,"math");state=delimiter;continue;
    }
    if(c==="\\"){
      if(text.startsWith("\\[",i)||text.startsWith("\\(",i)){
        state=text[i+1]==="["?"\\]":"\\)";i+=2;add(start,i,"math");continue;
      }
      const verb=text.slice(i).match(/^\\verb\*?([^\w\s])/);
      if(verb){const end=text.indexOf(verb[1],i+verb[0].length);i=end<0?text.length:end+1;add(start,i,"command");continue;}
      const command=text.slice(i).match(/^\\(?:[A-Za-z@]+\*?|[^\r\n])/);
      i+=command?command[0].length:1;add(start,i,"command");continue;
    }
    if("{}[]".includes(c)){add(i,++i,"brace");continue;}
    if(c==="@"){const bib=text.slice(i).match(/^@[A-Za-z]+/);if(bib){i+=bib[0].length;add(start,i,"bib");continue;}}
    i++;
  }
  return {tokens,state};
}

export function createSourceRenderer({editor,highlight,mirror,numbers}) {
  // Drop the static loading placeholder before adding numbered line nodes.
  numbers.replaceChildren();
  let text=null,lines=[],starts=[],textRevision=0,layoutRevision=0,styleKey="",highlightKey="",needsMeasure=false,unwrappedHeight=0;
  const stats={tokenizedLines:0,measuredLines:0,paintedLines:0};
  // Flatten retained line slices so old whole-document strings can be collected
  // after edits in different lines (not retained by substring-backed caches).
  const ownLine=value=>(" "+value).slice(1);
  function create(value){
    const text=ownLine(value);
    const node=document.createElement("div"),gutter=document.createElement("div"),paint=document.createElement("div");
    paint.className="highlight-line";node.textContent=text||"\u200b";
    return {text,node,gutter,paint,height:0,top:0,dirty:true,parsedText:null,incoming:null,outgoing:"",tokens:[],decoration:null};
  }
  function syncText(){
    const next=editor.value;if(next===text)return;
    const nextLines=next.split("\n");let first=0,last=0;
    while(first<lines.length && first<nextLines.length && lines[first].text===nextLines[first])first++;
    while(last<lines.length-first && last<nextLines.length-first && lines[lines.length-1-last].text===nextLines[nextLines.length-1-last])last++;
    const removed=lines.slice(first,lines.length-last),added=nextLines.slice(first,nextLines.length-last).map((value,i)=>{
      const entry=removed[i]||create(value);
      if(entry.text!==value){entry.text=ownLine(value);entry.node.textContent=entry.text||"\u200b";entry.dirty=true;}
      return entry;
    });
    for(const entry of removed.slice(added.length)){entry.node.remove();entry.gutter.remove();entry.paint.remove();}
    const anchor=last?lines[lines.length-last]:null;
    for(const key of ["node","gutter","paint"]){
      const parent=key==="node"?mirror:key==="gutter"?numbers:highlight;
      const fragment=document.createDocumentFragment();
      for(const entry of added)if(entry[key].parentNode!==parent)fragment.append(entry[key]);
      if(fragment.childNodes.length)parent.insertBefore(fragment,anchor?.[key]||null);
    }
    lines.splice(first,removed.length,...added);
    let start=0;starts=[];
    lines.forEach((entry,i)=>{
      starts.push(start);entry.start=start;start+=entry.text.length+1;
      if(!entry.gutter.textContent || (removed.length!==added.length && i>=first))entry.gutter.textContent=i+1;
    });
    text=next;textRevision++;needsMeasure=true;
  }
  function measure(wrapped=true){
    syncText();const css=getComputedStyle(editor);
    const width=editor.clientWidth-parseFloat(css.paddingLeft)-parseFloat(css.paddingRight);
    const nextKey=[width,css.fontFamily,css.fontSize,css.lineHeight,css.tabSize,css.letterSpacing,css.fontVariantLigatures,wrapped].join("|");
    const resized=nextKey!==styleKey;
    if(resized){
      styleKey=nextKey;
      Object.assign(mirror.style,{width:width+"px",fontFamily:css.fontFamily,fontSize:css.fontSize,lineHeight:css.lineHeight,
        tabSize:css.tabSize,letterSpacing:css.letterSpacing,fontVariantLigatures:css.fontVariantLigatures,whiteSpace:wrapped?"pre-wrap":"pre",overflowWrap:wrapped?"break-word":"normal",wordBreak:"normal"});
    }
    if(resized && !wrapped)unwrappedHeight=lines[0].node.getBoundingClientRect().height;
    const dirty=resized?lines:needsMeasure?lines.filter(entry=>entry.dirty):[];
    if(dirty.length){
      // All DOM writes above, then one batch of geometry reads. Unchanged line
      // heights remain valid when a different line changes or new lines are added.
      for(const entry of dirty){entry.height=wrapped?entry.node.getBoundingClientRect().height:unwrappedHeight;stats.measuredLines++;entry.dirty=false;}
      let top=0;for(const entry of lines){entry.top=top;top+=entry.height;}
      for(const entry of dirty)entry.gutter.style.height=entry.height+"px";
      layoutRevision++;
    }
    // Deleting lines can change offsets even if no remaining line needs a read.
    if(lines.revision!==textRevision){let top=0;for(const entry of lines){entry.top=top;top+=entry.height;}layoutRevision++;}
    lines.revision=textRevision;lines.layoutRevision=layoutRevision;needsMeasure=false;return lines;
  }
  function paintLine(entry,tokens,decorations,last){
    const content=entry.text+(last?"\u200b":"\n"),boundaries=new Set([0,content.length]);
    for(const item of [...tokens,...decorations]){boundaries.add(item.start);boundaries.add(item.end);}
    const points=[...boundaries].sort((a,b)=>a-b),fragment=document.createDocumentFragment();let ti=0,di=0;
    for(let i=0;i<points.length-1;i++){
      const start=points[i],end=points[i+1];
      while(ti<tokens.length && tokens[ti].end<=start)ti++;
      while(di<decorations.length && decorations[di].end<=start)di++;
      const classes=[];
      if(tokens[ti]?.start<=start && tokens[ti].end>=end)classes.push("tok-"+tokens[ti].type);
      // Search and bracket ranges may overlap each other.
      for(let d=di;d<decorations.length && decorations[d].start<end;d++)if(decorations[d].start<=start && decorations[d].end>=end)classes.push(decorations[d].type);
      if(classes.length){const span=document.createElement("span");span.className=classes.join(" ");span.textContent=content.slice(start,end);fragment.append(span);}
      else fragment.append(document.createTextNode(content.slice(start,end)));
    }
    entry.paint.replaceChildren(fragment);stats.paintedLines++;
  }
  function render({syntax=true,hits=[],brackets=[],current=null,searchKey=""}={}){
    syncText();const key=[textRevision,syntax,searchKey,current?.start,current?.end,...brackets].join("|");
    if(key===highlightKey)return;highlightKey=key;
    const ranges=[...hits.map(hit=>({...hit,type:"source-hit"+(current?.start===hit.start?" current":"")})),
      ...brackets.map(start=>({start,end:start+1,type:"matching-bracket"}))].sort((a,b)=>a.start-b.start);
    let incoming="",ri=0;
    for(let n=0;n<lines.length;n++){
      const entry=lines[n],last=n===lines.length-1;
      let parsed=false;
      if(syntax && (entry.parsedText!==entry.text || entry.incoming!==incoming)){
        const result=lexLine(entry.text,incoming);entry.tokens=result.tokens;entry.outgoing=result.state;
        entry.parsedText=entry.text;entry.incoming=incoming;stats.tokenizedLines++;parsed=true;
      }
      incoming=syntax?entry.outgoing:"";
      const end=entry.start+entry.text.length+(last?0:1);
      while(ri<ranges.length && ranges[ri].end<=entry.start)ri++;
      const decorations=[];
      for(let r=ri;r<ranges.length && ranges[r].start<end;r++){if(ranges[r].end<=entry.start)continue;decorations.push({
        start:Math.max(0,ranges[r].start-entry.start),end:Math.min(end,ranges[r].end)-entry.start,type:ranges[r].type});}
      const decoration=decorations.length?JSON.stringify([syntax,last,decorations]):syntax+"|"+last;
      if(parsed || entry.paintedText!==entry.text || entry.decoration!==decoration){paintLine(entry,syntax?entry.tokens:[],decorations,last);entry.decoration=decoration;entry.paintedText=entry.text;}
    }
  }
  function position(offset){
    syncText();let low=0,high=starts.length-1;
    while(low<high){const middle=Math.ceil((low+high)/2);if(starts[middle]<=offset)low=middle;else high=middle-1;}
    return {line:low+1,column:offset-starts[low]+1};
  }
  return {measure,render,position,stats};
}
