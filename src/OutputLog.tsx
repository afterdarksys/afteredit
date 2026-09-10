import { useAccessibility } from './AccessibilityContext';
export default function OutputLog({label,children,className='task-log'}: {
  label:string; children:string; className?:string;
}) {
  const {announceOutput}=useAccessibility();
  return <pre className={className} role="log" aria-label={label} aria-live={announceOutput?'polite':'off'} aria-relevant="additions text" tabIndex={0}>{children}</pre>;
}
