// SPDX-License-Identifier: Apache-2.0
import {tikzCommands,tikzContext,tikzCandidates,symbols} from "/tikz-completions.js";
// Plain-textarea completions: no editor framework or network dependency.
const commands = {
  section:"section{$1}",subsection:"subsection{$1}",subsubsection:"subsubsection{$1}",chapter:"chapter{$1}",
  paragraph:"paragraph{$1}",textbf:"textbf{$1}",textit:"textit{$1}",emph:"emph{$1}",texttt:"texttt{$1}",
  frac:"frac{$1}{$2}",sqrt:"sqrt{$1}",label:"label{$1}",ref:"ref{$1}",eqref:"eqref{$1}",pageref:"pageref{$1}",
  cite:"cite{$1}",citep:"citep{$1}",citet:"citet{$1}",autocite:"autocite{$1}",parencite:"parencite{$1}",textcite:"textcite{$1}",
  includegraphics:"includegraphics[width=$1\\linewidth]{$2}",input:"input{$1}",include:"include{$1}",
  usepackage:"usepackage{$1}",documentclass:"documentclass{$1}",bibliography:"bibliography{$1}",
  addbibresource:"addbibresource{$1}",bibliographystyle:"bibliographystyle{$1}",
  begin:"begin{$1}",end:"end{$1}",item:"item $1",caption:"caption{$1}",
  footnote:"footnote{$1}",url:"url{$1}",href:"href{$1}{$2}",newcommand:"newcommand{\\$1}{$2}",
  renewcommand:"renewcommand{\\$1}{$2}",title:"title{$1}",author:"author{$1}",
  date:"date{$1}",maketitle:"maketitle",tableofcontents:"tableofcontents",printbibliography:"printbibliography",
  hspace:"hspace{$1}",vspace:"vspace{$1}",mbox:"mbox{$1}",mathrm:"mathrm{$1}",mathbf:"mathbf{$1}",
  mathcal:"mathcal{$1}",mathbb:"mathbb{$1}",operatorname:"operatorname{$1}",overline:"overline{$1}",
  underline:"underline{$1}",text:"text{$1}",left:"left",right:"right"
};
for(const name of ("alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi rho sigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega sum prod int iint oint lim infinity infty partial nabla times cdot pm mp leq geq neq approx equiv in subset subseteq supset supseteq forall exists neg land lor to mapsto implies iff dots ldots cdots quad qquad newline noindent centering hfill vfill clearpage newpage").split(" "))commands[name]=name;
Object.assign(commands,tikzCommands);
const environments=("document equation equation* align align* aligned gather gather* multline multline* split itemize enumerate description figure figure* table table* tabular tabular* minipage array matrix pmatrix bmatrix cases center quote quotation verbatim abstract proof theorem lemma definition tikzpicture").split(" ");
export function installAutocomplete({editor,popup,api,edit,enabled,drafts,measure}) {
  let index={citations:[],labels:[],commands:[],environments:[]}, items=[],selected=0,context=null,stops=[],stopIndex=0;
  let request=0,refreshTime=0,previousText="",accepted=false;
  const draftSymbols=new Map();
  const hide=()=>{popup.classList.add("hidden");items=[];editor.removeAttribute("aria-activedescendant");editor.setAttribute("aria-expanded","false");};
  editor.setAttribute("aria-autocomplete","list");editor.setAttribute("aria-controls",popup.id);editor.setAttribute("aria-expanded","false");
  async function refresh() {
    const token=++request;
    try{const result=await api("/api/completions");if(token===request){index=result;refreshTime=Date.now();}}
    catch{} // Suggestions remain usable if indexing is temporarily unavailable.
  }
  function data() {
    const tikz={colors:[],nodes:[],styles:[],pics:[]};
    for(const entry of index.tikz||[])if(!drafts().has(entry.source))
      for(const kind of Object.keys(tikz))tikz[kind].push(...(entry[kind]||[]));
    const citations=new Map(index.citations.filter(c=>!drafts().has(c.source)).map(c=>[c.key,c])),labels=new Set(index.labels),custom=new Set(index.commands),envs=new Set(index.environments||[]);
    for(const source of draftSymbols.keys())if(!drafts().has(source))draftSymbols.delete(source);
    for(const [source,draft] of drafts()) {
      let parsed=draftSymbols.get(source);
      if(!parsed || parsed.text!==draft.text){
        parsed={text:draft.text,citations:[],labels:[],commands:[],environments:[],tikz:{colors:[],nodes:[],styles:[],pics:[]}};
        if(/\.bib$/i.test(source)) {
          for(const m of draft.text.matchAll(/@([a-z]+)\s*[{(]\s*([^\s,{}()]+)\s*,/gi))if(!/^(comment|string|preamble)$/i.test(m[1])){
            const end=draft.text.indexOf("\n@",m.index+m[0].length),body=draft.text.slice(m.index+m[0].length,end<0?undefined:end);
            const entry={key:m[2],source};
            for(const field of ["title","author","year"]){
              const value=body.match(new RegExp(field+'\\s*=\\s*(?:\\{([\\s\\S]*?)\\}\\s*[,}]|"([^"]*)"|(\\d+))',"i"));
              if(value)entry[field]=(value[1]||value[2]||value[3]||"").replace(/[{}\n]/g,"");
            }
            parsed.citations.push(entry);
          }
        } else {
          parsed.tikz=symbols(draft.text);
          for(const m of draft.text.matchAll(/\\(?:newenvironment|renewenvironment|newtheorem)\*?\s*\{([^{}]+)\}/g))parsed.environments.push(m[1]);
          for(const m of draft.text.matchAll(/\\label\s*\{([^{}]+)\}/g))parsed.labels.push(m[1]);
          for(const m of draft.text.matchAll(/\\(?:newcommand|renewcommand|providecommand|DeclareMathOperator)\*?\s*\{?\\([a-zA-Z]+)/g))parsed.commands.push(m[1]);
        }
        draftSymbols.set(source,parsed);
      }
      for(const citation of parsed.citations)citations.set(citation.key,citation);
      for(const label of parsed.labels)labels.add(label);
      for(const command of parsed.commands)custom.add(command);
      for(const environment of parsed.environments)envs.add(environment);
      for(const kind of Object.keys(tikz))tikz[kind].push(...parsed.tikz[kind]);
    }
    return {citations:[...citations.values()],labels:[...labels],commands:[...custom],environments:[...envs],tikz};
  }
  function getContext(explicit) {
    if(!enabled() || editor.readOnly || editor.selectionStart!==editor.selectionEnd)return null;
    const end=editor.selectionStart,before=editor.value.slice(0,end),line=before.slice(before.lastIndexOf("\n")+1);
    if(/(^|[^\\])%/.test(line))return null;
    let m=before.match(/\\(begin|end)\s*\{([^{}\\\n]*)$/);
    if(m)return {kind:"env",prefix:m[2],start:end-m[2].length,end,begin:m[1]==="begin",opening:end-m[0].length};
    m=before.match(/\\([a-zA-Z]*cite[a-zA-Z]*|nocite)\*?(?:\[[^\]\n]*\]){0,2}\{([^{}\n]*)$/);
    if(m) {
      const prefix=m[2].split(",").at(-1).trimStart();
      return {kind:"cite",prefix,start:end-prefix.length,end};
    }
    m=before.match(/\\(?:ref|eqref|pageref|autoref|cref|Cref|vref)\*?\{([^{}\n]*)$/);
    if(m)return {kind:"label",prefix:m[1],start:end-m[1].length,end};
    m=before.match(/\\([a-zA-Z]*)$/);
    if(m && (m[1] || explicit))return {kind:"command",prefix:m[1],start:end-m[0].length,end};
    return tikzContext(before,end,explicit);
  }
  function position() {
    const before=editor.value.slice(0,editor.selectionStart),line=before.split("\n").length-1,column=before.length-before.lastIndexOf("\n")-1;
    const layout=measure(),entry=layout[line],box=editor.getBoundingClientRect(),css=getComputedStyle(editor);
    let x=0,y=entry?.top||0;
    if(entry?.node.firstChild) {
      const range=document.createRange(),node=entry.node.firstChild,pos=Math.min(column,node.textContent.length);
      range.setStart(node,pos);range.collapse(true);
      let rect=range.getBoundingClientRect();
      if(!rect.height && pos>0){range.setStart(node,pos-1);range.setEnd(node,pos);rect=range.getBoundingClientRect();x=rect.right-entry.node.getBoundingClientRect().left;}
      else x=rect.left-entry.node.getBoundingClientRect().left;
      y+=rect.top-entry.node.getBoundingClientRect().top;
    }
    const left=box.left+parseFloat(css.paddingLeft)+x-editor.scrollLeft;
    const top=box.top+parseFloat(css.paddingTop)+y-editor.scrollTop+parseFloat(css.lineHeight);
    popup.style.left=Math.max(8,Math.min(left,innerWidth-popup.offsetWidth-8))+"px";
    popup.style.top=Math.max(8,Math.min(top,innerHeight-popup.offsetHeight-8))+"px";
  }
  function render() {
    popup.replaceChildren();
    items.forEach((item,i)=>{
      const row=document.createElement("div");row.id="completion-"+i;row.className="completion-item";row.setAttribute("role","option");
      row.setAttribute("aria-selected",i===selected);row.classList.toggle("selected",i===selected);
      const key=document.createElement("span");key.textContent=item.label;
      const detail=document.createElement("small");detail.textContent=item.detail||context.kind;row.title=item.detail||item.label;
      row.append(key,detail);
      row.addEventListener("pointerdown",e=>{e.preventDefault();selected=i;accept();});
      popup.append(row);
    });
    editor.setAttribute("aria-expanded","true");editor.setAttribute("aria-activedescendant","completion-"+selected);
    popup.classList.remove("hidden");position();popup.children[selected]?.scrollIntoView({block:"nearest"});
  }
  function show(explicit=false) {
    context=getContext(explicit);
    if(!context){hide();return;}
    const d=data(),prefix=context.prefix.toLowerCase();
    let candidates;
    if(context.kind==="command")
      candidates=[...new Set([...Object.keys(commands),...d.commands])].map(key=>({label:"\\"+key,key,template:"\\"+(commands[key]||key)}));
    else if(context.kind==="env")candidates=[...new Set([...environments,...d.environments])].map(key=>({label:key,key}));
    else if(context.kind==="cite")candidates=d.citations.map(c=>({label:c.key,key:c.key,detail:[c.author,c.title].filter(Boolean).join(" · ")||c.source,search:[c.key,c.title,c.author,c.year].filter(Boolean).join(" ").toLowerCase()}));
    else if(context.kind.startsWith("tikz-"))candidates=tikzCandidates(context.kind,d.tikz);
    else candidates=d.labels.map(key=>({label:key,key}));
    items=candidates.filter(c=>c.key.toLowerCase().startsWith(prefix)||(context.kind==="cite"&&c.search?.includes(prefix))).sort((a,b)=>a.key.localeCompare(b.key)).slice(0,60);
    if(!items.length){hide();return;}
    selected=0;render();
  }
  function insert(template,start,end) {
    const positions=[];
    let output="",last=0;
    for(const m of template.matchAll(/\$(\d+)/g)) {
      output+=template.slice(last,m.index);positions.push({number:+m[1],start:start+output.length,end:start+output.length});
      last=m.index+m[0].length;
    }
    output+=template.slice(last);hide();accepted=true;edit(output,start,end);accepted=false;
    stops=positions.sort((a,b)=>a.number-b.number);
    if(stops.length)stops.push({number:Infinity,start:start+output.length,end:start+output.length});
    stopIndex=0;
    if(stops.length)editor.setSelectionRange(stops[0].start,stops[0].end);
    previousText=editor.value;
  }
  function accept() {
    const choice=items[selected];if(!choice||!context)return;
    const c=context;
    if(c.kind.startsWith("tikz-")) {
      const tail=editor.value.slice(c.end);
      const template=choice.template||choice.key;
      insert(tail.startsWith("=")&&choice.template?choice.key:template,c.start,c.end);
    } else if(c.kind==="command") {
      // Existing braces should not be duplicated.
      const template=editor.value[c.end]==="{"?choice.label:choice.template;
      insert(template,c.start,c.end);
      if(choice.key==="begin" || choice.key==="end")show(true);
    } else if(c.kind==="env" && c.begin) {
      const end=c.end+(editor.value[c.end]==="}"?1:0);
      const before=editor.value.slice(0,c.opening),indent=before.slice(before.lastIndexOf("\n")+1).match(/^[ \t]*/)[0];
      const tail=editor.value.slice(end),closing="\\end{"+choice.key+"}";
      if(tail.trimStart().startsWith(closing))insert(choice.key+(editor.value[c.end]==="}"?"":"}"),c.start,c.end);
      else {
        const argumentsText=choice.key==="tabular*"?"{\\linewidth}{$1}":
          ["tabular","array"].includes(choice.key)?"{$1}":choice.key==="minipage"?"{$1\\linewidth}":"";
        insert("\\begin{"+choice.key+"}"+argumentsText+"\n"+indent+"  "+(argumentsText?"$2":"$1")+"\n"+indent+closing,c.opening,end);
      }
    } else if(c.kind==="env") {
      const before=editor.value.slice(0,c.opening),lineStart=before.lastIndexOf("\n")+1;
      let start=c.start,template=choice.key+(editor.value[c.end]==="}"?"":"}");
      if(!before.slice(lineStart).trim()) {
        const stack=[];
        for(const m of before.matchAll(/\\(begin|end)\{([^{}]+)\}/g)) {
          if(m[1]==="begin")stack.push(m);
          else {const at=stack.findLastIndex(open=>open[2]===m[2]);if(at>=0)stack.splice(at,1);}
        }
        const opening=stack.findLast(m=>m[2]===choice.key);
        if(opening) {
          const indent=before.slice(before.lastIndexOf("\n",opening.index)+1,opening.index).match(/^[ \t]*/)[0];
          start=lineStart;template=indent+"\\end{"+choice.key+(editor.value[c.end]==="}"?"":"}");
        }
      }
      insert(template,start,c.end);
    } else {
      // Brace-bearing command snippets already have their closing delimiter.
      const tail=editor.value.slice(c.end).split("\n")[0];
      insert(choice.key+(tail.includes("}")?"":"}"),c.start,c.end);
    }
  }
  function indentEnter(e) {
    if(!enabled() || e.ctrlKey || e.metaKey || e.altKey || editor.readOnly)return false;
    const start=editor.selectionStart,end=editor.selectionEnd;
    const before=editor.value.slice(0,start),line=before.slice(before.lastIndexOf("\n")+1),indent=line.match(/^[ \t]*/)[0];
    const opening=line.match(/\\begin\{([^{}]+)\}\s*$/);
    let padding=indent+(opening?"  ":"");
    let text="\n"+padding;
    const tail=editor.value.slice(end);
    const close=opening && new RegExp("^\\s*\\\\end\\{"+opening[1].replace(/[.*+?^$(){}|[\]\\]/g,"\\$&")+"\\}").test(tail);
    if(close && !tail.startsWith("\n")) {
      const whitespace=tail.match(/^[ \t]*/)[0];
      text+="\n"+indent;
      edit(text,start,end+whitespace.length);editor.setSelectionRange(start+1+padding.length,start+1+padding.length);
    } else edit(text,start,end);
    stops=[];hide();return true;
  }
  editor.addEventListener("keydown",e=>{
    if(e.isComposing)return;
    if(!enabled()){stops=[];hide();return;}
    if((e.ctrlKey||e.metaKey) && e.code==="Space") {
      e.preventDefault();e.stopImmediatePropagation();show(true);
      if(Date.now()-refreshTime>3000)refresh().then(()=>show(true));
      return;
    }
    if(e.ctrlKey||e.metaKey||e.altKey){hide();return;}
    let handled=false;
    if(items.length) {
      if(e.key==="ArrowDown" || e.key==="ArrowUp"){selected=(selected+(e.key==="ArrowDown"?1:-1)+items.length)%items.length;render();handled=true;}
      else if((e.key==="Enter" || e.key==="Tab")&&!e.shiftKey){accept();handled=true;}
      else if(e.key==="Escape"){hide();handled=true;}
      else if(["ArrowLeft","ArrowRight","Home","End"].includes(e.key))hide();
    } else if(e.key==="Tab" && stops.length) {
      const next=stopIndex+(e.shiftKey?-1:1);
      if(next>=0 && next<stops.length){stopIndex=next;editor.setSelectionRange(stops[next].start,stops[next].end);handled=true;}
      else stops=[];
    } else if(e.key==="Escape")stops=[];
    if(!handled && e.key==="Enter")handled=indentEnter(e);
    if(handled){e.preventDefault();e.stopImmediatePropagation();}
  },true);
  editor.addEventListener("input",e=>{
    if(accepted)return;
    if(stops.length) {
      const old=previousText,newText=editor.value,delta=newText.length-old.length,current=stops[stopIndex];
      let first=0;while(first<old.length && first<newText.length && old[first]===newText[first])first++;
      if(first>=current.start && first<=current.end && editor.selectionStart<=current.end+Math.max(0,delta)) {
        current.end+=delta;for(let i=stopIndex+1;i<stops.length;i++){stops[i].start+=delta;stops[i].end+=delta;}
      } else stops=[];
    }
    previousText=editor.value;
    if(!e.isComposing)show();
  });
  editor.addEventListener("compositionend",()=>show());
  editor.addEventListener("blur",hide);editor.addEventListener("scroll",()=>{if(items.length)position();});editor.addEventListener("wheel",hide,{passive:true});
  editor.addEventListener("pointerdown",()=>{stops=[];hide();});
  window.addEventListener("resize",hide);
  return {refresh,dismiss(){stops=[];hide();},reset(){request++;draftSymbols.clear();index={citations:[],labels:[],commands:[],environments:[]};stops=[];hide();}};
}
