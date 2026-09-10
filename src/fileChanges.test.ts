import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileDisk} from './fileChanges.ts';
test('external changes reload clean files but preserve concurrent user edits',()=>{
 const clean={value:'old',saved:'old',disk:true};
 assert.equal(reconcileDisk(clean,'old','new').buffer.value,'new');
 const dirty={...clean,value:'mine'};
 assert.equal(reconcileDisk(dirty,'old','theirs').conflict,true);
 assert.equal(reconcileDisk(dirty,'old','theirs').buffer.value,'mine');
 assert.equal(reconcileDisk({...dirty,saved:'mine'},'old','old').stale,true);
 assert.equal(reconcileDisk(dirty,'old','old').conflict,false);
});
