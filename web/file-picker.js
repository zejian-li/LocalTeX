// SPDX-License-Identifier: Apache-2.0
// Browses the server filesystem; no desktop or browser filesystem permission needed.
export async function pickServer(api,{kind='folder',initial='',reason=''}={}) {
  const dialog=document.createElement('dialog');dialog.className='server-picker';
  dialog.innerHTML='<form method="dialog"><h2>Browse server files</h2><p class="muted">These files are on the computer running LocalTeX.</p><div class="picker-path"><button type="button" data-up>↑</button><input aria-label="Server directory" placeholder="Absolute server directory"><button type="button" data-go>Go</button></div><div class="picker-roots"></div><div class="picker-files"></div><p class="picker-error" role="status"></p><div class="dialog-actions"><button type="button" data-folder>New folder</button><button type="button" data-file>New .tex</button><button value="cancel">Cancel</button><button type="button" class="primary" data-open>Open folder</button></div></form>';
  if(reason){const note=document.createElement('p');note.className='picker-notice';note.textContent=reason;dialog.querySelector('.muted').after(note);}
  document.body.append(dialog);const path=dialog.querySelector('input'),list=dialog.querySelector('.picker-files'),error=dialog.querySelector('.picker-error'),open=dialog.querySelector('[data-open]');let current='',selected=null,request=0,busy=false;
  const result=new Promise(resolve=>{
    dialog.addEventListener('close',()=>{dialog.remove();resolve(dialog.returnValue==='picked'?selected:null);});
  });
  async function browse(value){const sequence=++request;error.textContent='Loading…';try{
    const data=await api('/api/browse'+(value?'?path='+encodeURIComponent(value):''));if(sequence!==request)return;
    current=data.path;path.value=current;selected=null;open.textContent='Open folder';open.disabled=false;error.textContent='';list.replaceChildren();
    const roots=dialog.querySelector('.picker-roots');roots.replaceChildren();for(const root of data.roots){const b=document.createElement('button');b.type='button';b.textContent=root;b.onclick=()=>browse(root);roots.append(b);}
    dialog.querySelector('[data-up]').onclick=()=>browse(data.parent);
    for(const entry of data.entries){const b=document.createElement('button');b.type='button';b.textContent=(entry.directory?'▸ ':'')+entry.name;b.title=entry.path;b.className='picker-entry';
      b.onclick=()=>{if(entry.directory)browse(entry.path);else{selected=entry.path;open.textContent='Open file';for(const row of list.children)row.classList.toggle('selected',row===b);}};
      b.ondblclick=()=>{if(!entry.directory){selected=entry.path;dialog.close('picked');}};list.append(b);}
    if(!data.entries.length)list.textContent='No folders or TeX files here.';
  }catch(e){if(sequence===request)error.textContent=e.message;}}
  dialog.querySelector('[data-go]').onclick=()=>browse(path.value);path.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();browse(path.value);}};
  open.onclick=()=>{selected=selected||current;if(selected&&!busy)dialog.close('picked');};
  for(const type of ['folder','file'])dialog.querySelector('[data-'+type+']').onclick=async()=>{
    if(busy||!current)return;const name=prompt(type==='folder'?'New folder name:':'New TeX filename:',''+(type==='file'?'main.tex':''));if(!name)return;
    busy=true;try{await api('/api/browse/create',{parent:current,name,kind:type});await browse(current);}catch(e){error.textContent=e.message;}finally{busy=false;}
  };
  dialog.showModal();await browse(initial);return result;
}

export async function chooseProject(api,kind,web=false,initial='') {
  let reason='';
  if(!web){const info=await api('/api/capabilities');if(!info.nativePicker){web=true;reason=info.pickerReason;}}
  if(!web){const result=await api('/api/project/open',{kind});if(!result.pickerUnavailable)return result;initial=result.initial||initial;reason=result.reason||'';}
  const path=await pickServer(api,{kind,initial,reason});return path?api('/api/project/open',{path}):{cancelled:true};
}

export async function showDependencyStatus(api,container,buttons){
  const info=await api('/api/capabilities');
  for(const button of buttons){if(!info.nativePicker)button.title='Browser picker: '+info.pickerReason;}
  const expanded=container.querySelector('details')?.open;
  container.replaceChildren();
  if(info.warnings.length||info.texPath){
    const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent=!info.warnings.length?'TeX tools':info.nativePicker?'Dependency notices':'Browser picker active';
    details.open=expanded??(!info.tkinter&&!info.remote);details.append(summary);
    for(const warning of info.warnings){const p=document.createElement('p');p.textContent=warning;details.append(p);}container.append(details);
    const detected=document.createElement('p');detected.textContent='Detected tools: '+(Object.entries(info.tools).filter(([,path])=>path).map(([name])=>name).join(', ')||'none');details.append(detected);
    const label=document.createElement('label');label.textContent='Custom TeX binaries directory on server';
    const input=document.createElement('input');input.type='text';input.value=info.texPath||'';input.placeholder='e.g. /usr/local/texlive/2026/bin/x86_64-linux';input.setAttribute('aria-label','Custom TeX binaries directory');label.append(input);
    const apply=document.createElement('button');apply.textContent='Apply TeX path';
    const browse=document.createElement('button');browse.textContent='Browse';
    const message=document.createElement('p');message.textContent='Applies to all server sessions. Leave empty to use the original PATH.';
    apply.onclick=async()=>{apply.disabled=true;try{await api('/api/tools',{texPath:input.value});await showDependencyStatus(api,container,buttons);if(!container.childNodes.length)message.textContent='TeX tools detected.';}catch(e){message.textContent=e.message;}finally{apply.disabled=false;}};
    browse.onclick=async()=>{const path=await pickServer(api,{initial:input.value,kind:'folder'});if(path)input.value=path;};
    details.append(label,browse,apply,message);
  }
  return info;
}
