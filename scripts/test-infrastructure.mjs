import {mkdtempSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {run as execute} from './infrastructure-process.mjs';
import assert from 'node:assert/strict';
const root=mkdtempSync(join(tmpdir(),'afteredit-iac-smoke-'));
const tf=join(root,'terraform');mkdirSync(tf);writeFileSync(join(tf,'main.tf'),'output "broken" {\n  value = var.missing\n}\n');
const ansible=join(root,'ansible');mkdirSync(ansible);const playbook=join(ansible,'site.yml');writeFileSync(playbook,'---\n- name: Local syntax check\n  hosts: localhost\n  gather_facts: false\n  tasks:\n    - name: Message\n      ansible.builtin.debug:\n        msg: Hello\n');
const run=(command,args,cwd)=>execute(command,args,cwd,{env:{...process.env,CHECKPOINT_DISABLE:'1',ANSIBLE_LOCAL_TEMP:join(root,'ansible-tmp'),ANSIBLE_REMOTE_TEMP:join(root,'ansible-remote')}});
let failures=0;
for(const command of ['terraform','tofu'])try{
 const r=await run(command,['validate','-json'],tf);assert.notEqual(r.code,0);const data=JSON.parse(r.stdout);assert.equal(data.valid,false);assert.ok(data.diagnostics.some(d=>d.range?.filename?.endsWith('main.tf')));console.log(command+': real validation failure includes source diagnostics');
}catch(e){failures++;console.error(String(e));}
try{const r=await run('ansible-playbook',['--syntax-check',playbook],ansible);assert.equal(r.code,0,r.stderr);console.log('Ansible: local playbook syntax check passed');}catch(e){failures++;console.error(String(e));}
const invalid=join(ansible,'invalid.yml');writeFileSync(invalid,'---\n- hosts: localhost\n  tasks: [\n');
try{const r=await run('ansible-playbook',['--syntax-check',invalid],ansible);assert.notEqual(r.code,0);assert.ok((r.stdout+r.stderr).includes('invalid.yml'));console.log('Ansible: invalid syntax reports its source file');}catch(e){failures++;console.error(String(e));}
for(const [command,args] of [['tflint',['--format=json']],['ansible-lint',['--offline','--nocolor','-f','sarif',playbook]],['python3',['-I','-c',"import importlib.metadata\ntry: print(importlib.metadata.version('ansibug'))\nexcept importlib.metadata.PackageNotFoundError: raise SystemExit(3)"]]]) {
 try {
  const version=await run(command,command==='python3'?args:['--version'],root);
  if(command==='python3' && version.code===3){console.log('Ansibug: SKIPPED (not installed)');continue;}
  assert.equal(version.code,0,command+' version check failed: '+version.stderr);
  if(command==='python3'){console.log('Ansibug: installed module version '+version.stdout.trim()+'; attach flow still needs a live debugger test');continue;}
  const result=await run(command,args,command==='tflint'?tf:ansible);
  assert.ok([0,2].includes(result.code),command+' failed: '+result.stderr);
  const data=JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
  assert.ok(command==='tflint'?Array.isArray(data.issues):Array.isArray(data.runs));
  console.log(command+': live JSON diagnostics parsed (exit '+result.code+')');
 }catch(e){if(e.code==='ENOENT')console.log(command+': SKIPPED (not installed)');else{failures++;console.error(command+': '+String(e));}}
}
console.log('Fixtures: '+root);process.exitCode=failures?1:0;
