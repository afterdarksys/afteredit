import {mkdtempSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const root=mkdtempSync(join(tmpdir(),'afteredit-iac-smoke-'));
const tf=join(root,'terraform');mkdirSync(tf);writeFileSync(join(tf,'main.tf'),'output "broken" {\n  value = var.missing\n}\n');
const ansible=join(root,'ansible');mkdirSync(ansible);const playbook=join(ansible,'site.yml');writeFileSync(playbook,'---\n- name: Local syntax check\n  hosts: localhost\n  gather_facts: false\n  tasks:\n    - name: Message\n      ansible.builtin.debug:\n        msg: Hello\n');
function run(command,args,cwd){return new Promise((resolve,reject)=>{
 const child=spawn(command,args,{cwd,env:{...process.env,CHECKPOINT_DISABLE:'1',ANSIBLE_LOCAL_TEMP:join(root,'ansible-tmp'),ANSIBLE_REMOTE_TEMP:join(root,'ansible-remote')},stdio:['ignore','pipe','pipe']});let output='',ended=false;
 const finish=(fn,value)=>{if(ended)return;ended=true;clearTimeout(timer);fn(value);};
 const timer=setTimeout(()=>{child.kill('SIGKILL');child.stdout.destroy();child.stderr.destroy();child.unref();finish(reject,new Error(command+' timed out after 20 seconds'));},20000);
 child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);child.on('error',e=>finish(reject,e));child.on('close',code=>finish(resolve,{code,output}));
});}
let failures=0;
for(const command of ['terraform','tofu'])try{
 const r=await run(command,['validate','-json'],tf);assert.notEqual(r.code,0);const data=JSON.parse(r.output.slice(r.output.indexOf('{')));assert.equal(data.valid,false);assert.ok(data.diagnostics.some(d=>d.range?.filename?.endsWith('main.tf')));console.log(command+': real validation failure includes source diagnostics');
}catch(e){failures++;console.error(String(e));}
try{const r=await run('ansible-playbook',['--syntax-check',playbook],ansible);assert.equal(r.code,0,r.output);console.log('Ansible: local playbook syntax check passed');}catch(e){failures++;console.error(String(e));}
console.log('Fixtures: '+root);process.exitCode=failures?1:0;
