// SPDX-License-Identifier: Apache-2.0
// Search stays local and never waits on or locks the compiler. Work is sliced
// across tasks; obsolete searches are cancelled when output or the query changes.
export function installLogSearch({showRaw}) {
  const $=id=>document.getElementById(id),log=$('console'),bar=$('logFindBar'),query=$('logQuery');
  let text=log.textContent,hits=[],current=-1,open=false,follow=true,version=0,timer=null,pending=false,steps=0,preferred=null;
  const caseButton=$('logCase'),count=$('logMatches');
  function cancel(){version++;clearTimeout(timer);timer=null;pending=false;steps=0;}
  function counter(){count.textContent=pending?'Searching…':(current<0?0:current+1)+' / '+hits.length;
    count.title=hits.length>1000?'Only nearby matches are highlighted to keep large logs responsive.':'';}
  function reveal(){const mark=log.querySelector('mark.current');if(!mark||log.classList.contains('hidden'))return;
    const r=mark.getBoundingClientRect(),box=log.getBoundingClientRect();
    log.scrollTop+=r.top-box.top-Math.max(0,(log.clientHeight-Math.min(r.height,log.clientHeight))/2);
  }
  function paint(scroll=false){
    const top=log.scrollTop,left=log.scrollLeft,fragment=document.createDocumentFragment();let at=0;
    // Bound the DOM even for a query matching hundreds of thousands of times.
    const first=Math.max(0,current-499),last=Math.min(hits.length,first+1000);
    if(open)for(let i=first;i<last;i++){
      const hit=hits[i];fragment.append(document.createTextNode(text.slice(at,hit.start)));
      const mark=document.createElement('mark');mark.className='log-hit'+(i===current?' current':'');mark.textContent=text.slice(hit.start,hit.end);
      fragment.append(mark);at=hit.end;
    }
    fragment.append(document.createTextNode(text.slice(at)));log.replaceChildren(fragment);
    log.scrollTop=top;log.scrollLeft=left;counter();if(scroll)reveal();
  }
  function search(reset=false,revealMatch=false){
    if(reset)preferred=null;else if(hits[current])preferred=hits[current].start;
    const anchor=preferred;cancel();hits=[];current=-1;
    if(!open||!query.value){paint();return;}
    const ticket=version,source=text,pattern=query.value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const regex=new RegExp(pattern,caseButton.getAttribute('aria-pressed')==='true'?'g':'gi'),found=[];
    pending=true;counter();
    function chunk(){
      if(ticket!==version)return;const start=performance.now();let match,n=0;
      while((match=regex.exec(source))){
        found.push({start:match.index,end:match.index+match[0].length});
        if(++n%256===0&&performance.now()-start>=8){timer=setTimeout(chunk,0);return;}
      }
      timer=null;pending=false;hits=found;current=hits.length?0:-1;
      if(anchor!==null&&hits.length){let lo=0,hi=hits.length;while(lo<hi){const mid=(lo+hi)>>1;if(hits[mid].start<anchor)lo=mid+1;else hi=mid;}current=Math.min(lo,hits.length-1);}
      if(hits.length&&steps)current=((current+steps)%hits.length+hits.length)%hits.length;
      const moved=!!steps;steps=0;preferred=hits[current]?.start??null;paint(revealMatch||moved);
    }
    timer=setTimeout(chunk,0);
  }
  function move(previous=false){follow=false;if(pending){steps+=previous?-1:1;return;}
    if(hits.length){current=(current+(previous?-1:1)+hits.length)%hits.length;preferred=hits[current].start;paint(true);}}
  function show(){showRaw();open=true;follow=false;bar.classList.remove('hidden');$('logFindBtn').classList.add('hidden');
    search(false,true);query.focus({preventScroll:true});query.select();}
  function close(restore=true){if(!open)return;cancel();open=false;bar.classList.add('hidden');$('logFindBtn').classList.remove('hidden');hits=[];current=-1;preferred=null;paint();
    // Keep the reader's place. Following resumes when they scroll to the bottom.
    if(restore)log.focus({preventScroll:true});}
  $('logFindBtn').onclick=show;$('logFindClose').onclick=()=>close();
  $('logPrev').onclick=()=>move(true);$('logNext').onclick=()=>move();
  query.oninput=()=>{follow=false;search(true,true);};
  caseButton.onclick=()=>{caseButton.setAttribute('aria-pressed',caseButton.getAttribute('aria-pressed')!=='true');search(true,true);};
  bar.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();e.stopPropagation();move(e.shiftKey);}
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();}});
  log.addEventListener('scroll',()=>{if(!open)follow=log.scrollHeight-log.clientHeight-log.scrollTop<5;});
  // Capture before the editor/PDF shortcut router. Other panes keep their find.
  function shortcut(e){
    if((log===document.activeElement||bar.contains(document.activeElement))&&(e.ctrlKey||e.metaKey)&&!e.altKey&&(e.key.toLowerCase()==='f'||e.code==='KeyF')){
      e.preventDefault();e.stopImmediatePropagation();if(e.type==='keydown'||!open)show();
    }else if(e.type==='keydown'&&e.key==='Escape'&&open&&(log===document.activeElement||bar.contains(document.activeElement))){e.preventDefault();e.stopImmediatePropagation();close();}
  }
  window.addEventListener('keydown',shortcut,true);
  window.addEventListener('keyup',shortcut,true);
  return {
    active:()=>open,
    close,
    set(value,{stream=false}={}){
      const next=String(value??'');if(next===text)return;
      const bottom=follow&&!open;text=next;
      if(open)search(false,false);else{cancel();hits=[];current=-1;paint();}
      if(stream&&bottom)log.scrollTop=log.scrollHeight;
    },
    visible(raw){if(!raw)close(false);},
    reset(){close(false);query.value='';caseButton.setAttribute('aria-pressed','false');follow=true;this.set('No compilation in this session yet.');}
  };
}
