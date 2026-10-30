import test from 'node:test';import assert from 'node:assert/strict';
import {cardAction,knowledgeDate} from '../worker/cards.js';
import {context,draft,reviewRequest} from './fixtures/cloud-context.mjs';
test('missing evidence can remain pending but cannot become pass',async()=>{
 const ctx=context();const first=await cardAction('intake',draft(),ctx);const q=await reviewRequest(first.card);q.verdict='uncertain';q.evidence=[];q.rationale='无法取得原始来源，待补';
 const saved=await cardAction('review_submit',q,ctx);assert.equal(saved.status,'succeeded');assert.equal(saved.card.status,'pending_review');
 assert.equal((await cardAction('publish',{card_id:first.card.card_id},ctx)).status,'blocked');
 const next={...q,expected_version:saved.card.version,verdict:'pass'};assert.equal((await cardAction('review_submit',next,ctx)).status,'invalid_input');
});
test('knowledge dates use Asia/Shanghai at UTC midnight boundaries',()=>{
 assert.equal(knowledgeDate('2026-10-25T20:00:00Z'),'2026-10-26');
 assert.equal(knowledgeDate('2026-10-25T01:00:00Z'),'2026-10-25');
});
