import { useRef } from 'react';
export default function ChangeReview({path,oldText,newText}: {path:string;oldText:string;newText:string}) {
  const removed=useRef<HTMLHeadingElement>(null),added=useRef<HTMLHeadingElement>(null);
  return <section aria-label={`Proposed edit to ${path}`} className="change-review">
    <p>File: {path}</p>
    <p>This replaces one exact occurrence of the removed text. Approval changes the unsaved buffer.</p>
    <div><button onClick={()=>removed.current?.focus()}>Read removed text</button><button onClick={()=>added.current?.focus()}>Read added text</button></div>
    <h4 ref={removed} tabIndex={-1}>Removed text</h4>
    <pre tabIndex={0} aria-label="Removed text">{oldText || '(empty)'}</pre>
    <h4 ref={added} tabIndex={-1}>Added text</h4>
    <pre tabIndex={0} aria-label="Added text">{newText || '(empty — deletion)'}</pre>
  </section>;
}
