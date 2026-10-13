// SPDX-License-Identifier: Apache-2.0
// Browser persistence is optional. Denied access/quota failures must not stop
// editing or disk saves. Volatile fallback is never presented as a disk backup.
function store(name){
  let raw;const memory=new Map();
  try{raw=globalThis[name];const probe='localtex-storage-probe';raw.setItem(probe,'1');raw.removeItem(probe);}catch{raw=null;}
  const facade={
    available:!!raw,
    getItem(key){try{if(raw)return raw.getItem(key);}catch{fail();}return memory.get(key)??null;},
    setItem(key,value){memory.set(key,String(value));try{if(raw)raw.setItem(key,value);}catch{fail();}},
    removeItem(key){memory.delete(key);try{if(raw)raw.removeItem(key);}catch{fail();}},
    key(index){try{if(raw)return raw.key(index);}catch{fail();}return [...memory.keys()][index]??null;},
    get length(){try{if(raw)return raw.length;}catch{fail();}return memory.size;}
  };
  function fail(){raw=null;facade.available=false;notice();}
  return facade;
}
export const sessionStore=store('sessionStorage'),localStore=store('localStorage');
export const randomId=()=>globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+Math.random().toString(36).slice(2);
function notice(){
  const el=document.getElementById('storageNotice');if(!el)return;
  const unavailable=!localStore.available||!sessionStore.available;
  el.classList.toggle('hidden',!unavailable);
  el.textContent=!localStore.available?'Browser backup unavailable':'View storage unavailable';
  el.title=!localStore.available?'Browser storage is blocked or full. Browser draft backups/preferences are unavailable. Editing, disk saves and saved-file history still work. Save to disk before closing.':'Session storage is unavailable. View positions may not survive a reload; disk saves still work.';
}
notice();
