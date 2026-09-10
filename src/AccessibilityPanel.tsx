import { accessibilityDefaults, type AccessibilityPreferences } from './accessibility';
export default function AccessibilityPanel({value, onChange}: {
  value: AccessibilityPreferences; onChange: (value: AccessibilityPreferences) => void;
}) {
  return <section aria-labelledby="accessibility-title">
    <h2 id="accessibility-title">Accessibility</h2>
    <p>Personal accessibility settings apply across projects. Use F6 and Shift+F6 to move between workbench regions.</p>
    <div className="preference-grid">
      <label>Whole-app zoom<select value={value.zoom} onChange={e=>onChange({...value,zoom:Number(e.target.value)})}>{[100,125,150,175,200].map(n=><option key={n} value={n}>{n}%</option>)}</select></label>
      <label>Workbench contrast<select value={value.contrast} onChange={e=>onChange({...value,contrast:e.target.value as AccessibilityPreferences['contrast']})}><option value="system">Default / system forced colors</option><option value="dark">High contrast dark</option><option value="light">High contrast light</option></select></label>
      <label>Screen-reader support<select value={value.screenReader} onChange={e=>onChange({...value,screenReader:e.target.value as AccessibilityPreferences['screenReader']})}><option value="auto">Automatic editor detection</option><option value="on">On</option><option value="off">Off</option></select></label>
      {([['reducedMotion','Reduce motion'],['largeCursor','Large editor and terminal cursor'],['announceOutput','Announce incoming task and debug output'],['soundCues','Optional sound cues']] as const).map(([key,label])=><label key={key}><input type="checkbox" checked={value[key]} onChange={e=>onChange({...value,[key]:e.target.checked})}/>{label}</label>)}
      <label>Sound volume<input type="range" min="0" max="100" value={value.soundVolume} onChange={e=>onChange({...value,soundVolume:Number(e.target.value)})}/>{value.soundVolume}%</label>
    </div>
    <button onClick={()=>onChange({...accessibilityDefaults})}>Reset accessibility settings</button>
  </section>;
}
