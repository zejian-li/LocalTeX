// SPDX-License-Identifier: Apache-2.0
import {chooseProject,showDependencyStatus} from '/file-picker.js';
const list=document.getElementById("recentProjects"),status=document.getElementById("homeStatus");
let busy=false;
async function api(url,data) {
  const response=await fetch(url,{headers:{"Content-Type":"application/json"},...(data?{method:"POST",body:JSON.stringify(data)}:{})});
  const result=await response.json();if(!response.ok)throw Error(result.error||response.statusText);return result;
}
async function open(endpoint,data,newTab=false) {
  if(busy)return;
  // Reserve synchronously, while the browser still recognizes the click gesture.
  const tab=newTab?window.open("about:blank","_blank"):null;
  if(newTab && !tab){status.textContent="Allow popups to open a project in a new tab.";return;}
  if(tab)tab.opener=null;
  busy=true;document.querySelectorAll(".home-actions button,.recent-project button").forEach(b=>b.disabled=true);
  status.textContent=endpoint.endsWith("/open")?"Choose a file or folder in the native picker…":"Opening project…";
  try {
    const result=endpoint.endsWith('/open')?await chooseProject(api,data.kind,!!data.web):await api(endpoint,data);
    if(result.cancelled){tab?.close();status.textContent="Open cancelled.";return;}
    const url="/editor?project="+encodeURIComponent(result.projectId);
    if(tab){tab.location.replace(url);status.textContent="Opened in a new tab.";await refresh();}
    else location.assign(url);
  } catch(e){tab?.close();status.textContent=e.message;}
  finally{busy=false;document.querySelectorAll(".home-actions button,.recent-project button").forEach(b=>b.disabled=false);}
}
async function refresh() {
  const {projects}=await api("/api/projects");
  list.replaceChildren();
  if(!projects.length){list.textContent="No recent projects yet. Open a file or folder to begin.";return;}
  for(const project of projects) {
    const row=document.createElement("div");row.className="recent-project";
    const button=document.createElement("button");button.className="recent-open";
    const name=document.createElement("strong");name.textContent=project.name;
    const path=document.createElement("span");path.textContent=project.path;
    const main=document.createElement("small");main.textContent=project.main||"Empty project";
    button.append(name,path,main);button.onclick=()=>open("/api/project/recent",{id:project.id});
    const extra=document.createElement("button");extra.textContent="Open in new tab";
    extra.onclick=()=>open("/api/project/recent",{id:project.id},true);
    row.append(button,extra);list.append(row);
  }
}
document.getElementById("homeOpenFile").onclick=()=>open("/api/project/open",{kind:"file"});
document.getElementById("homeOpenFolder").onclick=()=>open("/api/project/open",{kind:"folder"});
document.getElementById("homeBrowseServer").onclick=()=>open("/api/project/open",{kind:"folder",web:true});
const zipInput=document.getElementById('projectZip');
document.getElementById('homeImportZip').onclick=()=>{if(!busy)zipInput.click();};
zipInput.onchange=async()=>{
  const file=zipInput.files[0];zipInput.value='';if(!file||busy)return;
  if(!file.name.toLowerCase().endsWith('.zip')){status.textContent='Choose a .zip project archive.';return;}
  if(!file.size||file.size>50*1024*1024){status.textContent='Project ZIP must be between 1 byte and 50 MiB.';return;}
  busy=true;document.querySelectorAll('.home-actions button,.recent-project button').forEach(b=>b.disabled=true);
  status.textContent='Uploading and checking project ZIP…';
  try{
    const response=await fetch('/api/project/import?name='+encodeURIComponent(file.name),{method:'POST',headers:{'Content-Type':'application/zip'},body:file});
    const result=await response.json();if(!response.ok)throw Error(result.error||response.statusText);
    location.assign('/editor?project='+encodeURIComponent(result.projectId));
  }catch(e){status.textContent=e.message;}
  finally{busy=false;document.querySelectorAll('.home-actions button,.recent-project button').forEach(b=>b.disabled=false);}
};
api('/api/capabilities').then(c=>{document.getElementById('importDestination').textContent='ZIP imports are saved on the server in '+c.workspace+'. Existing names receive a number. Maximum ZIP size: 50 MiB.';}).catch(e=>status.textContent=e.message);
refresh().catch(e=>status.textContent=e.message);
showDependencyStatus(api,document.getElementById('setupNotice'),[document.getElementById('homeOpenFile'),document.getElementById('homeOpenFolder')]).catch(e=>status.textContent=e.message);
window.addEventListener("focus",()=>{if(!busy)refresh().catch(()=>{});});
