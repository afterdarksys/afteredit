import { useEffect, useRef, useState } from 'react';
export default function CommandPalette({commands, onClose}: {
  commands: {title:string; action:()=>void}[]; onClose:()=>void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  const [query, setQuery] = useState('');
  const close = useRef(onClose); close.current = onClose;
  useEffect(()=>{
    const previous = previousFocus.current;
    const node = dialog.current!;
    node.showModal();
    return ()=>{ node.close(); if (previous?.isConnected) previous.focus(); };
  },[]);
  const matches = commands.filter(c=>c.title.toLowerCase().includes(query.toLowerCase()));
  return <dialog ref={dialog} className="command-palette accessible-dialog" aria-labelledby="commands-title"
    onKeyDown={e=>{
      if(e.key!=='Tab') return;
      const controls=Array.from(e.currentTarget.querySelectorAll<HTMLElement>('input, button:not(:disabled)')).filter(node=>node.getClientRects().length>0);
      const first=controls[0],last=controls[controls.length-1];
      if(e.shiftKey && document.activeElement===first){e.preventDefault();last?.focus();}
      else if(!e.shiftKey && document.activeElement===last){e.preventDefault();first?.focus();}
    }}
    onCancel={e=>{e.preventDefault();close.current();}}
    onClick={e=>{if(e.target===e.currentTarget) close.current();}}>
    <div onClick={e=>e.stopPropagation()}>
      <h2 id="commands-title">Commands</h2>
      <label>Search commands<input autoFocus className="cp-input" value={query} onChange={e=>setQuery(e.target.value)}
        onKeyDown={e=>{
          if (e.key==='ArrowDown') { e.preventDefault(); dialog.current?.querySelector<HTMLButtonElement>('.cp-item')?.focus(); }
          if (e.key==='Enter' && matches.length===1) { e.preventDefault(); onClose(); requestAnimationFrame(matches[0].action); }
        }}/></label>
      <p role="status">{matches.length} matching commands</p>
      <div className="cp-list" onKeyDown={e=>{
        if (!['ArrowDown','ArrowUp','Home','End'].includes(e.key)) return;
        const buttons=Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
        const index=buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (!buttons.length) return;
        e.preventDefault();
        buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(index+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length].focus();
      }}>{matches.map(c=><button className="cp-item" key={c.title} onClick={()=>{onClose();requestAnimationFrame(c.action);}}>{c.title}</button>)}</div>
      <button onClick={onClose}>Close commands</button>
    </div>
  </dialog>;
}
