import type {Page} from '@playwright/test';
export async function nativeHarness(page:Page){
 await page.addInitScript(()=>{
  const w=window as any;let next=1;const callbacks=new Map<number,Function>(),listeners=new Map<number,{event:string;handler:number}>();
  let staged=false;
  const pending=new Map<string,{resolve:Function;reject:Function}>();
  w.isTauri=true;w.testDisk={'/project/note.txt':'original text'};w.testCalls=[];
  w.testEmit=(event:string,payload:unknown)=>{for(const [id,listener] of listeners)if(listener.event===event)callbacks.get(listener.handler)?.({event,id,payload});};
  w.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:(_event:string,id:number)=>listeners.delete(id)};
  w.__TAURI_INTERNALS__={
   metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
   transformCallback:(callback:Function)=>{const id=next++;callbacks.set(id,callback);return id;},
   invoke:async(command:string,args:any)=>{
    w.testCalls.push({command,args});
    if(command==='plugin:event|listen'){const id=next++;listeners.set(id,args);return id;}
    if(command==='plugin:event|unlisten')return;
    if(command==='restore_session')return {roots:['/project'],files:['/project/note.txt'],active:'/project/note.txt',root:'/project',directory:'/project'};
    if(command==='save_session')return;
    if(command==='list_directory')return [{name:'note.txt',path:'/project/note.txt',directory:false}];
    if(command==='read_file'){if(!(args.path in w.testDisk))throw Error('File missing');return w.testDisk[args.path];}
    if(command==='save_file'){if(w.testDisk[args.path]!==args.expected)throw Error('External conflict');w.testDisk[args.path]=args.content;return;}
    if(command==='git_diff')return '- original text\n+ changed text';
    if(command==='git_status')return {branch:'fixture',files:[{path:'note.txt',originalPath:null,index:staged?'M':' ',worktree:staged?' ':'M'}]};
    if(command==='git_stage'){staged=args.stage;return;}
    if(command==='git_review_staged')return {tree:'reviewed-tree',diff:'+ staged content'};
    if(command==='git_commit'){staged=false;return 'Committed fixture';}
    if(command==='project_config')return [];
    if(command==='formattable_languages')return [];
    if(command==='editor_bridge_start')return {port:0};
    if(command==='spawn_pty')return true;
    if(command==='ask_ai')return new Promise((resolve,reject)=>pending.set(args.request.requestId,{resolve,reject}));
    if(command==='cancel_ai'){pending.get(args.requestId)?.reject('AI request cancelled; reservation retained.');pending.delete(args.requestId);return;}
    return null;
   },
  };
 });
}
