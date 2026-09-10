import { createContext, useContext, useEffect, useState } from 'react';
import { accessibilityDefaults } from './accessibility';
export const AccessibilityContext = createContext(accessibilityDefaults);
export const useAccessibility = () => useContext(AccessibilityContext);
export function useReducedMotion() {
  const [reduced, setReduced] = useState(()=>matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(()=>{
    const media=matchMedia('(prefers-reduced-motion: reduce)');
    const changed=()=>setReduced(media.matches);
    media.addEventListener('change',changed);
    return ()=>media.removeEventListener('change',changed);
  },[]);
  return reduced;
}
