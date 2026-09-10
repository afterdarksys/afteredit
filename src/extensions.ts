import { unzipSync, strFromU8 } from 'fflate';
import { parse, type ParseError } from 'jsonc-parser';
export type Theme = { id: string; label: string; base: 'vs' | 'vs-dark' | 'hc-black'; colors: Record<string,string>; rules: Array<{token:string;foreground?:string;background?:string;fontStyle?:string}> };
export type Snippet = { label: string; prefix: string; body: string; description: string; languages: string[] };
export type Extension = { id: string; version: string; enabled: boolean; themes: Theme[]; snippets: Snippet[] };
function json(text: string): any {
 const errors: ParseError[]=[]; const value=parse(text,errors,{allowTrailingComma:true});
 if(errors.length || !value || typeof value!=='object' || Array.isArray(value)) throw new Error('Invalid JSON contribution');
 return value;
}
export function importVSIX(bytes: Uint8Array): Extension {
 if(bytes.length>20*1024*1024) throw new Error('VSIX exceeds 20 MiB');
 let size=0;
 const files=unzipSync(bytes,{filter:file=>{
   const allowed=file.name.startsWith('extension/') && /\.(json|code-snippets)$/i.test(file.name) && !file.name.split('/').some(p=>p==='..') && !file.name.includes('\\');
   if(!allowed) return false;
   size+=file.originalSize;
   if(file.originalSize>2*1024*1024 || size>10*1024*1024) throw new Error('Extension JSON exceeds the import limit');
   return true;
 }});
 const read=(path:string)=>{ const normalized=path.replace(/^\.\//,''); if(normalized.split('/').includes('..')||normalized.includes('\\')||normalized.startsWith('/')) throw new Error('Invalid contribution path'); const data=files['extension/'+normalized]; if(!data) throw new Error(`Missing contribution: ${path}`); return json(strFromU8(data)); };
 const manifest=read('package.json');
 if(!/^[\w-]+$/.test(manifest.publisher??'') || !/^[\w-]+$/.test(manifest.name??'') || typeof manifest.version!=='string') throw new Error('Invalid extension identity');
 if(manifest.main || manifest.browser || manifest.extensionDependencies?.length) throw new Error('This extension requires a VS Code extension host and cannot run in AfterEdit yet.');
 const contributions=manifest.contributes??{};
 if(Object.keys(contributions).some(key=>!['themes','snippets'].includes(key))) throw new Error('Only theme and snippet contributions are currently supported.');
 const extension:Extension={id:`${manifest.publisher}.${manifest.name}`,version:manifest.version,enabled:true,themes:[],snippets:[]};
 for(const [i,entry] of (contributions.themes??[]).entries()) {
   const data=read(entry.path);
   if(data.include) throw new Error('Themes using include files are not supported yet');
   const theme:Theme={id:`${extension.id}-${i}`,label:String(entry.label??entry.id??extension.id),base:entry.uiTheme==='vs'?'vs':entry.uiTheme==='hc-black'?'hc-black':'vs-dark',colors:{},rules:[]};
   for(const [key,value] of Object.entries(data.colors??{})) if(typeof value==='string' && /^#[\da-f]{3,8}$/i.test(value)) theme.colors[key]=value;
   for(const rule of data.tokenColors??[]) {
     for(const token of Array.isArray(rule.scope)?rule.scope:String(rule.scope??'').split(',')) {
       const settings=rule.settings??{};
       theme.rules.push({token:String(token).trim(),...(typeof settings.foreground==='string'?{foreground:settings.foreground.replace('#','')}:{}),...(typeof settings.background==='string'?{background:settings.background.replace('#','')}:{}),...(typeof settings.fontStyle==='string'?{fontStyle:settings.fontStyle}:{})});
     }
   }
   extension.themes.push(theme);
 }
 for(const entry of contributions.snippets??[]) {
   const data=read(entry.path);
   for(const [label,value] of Object.entries(data) as Array<[string,any]>) {
     const body=Array.isArray(value.body)?value.body.join('\n'):value.body;
     if(typeof body!=='string') throw new Error(`Invalid snippet: ${label}`);
     for(const prefix of Array.isArray(value.prefix)?value.prefix:[value.prefix]) {
       if(typeof prefix!=='string') throw new Error(`Invalid snippet prefix: ${label}`);
       extension.snippets.push({label,prefix,body,description:String(value.description??label),languages:String(entry.language??value.scope??'*').split(',').map((s:string)=>s.trim())});
     }
   }
 }
 if(!extension.themes.length && !extension.snippets.length) throw new Error('No supported theme or snippet contributions');
 return extension;
}
export function restoreExtensions(text:string):Extension[] {
 try {
  const data=JSON.parse(text);
  if(!Array.isArray(data)||data.length>64) return [];
  return data.filter((e:any)=>e&&typeof e.id==='string'&&typeof e.version==='string'&&typeof e.enabled==='boolean'&&Array.isArray(e.themes)&&Array.isArray(e.snippets)&&
    e.themes.every((t:any)=>t&&typeof t.id==='string'&&typeof t.label==='string'&&['vs','vs-dark','hc-black'].includes(t.base)&&t.colors&&typeof t.colors==='object'&&Object.values(t.colors).every(v=>typeof v==='string')&&Array.isArray(t.rules)&&t.rules.every((r:any)=>r&&typeof r.token==='string'&&['foreground','background','fontStyle'].every(k=>r[k]===undefined||typeof r[k]==='string')))&&
    e.snippets.every((s:any)=>s&&['label','prefix','body','description'].every(k=>typeof s[k]==='string')&&Array.isArray(s.languages)&&s.languages.every((l:any)=>typeof l==='string')));
 }catch{return [];}
}
