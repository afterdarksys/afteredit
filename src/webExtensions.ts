import { unzipSync, strFromU8 } from 'fflate';
export type WebExtension = { manifest: Record<string, any>; files: Record<string, string> };
export function safeExtensionPath(path: string): string {
 const normalized=path.replace(/^\.\//,'');
 if(!normalized || normalized.startsWith('/') || normalized.includes('\\') || normalized.includes(':') || normalized.split('/').some(p=>p==='..'||p==='.'||!p)) throw new Error('Invalid extension path');
 return normalized;
}
/** Executable payloads remain disabled until the user explicitly enables them. */
export function importWebVSIX(bytes: Uint8Array): WebExtension {
 if(bytes.length>20*1024*1024)throw new Error('VSIX exceeds 20 MiB');
 let total=0,count=0;
 const archive=unzipSync(bytes,{filter:f=>{
  if(!f.name.startsWith('extension/')||f.name.endsWith('/'))return false;
  safeExtensionPath(f.name.slice(10));
  total+=f.originalSize;
  if(++count>2000||f.originalSize>4*1024*1024||total>12*1024*1024)throw new Error('Extension exceeds prototype extraction limits');
  return true;
 }});
 if(!archive['extension/package.json'])throw new Error('Missing extension/package.json');
 const manifest=JSON.parse(strFromU8(archive['extension/package.json']));
 if(!manifest||!/^[-\w]+$/.test(manifest.publisher??'')||!/^[-\w]+$/.test(manifest.name??'')||typeof manifest.version!=='string')throw new Error('Invalid extension identity');
 if(typeof manifest.browser!=='string')throw new Error('Desktop-only extension: a browser entry is required. Node extension hosts are not available yet.');
 if(manifest.extensionDependencies?.length||manifest.enabledApiProposals?.length)throw new Error('Extension dependencies and proposed APIs are not supported by this prototype');
 const unsupported=Object.keys(manifest.contributes??{}).filter(k=>!['commands','configuration','keybindings','menus','languages'].includes(k));
 if(unsupported.length)throw new Error(`Unsupported web-extension contributions: ${unsupported.join(', ')}`);
 const entry=safeExtensionPath(manifest.browser);
 if(!archive['extension/'+entry]&&!archive['extension/'+entry+'.js'])throw new Error('Missing browser entry');
 const files:Record<string,string>={};
 for(const [path,data] of Object.entries(archive)) {
  let binary='';for(let i=0;i<data.length;i+=8192)binary+=String.fromCharCode(...data.subarray(i,i+8192));
  files[path.slice(10)]=btoa(binary);
 }
 return {manifest,files};
}
export function validateWebExtension(value:unknown):value is WebExtension {
 try{
  const v=value as WebExtension;
  if(!v||!v.manifest||typeof v.manifest.browser!=='string'||!v.files||typeof v.files!=='object'||Array.isArray(v.files))return false;
  safeExtensionPath(v.manifest.browser);
  return Object.entries(v.files).length<=2000&&Object.entries(v.files).every(([k,v])=>{safeExtensionPath(k);return typeof v==='string'&&/^[A-Za-z0-9+/]*={0,2}$/.test(v);});
 }catch{return false;}
}
