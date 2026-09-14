import test from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement,useState} from 'react';
import {useDebugTools} from './useDebugTools';
import {mountEnvironment,render,unmount} from './testing/dom';
test('watch replies arriving after resume cannot update values or create a snapshot',async()=>{
 mountEnvironment({read_file:'source'});let resolve!:(value:any)=>void;let tools!:ReturnType<typeof useDebugTools>;let resume!:()=>void;
 const frame={id:1,name:'main',source:{path:'/repo/main.c'},line:1};
 function Harness(){const [phase,setPhase]=useState('paused');resume=()=>setPhase('running');tools=useDebugTools({root:'/repo',phase,frame,thread:1,frames:[frame],variables:{},caps:{}},()=>new Promise(r=>resolve=r));return createElement('div',null,tools.values.map(v=>v.value).join(','));}
 try{await render(Harness,{});await act(async()=>tools.addWatch('value'));let pending!:Promise<void>;await act(async()=>{pending=tools.refresh();});assert.equal(tools.refreshing,true);await act(async()=>resume());await act(async()=>{resolve({result:'stale'});await pending;});assert.equal(tools.values.length,0);assert.equal(tools.snapshots.length,0);assert.equal(tools.refreshing,false);await assert.rejects(tools.readMemory('0x100',4),/Pause/);}finally{await unmount();}
});
test('unsupported inspection actions send no adapter requests',async()=>{
 const frame={id:1};
 mountEnvironment();let tools!:ReturnType<typeof useDebugTools>,calls=0;
 function Harness(){tools=useDebugTools({root:'/repo',phase:'paused',frame,thread:1,frames:[],variables:{},caps:{}},async()=>{calls++;return {};});return createElement('div');}
 try{await render(Harness,{});await assert.rejects(tools.exceptionInfo(),/does not support/);await assert.rejects(tools.readMemory('0x100',1),/does not support/);await assert.rejects(tools.disassemble('0x100'),/does not support/);await assert.rejects(tools.dataBreakpoint(10,'x'),/does not support/);assert.equal(calls,0);}finally{await unmount();}
});
