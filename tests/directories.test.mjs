import test from 'node:test';
import assert from 'node:assert/strict';
import {context} from './fixtures/cloud-context.mjs';
import * as gov from '../worker/governance.js';
const dir=await import('../worker/directories.js').catch(()=>({}));
async function fixture(){
 const c=context(),folders=new Map(),writes=[];c.folderWrites=writes;c.folderLists=folders;
 c.invoke=async(d,q)=>{
  if(q.action==='folder.list')return {status:'succeeded',data:{items:folders.get(q.folder_id)||[],has_more:false}};
  if(q.action==='folder.create'){
   writes.push(q);const id='folder-'+writes.length;const item={kind:'folder',media_id:id,title:q.name};folders.set(q.folder_id,[...(folders.get(q.folder_id)||[]),item]);
   return {status:'succeeded',resource:{kb_id:q.kb_id,folder_id:id,parent_folder_id:q.folder_id,name:q.name}};
  }return {status:'unknown'};
 };
 assert.equal(typeof gov.upgradePolicy,'function');await gov.upgradePolicy(c);return c;
}
const paths=[{topics:['人工智能','大模型','提示词'],purpose:'学习与复用提示词方法',card_ids:['one']}];
test('propose never creates; confirmed paths support a fourth level with independent numbers',async()=>{
 const c=await fixture();const p=await dir.directoryAction('plan',{primary_category:'learning',paths},c);
 assert.equal(p.status,'preview');assert.equal(c.folderWrites.length,0);assert.deepEqual(p.plan.nodes.map(n=>n.name),['01_人工智能','01_大模型','01_提示词']);
 assert.equal((await dir.directoryAction('apply',{plan_id:p.plan.plan_id,revision:1,decision:'confirm'},c)).status,'invalid_input');assert.equal(c.folderWrites.length,0);
 const r=await dir.directoryAction('apply',{plan_id:p.plan.plan_id,revision:1,decision:'confirm',confirmation:'确认本批完整路径'},c);
 assert.equal(r.status,'succeeded',JSON.stringify(r));assert.equal(c.folderWrites.length,3);
 const target=r.plan.nodes.at(-1).directory_id,record=await dir.resolveDirectory(c,'learning',target);assert.equal(record.depth,4);
 await assert.rejects(()=>dir.resolveDirectory(c,'health',target),/category|classification/);
 const again=await dir.directoryAction('apply',{plan_id:p.plan.plan_id,revision:1,decision:'confirm',confirmation:'确认本批完整路径'},c);assert.equal(again.status,'succeeded');assert.equal(c.folderWrites.length,3);
});
test('decline creates nothing, edits invalidate old confirmation and new numbering never renumbers siblings',async()=>{
 const c=await fixture();c.folderLists.set('folder-learning',[{kind:'folder',media_id:'old-folder',title:'03_逻辑'}]);
 const p=await dir.directoryAction('plan',{primary_category:'learning',paths:[{topics:['人工智能'],purpose:'明确主题'}]},c);assert.equal(p.plan.nodes[0].name,'04_人工智能');
 const edit=await dir.directoryAction('plan',{primary_category:'learning',paths:[{topics:['证据评价'],purpose:'核查方法'}],plan_id:p.plan.plan_id,expected_revision:1},c);assert.equal(edit.plan.revision,2);
 assert.equal((await dir.directoryAction('apply',{plan_id:p.plan.plan_id,revision:1,decision:'confirm',confirmation:'确认'},c)).status,'conflict');
 assert.equal((await dir.directoryAction('apply',{plan_id:p.plan.plan_id,revision:2,decision:'decline',confirmation:'不新建，使用已有目录'},c)).status,'succeeded');assert.equal(c.folderWrites.length,0);
});
test('unknown creation keeps original request and reconciliation never submits a fresh create',async()=>{
 const c=await fixture(),invoke=c.invoke;let first=true;
 c.invoke=async(d,q)=>{if(q.action==='folder.create'&&first){first=false;c.pendingRequest=q;return {status:'unknown'};}return invoke(d,q);};
 const p=await dir.directoryAction('plan',{primary_category:'learning',paths:[{topics:['人工智能'],purpose:'学习'}]},c);
 const q={plan_id:p.plan.plan_id,revision:1,decision:'confirm',confirmation:'确认'};
 assert.equal((await dir.directoryAction('apply',q,c)).status,'unknown');
 const before=c.pendingRequest.request_id;assert.notEqual((await dir.directoryAction('apply',q,c)).status,'succeeded');
 c.invoke=async(d,r)=>{if(r.action==='folder.create'){assert.equal(r.request_id,before);assert.equal(r.reconcile,true);}return invoke(d,r);};
 assert.equal((await dir.directoryAction('apply',{...q,reconcile:true},c)).status,'succeeded');
});
test('a concurrent sibling consuming the proposed number requires a revised user confirmation',async()=>{
 const c=await fixture(),p=await dir.directoryAction('plan',{primary_category:'learning',paths:[{topics:['人工智能'],purpose:'学习'}]},c);
 c.folderLists.set('folder-learning',[{kind:'folder',media_id:'external',title:'01_其他主题'}]);
 const q={plan_id:p.plan.plan_id,revision:1,decision:'confirm',confirmation:'确认'};
 const conflict=await dir.directoryAction('apply',q,c);assert.equal(conflict.status,'conflict');assert.equal(c.folderWrites.length,0);
 const revised=await dir.directoryAction('plan',{plan_id:p.plan.plan_id,expected_revision:1,primary_category:'learning',paths:[{topics:['人工智能'],purpose:'学习'}]},c);assert.equal(revised.status,'preview');assert.equal(revised.plan.nodes[0].name,'02_人工智能');
 assert.equal((await dir.directoryAction('apply',q,c)).status,'conflict');
});
