// SPDX-License-Identifier: Apache-2.0
export function installBuildControls({setLog,api,settingsTarget,files,busy,status,action}) {
  const $=id=>document.getElementById(id);
  let settings={targets:{}},editing=null,jobId=null,cancelPending=false;
  async function load(){settings=await api("/api/settings");}
  async function show(){
    if(busy())return;
    const target=settingsTarget();if(!target){status("Choose a build target first.");return;}
    await load();editing=target;
    const value=settings.targets?.[target]||{};
    $("settingsTitle").textContent="Build settings · "+target;
    $("engineChoice").value=value.engine||"pdflatex";$("stopOnError").checked=!!value.stopOnError;
    $("buildTimeout").value=value.timeout||120;
    $("dependencies").replaceChildren(...files().filter(p=>/\.tex$/i.test(p)&&p!==target).map(path=>{
      const label=document.createElement("label");const checkbox=document.createElement("input");checkbox.type="checkbox";checkbox.value=path;checkbox.checked=(value.dependencies||[]).includes(path);
      label.append(checkbox,document.createTextNode(path));return label;
    }));
    $("settingsError").textContent="";$("buildSettingsDialog").showModal();
  }
  $("settingsClose").onclick=()=> $("buildSettingsDialog").close();
  $("settingsSave").onclick=action(async()=>{
    try{
      settings=await api("/api/settings",{target:editing,options:{engine:$("engineChoice").value,stopOnError:$("stopOnError").checked,timeout:+$("buildTimeout").value,
        dependencies:[...$("dependencies").querySelectorAll("input:checked")].map(c=>c.value)}});
      $("buildSettingsDialog").close();status("Build settings saved for "+editing);
    }catch(e){$("settingsError").textContent=e.message;}
  });
  $("cancelBuild").onclick=action(async()=>{cancelPending=true;if(jobId)await api("/api/build/cancel",{id:jobId});status("Cancelling build…");});
  async function build(target,clean=false){
    cancelPending=false;$("showRawLog").click();$("cancelBuild").classList.remove("hidden");$("cancelBuild").disabled=false;
    try{
      const started=await api("/api/build/start",{target,clean});jobId=started.id;
      if(cancelPending)await api("/api/build/cancel",{id:jobId});
      let previous="",failures=0;
      while(true){
        let state;
        try{state=await api("/api/build?id="+jobId,undefined,{timeout:15000});failures=0;}
        catch(error){
          if(++failures>3)throw Error('Could not reconnect to the build. The server may still be compiling. '+error.message);
          status('Reconnecting to build…');await new Promise(r=>setTimeout(r,1000));continue;
        }
        if(state.output!==previous){previous=state.output;setLog(previous);}
        if(state.state!=="running")return state.result;
        await new Promise(r=>setTimeout(r,180));
      }
    }finally{jobId=null;$("cancelBuild").classList.add("hidden");}
  }
  return {load,show,build};
}
