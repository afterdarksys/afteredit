export const swiftSnippets=[
 {label:'SwiftUI View',body:'import SwiftUI\n\nstruct ${1:ContentView}: View {\n\tvar body: some View {\n\t\tText("${2:Hello}")\n\t}\n}'},
 {label:'SwiftUI preview',body:'#Preview {\n\t${1:ContentView}()\n}'},
 {label:'XCTest case',body:'func test${1:Behavior}() throws {\n\tXCTAssertEqual(${2:actual}, ${3:expected})\n}'},
 {label:'Swift async function',body:'func ${1:load}() async throws -> ${2:String} {\n\t$0\n}'},
];
export type AppleSelection={project:string;scheme:string;target:string;configuration:string;destination:string};
export type AppleMetadata={schemes:string[];targets:string[];configurations:string[]};
export function appleMetadata(text:string):AppleMetadata{
 const data=JSON.parse(text),item=data.project??data.workspace??data;
 const strings=(v:unknown)=>Array.isArray(v)?v.filter((s):s is string=>typeof s==='string'):[];
 return {schemes:strings(item.schemes),targets:Array.isArray(item.targets)?item.targets.map((t:any)=>typeof t==='string'?t:t.name).filter((t:any)=>typeof t==='string'):[],configurations:strings(item.configurations)};
}
export type AppleDestination={id:string;name:string;platform:string;available:boolean};
export function appleDestinations(text:string):AppleDestination[]{
 const result:AppleDestination[]=[];let available=true;
 for(const line of text.split('\n')){
  if(/Ineligible destinations/.test(line))available=false;
  for(const match of line.matchAll(/\{([^{}]+)\}/g)){
   const item=Object.fromEntries([...match[1].matchAll(/(?:^|,)\s*(\w+):\s*([^,]*)/g)].map(m=>[m[1],m[2].trim()]));
   if(item.id&&item.platform&&!result.some(d=>d.id===item.id&&d.platform===item.platform))result.push({id:item.id,name:item.name??item.id,platform:item.platform,available:available&&!item.error});
  }
 }return result;
}
import type {Task} from './workflows.ts';
import type {InfrastructureDiagnostic} from './infrastructure.ts';
export function applePath(path:string):string{
 if(!path||path.startsWith('/')||path.startsWith('-')||path.split('/').some(p=>!p||p==='.'||p==='..')||/[\0\r\n]/.test(path))throw new Error('Use a relative path inside the project.');return path;
}
function argument(value:string,label:string):string{if(!value||value.startsWith('-')||/[\0\r\n]/.test(value))throw new Error('Choose a valid '+label);return value;}
export function xcodeArguments(s:AppleSelection):string[]{
 const project=applePath(s.project);if(!/\.(xcodeproj|xcworkspace)$/.test(project))throw new Error('Choose an Xcode project or workspace.');
 const args=[project.endsWith('.xcworkspace')?'-workspace':'-project',project];
 if(s.scheme)args.push('-scheme',argument(s.scheme,'scheme'));else if(s.target&&!project.endsWith('.xcworkspace'))args.push('-target',argument(s.target,'target'));else throw new Error('Select a scheme or target.');
 if(s.configuration)args.push('-configuration',argument(s.configuration,'configuration'));
 if(s.destination)args.push('-destination',argument(s.destination,'destination'));
 return args;
}
export function appleBuild(s:AppleSelection,action:'build'|'test',id:string):{tasks:Task[];result?:string}{
 applePath(s.project);if(!/^[a-zA-Z0-9-]+$/.test(id))throw new Error('Invalid run identifier');
 if(s.project.endsWith('Package.swift')){
  const args=['swift',action,'--configuration',s.configuration.toLowerCase()==='release'?'release':'debug'];
  if(action==='build'&&s.target)args.push('--target',argument(s.target,'target'));
  return {tasks:[{command:'/usr/bin/xcrun',args,cwd:s.project.slice(0,-'Package.swift'.length)||'.',timeoutSeconds:1800}]};
 }
 if(action==='test'&&(!s.scheme||!s.destination))throw new Error('Tests require a scheme and an explicit destination.');
 const result='.afteredit/apple/results/'+id+'.xcresult';const args=xcodeArguments(s);
 if(s.scheme)args.push('-derivedDataPath','.afteredit/apple/DerivedData');
 else args.push('SYMROOT=.afteredit/apple/Products','OBJROOT=.afteredit/apple/Intermediates');
 args.push('-resultBundlePath',result,action);
 return {result,tasks:[{command:'/bin/mkdir',args:['-p','.afteredit/apple/results']},{command:'/usr/bin/xcodebuild',args,timeoutSeconds:1800}]};
}
export function appleDiagnostics(text:string,root:string,cwd='.'):InfrastructureDiagnostic[]{
 const diagnostics:InfrastructureDiagnostic[]=[];
 for(const line of text.split('\n')){
  const m=line.match(/^(.+?):(\d+):(?:(\d+):)?\s*(error|warning|note):\s*(.+)$/);if(!m)continue;
  let path=m[1];if(path.split('/').includes('..'))continue;if(!path.startsWith('/'))path=root+'/'+(cwd==='.'?'':cwd.replace(/\/$/,'')+'/')+path;
  if(!path.startsWith(root.replace(/\/$/,'')+'/'))continue;
  diagnostics.push({path,line:Number(m[2]),column:Number(m[3]??1),message:m[5],severity:m[4]==='note'?'info':m[4] as 'error'|'warning',source:'Apple'});
 }return diagnostics;
}
export type AppleSimulator={id:string;name:string;runtime:string;state:string;available:boolean};
export function appleSimulators(text:string):AppleSimulator[]{
 const data=JSON.parse(text);return Object.entries(data.devices??{}).flatMap(([runtime,devices])=>Array.isArray(devices)?devices.filter(d=>typeof d.udid==='string').map(d=>({id:d.udid,name:String(d.name??d.udid),runtime,state:String(d.state??'Unknown'),available:d.isAvailable===true})):[]);
}
export function simulatorAction(id:string,action:'boot'|'shutdown'|'install'|'launch',app:string,bundle:string):Task[]{
 if(!/^[0-9a-f-]{36}$/i.test(id))throw new Error('Select a simulator UUID.');
 if(action==='boot')return [{command:'/usr/bin/xcrun',args:['simctl','bootstatus',id,'-b'],timeoutSeconds:300},{command:'/usr/bin/open',args:['-a','Simulator']}];
 if(action==='shutdown')return [{command:'/usr/bin/xcrun',args:['simctl','shutdown',id]}];
 if(action==='install'){if(!applePath(app).endsWith('.app'))throw new Error('Choose a built .app bundle.');return [{command:'/usr/bin/xcrun',args:['simctl','install',id,app]}];}
 if(!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundle))throw new Error('Supply the app bundle identifier.');
 return [{command:'/usr/bin/xcrun',args:['simctl','launch',id,bundle]}];
}
export type AppleProduct={name:string;app:string;bundle:string;executable:string;team:string;signing:string};
export function appleProducts(text:string,root:string):AppleProduct[]{
 const rows=JSON.parse(text);if(!Array.isArray(rows))throw new Error('Invalid Xcode build settings');
 return rows.map(row=>{const s=row.buildSettings??{};const relative=(path:string)=>path.startsWith(root+'/')?path.slice(root.length+1):'';
 return {name:String(row.target??''),app:relative(String(s.TARGET_BUILD_DIR??'')+'/'+String(s.FULL_PRODUCT_NAME??'')),bundle:String(s.PRODUCT_BUNDLE_IDENTIFIER??''),executable:relative(String(s.TARGET_BUILD_DIR??'')+'/'+String(s.EXECUTABLE_PATH??'')),team:String(s.DEVELOPMENT_TEAM??''),signing:String(s.CODE_SIGN_STYLE??'')};});
}
export type AppleDevice={id:string;name:string;model:string;developerMode:string};
export function appleDevices(text:string):AppleDevice[]{
 const data=JSON.parse(text);if(data.info?.outcome==='failed'||data.error)throw new Error('Device discovery failed. See Xcode device tools.');
 return (data.result?.devices??[]).filter((d:any)=>typeof d.identifier==='string').map((d:any)=>({id:d.identifier,name:String(d.deviceProperties?.name??d.identifier),model:String(d.hardwareProperties?.marketingName??d.hardwareProperties?.productType??''),developerMode:String(d.deviceProperties?.developerModeStatus??'unknown')}));
}
export function deviceAction(id:string,action:'install'|'launch'|'console',app:string,bundle:string):Task[]{
 if(!/^[0-9a-f-]{36}$/i.test(id))throw new Error('Select a connected device identifier.');
 if(action==='install'){if(!applePath(app).endsWith('.app'))throw new Error('Choose a signed device .app bundle.');return [{command:'/usr/bin/xcrun',args:['devicectl','device','install','app','--device',id,app],timeoutSeconds:300}];}
 if(!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundle))throw new Error('Supply the app bundle identifier.');
 return [{command:'/usr/bin/xcrun',args:['devicectl','device','process','launch','--device',id,...(action==='console'?['--console']:[]),bundle],timeoutSeconds:action==='console'?3600:300}];
}
