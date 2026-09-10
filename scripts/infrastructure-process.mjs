import {spawn} from 'node:child_process';
// Keep diagnostic JSON separate from warnings and bound both runtime and output.
export function run(command,args,cwd,{env=process.env,timeout=20000,maxBytes=2_000_000}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{cwd,env,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
  let stdout=[],stderr=[],size=0,ended=false;
  const stop=()=>{try{if(process.platform==='win32')child.kill('SIGKILL');else if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{}child.stdout.destroy();child.stderr.destroy();};
  const finish=(error,result)=>{if(ended)return;ended=true;clearTimeout(timer);if(error){stop();reject(error);}else resolve(result);};
  const timer=setTimeout(()=>finish(new Error(command+' timed out after '+timeout+' ms')),timeout);
  const collect=target=>chunk=>{if(ended)return;size+=chunk.length;if(size>maxBytes){finish(new Error(command+' output exceeds '+maxBytes+' bytes'));return;}target.push(chunk);};
  child.stdout.on('data',collect(stdout));child.stderr.on('data',collect(stderr));
  child.on('error',error=>finish(error));
  child.on('close',(code,signal)=>finish(null,{code,signal,stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8')}));
 });
}
