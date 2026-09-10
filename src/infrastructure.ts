import type {Task} from './workflows.ts';
export type InfrastructureKind='Terraform'|'OpenTofu'|'Ansible';
export function infrastructureLanguage(path:string):string|undefined{
 const p=path.replace(/\\/g,'/').toLowerCase();
 if(/\.(tf|tfvars|tofu|tofuvars|tfstate)\.json$/.test(p)||/\.tfstate(\.backup)?$/.test(p))return 'json';
 if(/\.(tf|tfvars|tofu|tofuvars|tftest\.hcl)$/.test(p))return 'hcl';
 if(/\.(ya?ml)(\.j2)?$/.test(p)&&(/(^|\/)(roles|playbooks|group_vars|host_vars|tasks|handlers)\//.test(p)||/(^|\/)(playbook|playbooks|site|requirements)\.ya?ml$/.test(p)))return 'ansible';
 if(/(^|\/)(ansible\.cfg|inventory|hosts(\.ini)?)$/.test(p))return 'ini';
 return undefined;
}
export function detectInfrastructure(files:string[]):InfrastructureKind[]{
 const result=new Set<InfrastructureKind>();
 for(const name of files){const p=name.toLowerCase();if(/\.(tf|tfvars)(\.json)?$/.test(p)||p==='.terraform.lock.hcl'){result.add('Terraform');result.add('OpenTofu');}if(/\.(tofu|tofuvars)(\.json)?$/.test(p))result.add('OpenTofu');if(['ansible.cfg','roles','playbooks','group_vars','host_vars','.ansible-lint','.ansible-lint.yml'].includes(p)||/^(site|playbooks?)\.ya?ml$/.test(p))result.add('Ansible');}
 return [...result];
}
function terraformTasks(command:string):Record<string,Task>{return {
 init:{command,args:['init','-backend=false','-input=false']},
 format:{command,args:['fmt','-recursive']},
 'format-check':{command,args:['fmt','-check','-diff','-recursive']},
 validate:{command,args:['validate','-json'],dependsOn:['init']},
 lint:{command:'tflint',args:['--format=json']},
 plan:{command,args:['plan','-input=false','-no-color','-out=plan.out']},
 'trace-plan':{command,args:['plan','-input=false','-no-color','-out=plan.out'],env:{TF_LOG:'TRACE'}},
 'show-plan':{command,args:['show','-json','plan.out']},
 test:{command,args:['test','-no-color']},
};}
export const infrastructureTasks:Record<InfrastructureKind,Record<string,Task>>={Terraform:terraformTasks('terraform'),OpenTofu:terraformTasks('tofu'),Ansible:{
 syntax:{command:'ansible-playbook',args:['--syntax-check','${file}']},
 lint:{command:'ansible-lint',args:['--offline','--nocolor','-f','sarif','${file}']},
 check:{command:'ansible-playbook',args:['--check','--diff','${file}']},
 'list-tasks':{command:'ansible-playbook',args:['--list-tasks','${file}']},
 'debug-listen':{command:'python3',args:['-m','ansibug','listen','--addr','tcp://127.0.0.1:4712','${file}'],timeoutSeconds:3600},
}};
export type InfrastructureDiagnostic={path:string;line:number;column:number;message:string;severity:'error'|'warning'|'info';source:string};
function diagnosticPath(path:unknown,root:string):string|undefined{
 if(typeof path!=='string'||!path)return undefined;
 let p=path.replace(/\\/g,'/');if(p.startsWith('file://')){try{p=decodeURIComponent(new URL(p).pathname);}catch{return undefined;}}
 if(p.split('/').includes('..')||p.includes('\0'))return undefined;
 if(!p.startsWith('/'))p=root.replace(/\/$/,'')+'/'+p.replace(/^\.\//,'');
 return p.startsWith(root.replace(/\/$/,'')+'/')?p:undefined;
}
export function parseInfrastructureDiagnostics(text:string,root:string,source:string):InfrastructureDiagnostic[]{
 // Tools may prepend a non-JSON warning. Parse the complete trailing JSON object.
 const start=text.indexOf('{');if(start<0)throw new Error('Tool did not return JSON diagnostics; see output');const data=JSON.parse(text.slice(start));const result:InfrastructureDiagnostic[]=[];
 const add=(path:unknown,line:any,column:any,message:any,severity:any)=>{const normalized=diagnosticPath(path,root);if(normalized)result.push({path:normalized,line:Math.max(1,Number(line)||1),column:Math.max(1,Number(column)||1),message:String(message??'Diagnostic'),severity:severity==='error'?'error':severity==='warning'?'warning':'info',source});};
 for(const d of data.diagnostics??[])add(d.range?.filename,d.range?.start?.line,d.range?.start?.column,[d.summary,d.detail].filter(Boolean).join('\n'),d.severity);
 for(const d of data.issues??[])add(d.range?.filename,d.range?.start?.line,d.range?.start?.column,d.message,d.rule?.severity??'warning');
 for(const run of data.runs??[])for(const d of run.results??[]){const location=d.locations?.[0]?.physicalLocation;add(location?.artifactLocation?.uri,location?.region?.startLine,location?.region?.startColumn,d.message?.text,d.level??'warning');}
 return result;
}
export const infrastructureSnippets={
 hcl:[{label:'resource',body:'resource "${1:type}" "${2:name}" {\n\t$0\n}'},{label:'variable',body:'variable "${1:name}" {\n\ttype = ${2:string}\n\tdescription = "${3:Description}"\n}'},{label:'output',body:'output "${1:name}" {\n\tvalue = ${2:expression}\n}'},{label:'module',body:'module "${1:name}" {\n\tsource = "${2:./modules/example}"\n\t$0\n}'},{label:'locals',body:'locals {\n\t${1:name} = ${2:value}\n}'}],
 ansible:[{label:'playbook',body:'---\n- name: ${1:Play name}\n  hosts: ${2:all}\n  gather_facts: false\n  tasks:\n    - name: ${3:Task name}\n      ansible.builtin.debug:\n        msg: "${4:Hello}"'},{label:'task',body:'- name: ${1:Task name}\n  ansible.builtin.${2:debug}:\n    ${3:msg}: ${4:value}'},{label:'block',body:'- name: ${1:Block name}\n  block:\n    - name: ${2:Task}\n      ansible.builtin.debug:\n        msg: "${3:Message}"\n  rescue:\n    - name: Handle failure\n      ansible.builtin.debug:\n        msg: "Task failed"'}]
};
