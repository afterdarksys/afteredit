export type DebugConfig={adapter:{command?:string;args?:string[];env?:Record<string,string>;port?:number};request:'launch'|'attach';configuration:Record<string,unknown>};
export type Breakpoint={path:string;line:number;condition?:string;hitCondition?:string;logMessage?:string;enabled?:boolean;verified?:boolean;message?:string;adapterId?:number};
export function debugConfig(value:unknown):DebugConfig {
 const c=value as DebugConfig;
 if(!c||!['launch','attach'].includes(c.request)||!c.adapter||!c.configuration||Array.isArray(c.configuration)||typeof c.configuration!=='object')throw new Error('Supply adapter, launch/attach request and configuration');
 const a=c.adapter;
 if(a.port!==undefined){if(!Number.isInteger(a.port)||a.port<1||a.port>65535||a.command!==undefined)throw new Error('Use a localhost port OR an adapter command');}
 else if(typeof a.command!=='string'||!a.command.trim())throw new Error('Supply an installed debug adapter command');
 if(a.args!==undefined&&(!Array.isArray(a.args)||!a.args.every(x=>typeof x==='string')))throw new Error('Adapter args must be strings');
 if(a.env!==undefined&&(!a.env||typeof a.env!=='object'||Array.isArray(a.env)||!Object.values(a.env).every(x=>typeof x==='string')))throw new Error('Invalid adapter environment');
 return c;
}
export function expandDebug(value:unknown,root:string,file:string):any{
 if(typeof value==='string'){if(value.includes('${file}')&&!file)throw new Error('Open a saved file for ${file}');return value.split('${workspaceFolder}').join(root).split('${file}').join(file);}
 if(Array.isArray(value))return value.map(v=>expandDebug(v,root,file));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,expandDebug(v,root,file)]));return value;
}
export function restoreBreakpoints(text:string):Breakpoint[]{try{const v=JSON.parse(text);return Array.isArray(v)?v.filter(b=>b&&typeof b.path==='string'&&Number.isInteger(b.line)&&b.line>0&&['condition','hitCondition','logMessage'].every(k=>b[k]===undefined||typeof b[k]==='string')&&(b.enabled===undefined||typeof b.enabled==='boolean')).map(({path,line,condition,hitCondition,logMessage,enabled})=>({path,line,condition,hitCondition,logMessage,enabled})):[];}catch{return [];}}
export function breakpointArguments(path:string,points:Breakpoint[],capabilities:Record<string,any>){
 const selected=points.filter(b=>b.path===path&&b.enabled!==false);
 for(const b of selected){if(b.condition&&!capabilities.supportsConditionalBreakpoints)throw new Error('Adapter does not support conditional breakpoints');if(b.hitCondition&&!capabilities.supportsHitConditionalBreakpoints)throw new Error('Adapter does not support hit-count breakpoints');if(b.logMessage&&!capabilities.supportsLogPoints)throw new Error('Adapter does not support logpoints');}
 return {source:{path},breakpoints:selected.map(({line,condition,hitCondition,logMessage})=>({line,condition,hitCondition,logMessage})),sourceModified:false};
}
export const debugPresets:Record<string,DebugConfig>={
 'Ansible (attach to Ansibug listener)':{adapter:{command:'python3',args:['-m','ansibug','dap']},request:'attach',configuration:{address:'tcp://127.0.0.1:4712'}},
 'C / C++ / Rust (LLDB)':{adapter:{command:'lldb-dap',args:[]},request:'launch',configuration:{program:'${workspaceFolder}/build/program',cwd:'${workspaceFolder}',stopOnEntry:true}},
 'macOS Xcode LLDB':{adapter:{command:'xcrun',args:['lldb-dap']},request:'launch',configuration:{program:'${workspaceFolder}/build/program',cwd:'${workspaceFolder}',stopOnEntry:true}},
 'Python (debugpy)':{adapter:{command:'python3',args:['-m','debugpy.adapter']},request:'launch',configuration:{type:'python',program:'${file}',cwd:'${workspaceFolder}',console:'internalConsole',justMyCode:true}},
 'Go (running dlv dap server)':{adapter:{port:38697},request:'launch',configuration:{mode:'debug',program:'${workspaceFolder}',cwd:'${workspaceFolder}'}},
 'Node / web (installed js-debug)':{adapter:{port:4711},request:'launch',configuration:{type:'pwa-node',program:'${file}',cwd:'${workspaceFolder}',console:'internalConsole'}},
 'Existing localhost DAP adapter':{adapter:{port:4711},request:'attach',configuration:{}}
};
export type DebugRequest=(command:string,args:Record<string,any>)=>Promise<any>;
export async function configureDebug(send:DebugRequest,ready:Promise<void>,config:DebugConfig,points:Breakpoint[],filters:string[],onCapabilities:(caps:any)=>void,onBreakpoints:(path:string,result:any[])=>void){
 // A rejected startup signal must also interrupt an outstanding initialize request.
 const aborted=ready.then(()=>new Promise<never>(()=>{}));
 const request:DebugRequest=(command,args)=>Promise.race([send(command,args),aborted]);
 const caps=await request('initialize',{clientID:'afteredit',adapterID:'configured',pathFormat:'path',linesStartAt1:true,columnsStartAt1:true,supportsVariableType:true,supportsVariablePaging:true,supportsRunInTerminalRequest:false,supportsStartDebuggingRequest:false});
 onCapabilities(caps??{});
 const launched=request(config.request,config.configuration);
 // Launch can wait for configurationDone. Never await it before initialized/configuration.
 await Promise.race([ready,launched.then(()=>ready)]);
 for(const path of new Set(points.map(b=>b.path))){const reply=await request('setBreakpoints',breakpointArguments(path,points,caps??{}));onBreakpoints(path,reply.breakpoints??[]);}
 if(caps?.exceptionBreakpointFilters?.length)await request('setExceptionBreakpoints',{filters});
 if(caps?.supportsConfigurationDoneRequest)await request('configurationDone',{});
 await launched;
}
