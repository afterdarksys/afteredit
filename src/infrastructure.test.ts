import {test} from 'node:test';import assert from 'node:assert/strict';
import {infrastructureLanguage,detectInfrastructure,parseInfrastructureDiagnostics,infrastructureTasks} from './infrastructure.ts';
import {taskOrder} from './workflows.ts';
test('recognizes Terraform/OpenTofu and Ansible project conventions without claiming generic YAML',()=>{
 assert.equal(infrastructureLanguage('/repo/main.tofu'),'hcl');assert.equal(infrastructureLanguage('/repo/secrets.tfvars.json'),'json');assert.equal(infrastructureLanguage('/repo/terraform.tfstate'),'json');assert.equal(infrastructureLanguage('/repo/roles/web/tasks/main.yml'),'ansible');assert.equal(infrastructureLanguage('/repo/compose.yaml'),undefined);
 assert.deepEqual(detectInfrastructure(['main.tf','roles']),['Terraform','OpenTofu','Ansible']);
 for(const tasks of Object.values(infrastructureTasks))for(const name of Object.keys(tasks))assert.ok(taskOrder(tasks,[name]).length);
});
test('normalizes Terraform, TFLint and Ansible SARIF diagnostics and rejects outside paths',()=>{
 const terraform=parseInfrastructureDiagnostics(JSON.stringify({diagnostics:[{severity:'error',summary:'Unknown variable',range:{filename:'main.tf',start:{line:3,column:4}}}]}),'/repo','Terraform');assert.equal(terraform[0].path,'/repo/main.tf');assert.equal(terraform[0].line,3);
 assert.equal(parseInfrastructureDiagnostics(JSON.stringify({issues:[{message:'Bad',rule:{severity:'warning'},range:{filename:'../outside.tf',start:{line:1}}}]}),'/repo','TFLint').length,0);
 const ansible=parseInfrastructureDiagnostics(JSON.stringify({runs:[{results:[{level:'error',message:{text:'Bad task'},locations:[{physicalLocation:{artifactLocation:{uri:'roles/web/tasks/main.yml'},region:{startLine:8,startColumn:2}}}]}]}]}),'/repo','Ansible');assert.equal(ansible[0].line,8);assert.equal(ansible[0].severity,'error');
});
