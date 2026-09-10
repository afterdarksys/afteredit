import { useCallback, useEffect, useRef } from 'react';
import type { AccessibilityPreferences } from './accessibility';
export type SoundCue = 'success' | 'error' | 'paused';
export function useSoundCues(preferences: AccessibilityPreferences) {
  const prefs=useRef(preferences); prefs.current=preferences;
  const context=useRef<AudioContext | null>(null);
  useEffect(()=>()=>{void context.current?.close();context.current=null;},[]);
  return useCallback((cue:SoundCue)=>{
    if (!prefs.current.soundCues || prefs.current.soundVolume===0) return;
    try {
      const audio=context.current ??= new AudioContext();
      void audio.resume().then(()=>{
        if(audio.state!=='running'||!prefs.current.soundCues) return;
        const start=audio.currentTime;
        const frequencies=cue==='success'?[523,784]:cue==='error'?[220,165]:[440,440];
        frequencies.forEach((frequency,index)=>{
          const oscillator=audio.createOscillator(),gain=audio.createGain();
          oscillator.frequency.value=frequency;
          const time=start+index*.16;
          gain.gain.setValueAtTime(0,time);
          gain.gain.linearRampToValueAtTime(prefs.current.soundVolume/100*.15,time+.01);
          gain.gain.linearRampToValueAtTime(0,time+.13);
          oscillator.connect(gain);gain.connect(audio.destination);
          oscillator.start(time);oscillator.stop(time+.14);
          oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();};
        });
      }).catch(()=>{/* Text announcements remain available when audio is blocked. */});
    } catch { /* Web Audio may be unavailable in a host. */ }
  },[]);
}
