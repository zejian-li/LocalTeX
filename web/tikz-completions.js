// SPDX-License-Identifier: Apache-2.0
// Lightweight TikZ/xcolor suggestions, including user-defined project symbols.
export const tikzCommands={
  draw:"draw[$1] ($2) -- ($3);",path:"path[$1] ($2) -- ($3);",
  fill:"fill[$1] ($2) rectangle ($3);",filldraw:"filldraw[$1] ($2) circle ($3);",
  node:"node[$1] ($2) at ($3) {$4};",coordinate:"coordinate ($1) at ($2);",
  foreach:"foreach \\$1 in {$2} {\n  $3\n}",tikzset:"tikzset{$1/.style={$2}}",
  tikzstyle:"tikzstyle{$1}=[$2]",usetikzlibrary:"usetikzlibrary{$1}",
  definecolor:"definecolor{$1}{RGB}{$2}",colorlet:"colorlet{$1}{$2}",
  textcolor:"textcolor{$1}{$2}",color:"color{$1}",tikz:"tikz[$1] {$2};",
  clip:"clip ($1) rectangle ($2);",shade:"shade[$1] ($2) rectangle ($3);",
  shadedraw:"shadedraw[$1] ($2) rectangle ($3);",pic:"pic[$1] {$2};"
};
const colors="red green blue cyan magenta yellow black white gray darkgray lightgray brown lime olive orange pink purple teal violet".split(" ");
const keys={
  draw:"draw=$1",fill:"fill=$1",color:"color=$1",text:"text=$1",opacity:"opacity=$1",
  "fill opacity":"fill opacity=$1","draw opacity":"draw opacity=$1",
  "line width":"line width=$1",thin:"thin",thick:"thick","very thick":"very thick","ultra thick":"ultra thick",
  dashed:"dashed",dotted:"dotted",solid:"solid","densely dashed":"densely dashed",
  "rounded corners":"rounded corners=$1",rectangle:"rectangle",circle:"circle",ellipse:"ellipse",
  "minimum width":"minimum width=$1","minimum height":"minimum height=$1","minimum size":"minimum size=$1",
  "inner sep":"inner sep=$1","outer sep":"outer sep=$1",anchor:"anchor=$1",align:"align=$1",
  "text width":"text width=$1",font:"font=$1",scale:"scale=$1",rotate:"rotate=$1",xshift:"xshift=$1",yshift:"yshift=$1",
  above:"above",below:"below",left:"left",right:"right","above right":"above right","below right":"below right",
  "above left":"above left","below left":"below left",
  "above of":"above of=$1","below of":"below of=$1","right of":"right of=$1","left of":"left of=$1",
  "node distance":"node distance=$1","bend left":"bend left=$1","bend right":"bend right=$1",
  "in":"in=$1","out":"out=$1","looseness":"looseness=$1",
  "->":"->","<-":"<-","<->":"<->",">=":">=$1"
};
const libraries="arrows arrows.meta positioning calc shapes shapes.geometric shapes.misc decorations decorations.pathmorphing decorations.markings fit backgrounds matrix patterns plotmarks intersections quotes angles graphs trees chains external".split(" ");
// Anchor names containing spaces need explicit entries.
const anchorNames=["center","north","south","east","west","north east","north west","south east","south west","base","mid","text"];
export function symbols(text) {
  text=text.replace(/(?<!\\)%[^\n]*/g,"");
  const match=regex=>[...text.matchAll(regex)].map(m=>m[1].trim());
  return {
    colors:match(/\\(?:definecolor|providecolor|colorlet)\s*\{([^{}]+)\}/g),
    nodes:[...match(/\\(?:node|coordinate)\b(?:\s*\[[^\]]*\])?\s*\(([^()]+)\)/g),...match(/\bnode(?:\s*\[[^\]]*\])?\s*\(([^()]+)\)/g)],
    styles:[...match(/([^{}\[\],=\n]+?)\/\.(?:style|append style|style args|code|code args)\s*=/g),...match(/\\tikzstyle\s*\{([^{}]+)\}/g)].filter(x=>!x.startsWith("pics/")),
    pics:match(/(?:pics\/|pics\s*=\s*\{\s*)([^{}\n,=]+?)\/\.style/g)
  };
}
export function tikzContext(before,end,explicit) {
  let m=before.match(/\\usetikzlibrary\{([^{}\n]*)$/);
  if(m){const prefix=m[1].split(",").at(-1).trimStart();return {kind:"tikz-library",prefix,start:end-prefix.length,end};}
  m=before.match(/\\(?:color|textcolor|pagecolor|colorbox|fcolorbox)\s*\{([^{}\n]*)$/) ||
    before.match(/\\colorlet\s*\{[^{}]+\}\s*\{([^{}\n]*)$/);
  if(m){const prefix=m[1].split("!").at(-1);return {kind:"tikz-color",prefix,start:end-prefix.length,end};}
  const opening=before.lastIndexOf("\\begin{tikzpicture}"),closing=before.lastIndexOf("\\end{tikzpicture}");
  const line=before.slice(before.lastIndexOf("\n")+1);
  const inTikz=opening>closing || /\\(?:draw|path|filldraw|fill|node|coordinate|tikz|pic|clip|shade|tikzset)\b/.test(line);
  if(!inTikz)return null;
  // Last unmatched square bracket, respecting braces (e.g. font={...}).
  let bracket=-1,brace=0;
  for(let i=0;i<before.length;i++){
    const c=before[i];if(c==="{")brace++;else if(c==="}")brace--;
    else if(c==="[")bracket=i;else if(c==="]")bracket=-1;
  }
  if(bracket>=0) {
    const option=before.slice(bracket+1).split(",").at(-1).trimStart();
    m=option.match(/^(?:draw|fill|color|text|top color|bottom color|left color|right color|ball color|shade)\s*=\s*([^{}]*)$/);
    if(m){const prefix=m[1].split("!").at(-1);return {kind:"tikz-color",prefix,start:end-prefix.length,end};}
    m=option.match(/^(?:above|below|left|right)(?:\s+(?:above|below|left|right))?\s*=\s*(?:.*?\bof\s+)([^{}]*)$/) ||
      option.match(/^(?:above of|below of|left of|right of|fit)\s*=\s*\(?([^{}()]*)$/);
    if(m)return {kind:"tikz-node",prefix:m[1],start:end-m[1].length,end};
    m=option.match(/^anchor\s*=\s*([^{}]*)$/);
    if(m)return {kind:"tikz-anchor",prefix:m[1],start:end-m[1].length,end};
    if(!option.includes("=") && !/[{}\\]/.test(option) && (option||explicit))
      return {kind:"tikz-key",prefix:option,start:end-option.length,end};
  }
  m=before.match(/\(([-\w:]*)(?:\.([a-z ]*))?$/);
  if(m && (m[1]||explicit)) {
    if(m[2]!==undefined)return {kind:"tikz-anchor",prefix:m[2],start:end-m[2].length,end};
    // The first parentheses in a node/coordinate declaration defines a new name.
    if(/\\(?:node|coordinate)(?:\s*\[[^\]]*\])?\s*\([-\w:]*$/.test(line))return null;
    return {kind:"tikz-node",prefix:m[1],start:end-m[1].length,end};
  }
  m=before.match(/\bpic(?:\s*\[[^\]]*\])?(?:\s*\([^()]*\))?\s*\{([^{}\n]*)$/);
  if(m)return {kind:"tikz-pic",prefix:m[1],start:end-m[1].length,end};
  return null;
}
export function tikzCandidates(kind,data) {
  const entries=list=>[...new Set(list)].map(key=>({label:key,key,detail:kind.replace("tikz-","")}));
  if(kind==="tikz-color")return entries([...colors,...data.colors]);
  if(kind==="tikz-node")return entries(data.nodes);
  if(kind==="tikz-anchor")return entries(anchorNames);
  if(kind==="tikz-library")return entries(libraries);
  if(kind==="tikz-pic")return entries(data.pics);
  return [...Object.keys(keys).map(key=>({label:key,key,template:keys[key],detail:"TikZ option"})),
          ...entries(data.styles).map(c=>({...c,detail:"project style"}))];
}
