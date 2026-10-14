import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SQLiteStore } from '../server/infrastructure/sqlite-store.ts';
import { Workspace } from '../server/application/workspace.ts';
import { AgentService } from '../server/agent/service.ts';
import { AgentTools } from '../server/agent/tools.ts';
import { AgentRuntime } from '../server/agent/runtime.ts';
import { loadStrategyPack } from '../server/agent/tuning/load.ts';
import { confirmedCheck } from '../server/agent/confirmed-check.ts';
import { uid } from '../server/domain/rules.ts';
import type { ModelClient, Run } from '../server/agent/types.ts';

// Offline protocol tests. This simulated provider is never used by live validation.
function setup(filename=':memory:') {
  const store=new SQLiteStore(filename),workspace=new Workspace(store);
  const ids=workspace.importDocuments({scopeName:'离线关系协议测试',requestId:uid(),files:[
    {name:'规则.md',role:'sync',text:'# 费用规则\n\n本申请金额高于300元须财务完成复核后才能提交；等于阈值不追加复核；不自动付款。'},
    {name:'指南.md',role:'sync',text:'# 操作指南\n\n若本申请超过300元，先由财务复核完成，再提交；恰好达到门槛无需额外复核；系统不会自动支付。'}]}).imported;
  const service=new AgentService(store.agent,workspace,store,loadStrategyPack(path.resolve('server/agent/tuning/packs/scoped-clauses')));
  const tools=new AgentTools(store.agent,store);
  const sourceId=ids[0],targetId=ids[1];
  function edit(id:string,before:string,after:string) {const v=workspace.view(id);workspace.save(id,v.document.revision,
    v.version.blocks.map(b=>({...b,text:b.text.replace(before,after)})));}
  edit(sourceId,'300','400');
  const run=service.create({sourceMemberId:sourceId,memberIds:[targetId],requestId:uid(),relationMode:'full'});
  const exec=(name:string,args:any):any=>store.agent.transaction(()=>{const r=tools.execute(run,name,args);store.agent.saveRun(run);return r;});
  exec('read_context',{refIds:run.manifest.refs.map(r=>r.id),neighborDepth:0});
  const e=(id:string)=>{const e=run.evidence.find(e=>e.refId===id)!;return {evidenceId:e.id,quote:e.quote};};
  const c=exec('describe_change',{changes:[{deltaIds:[run.deltas[0].id],kind:'rule',businessObject:'本申请费用复核门槛',
    summary:'门槛改为400元',before:[e(run.deltas[0].beforeRefId!)],after:[e(run.deltas[0].afterRefId!)]}]}).changes[0];
  const target=run.manifest.refs.find(r=>r.memberId===targetId&&r.kind==='paragraph')!;
  exec('record_finding',{findings:[{changeId:c.id,refId:target.id,status:'needs_update',reason:'同一申请费用门槛',
    relation:{type:'implements',coverageMode:'complete',reason:'指南承载同一业务规则'}}]});
  const p=exec('propose_patch',{changeId:c.id,targetRefIds:[target.id],patches:[{kind:'replace_text',refId:target.id,
    before:'300',after:'400'}],reason:'仅同步本次变化的门槛'});
  const after=target.text.replace('300','400');
  exec('review_document',{memberId:targetId,purpose:{kind:'procedure',refId:target.id},checks:c.obligations.map((q:any)=>({
    changeId:c.id,obligationId:q.id,targetRefIds:[target.id],outcome:q.source.quote.includes('400')?'patched':'current',
    targetWitness:{mode:'present',quote:after},reason:'核对门槛、等值边界及付款禁止保持'}))});
  exec('finish_task',{summary:'离线协议测试完成',unresolved:[]});
  assert.equal(store.agent.confirmedRelations().length,0,'model relation alone is not accepted cross-run knowledge');
  const applied=service.apply(run.id,{proposalIds:[p.proposalId],requestId:uid()});
  const checkpoint=workspace.view(sourceId).version.id;
  edit(sourceId,'400','300');
  function next(mode:'auto'|'full'='auto') {return service.create({sourceMemberId:sourceId,memberIds:[targetId],requestId:uid(),
    relationMode:mode,...(mode==='full'?{baselineVersionId:checkpoint}:{})});}
  return {store,workspace,service,tools,sourceId,targetId,run,applied,checkpoint,next,edit};
}
function fakeResult(overrides:any={}):ModelClient {
  return {async complete(messages) {const input=JSON.parse(messages[1].content!);
    const before=input.source.before.match(/\d+/)[0],after=input.source.after.match(/\d+/)[0];
    const candidate=input.target.text.replace(before,after);
    const result={validity:'valid',reason:'对象范围和规则仍一致',businessObject:'本申请费用复核门槛',summary:'同步新门槛',
      status:'needs_update',patches:[{before,after}],purpose:'procedure',checks:input.sourceObligations.map((q:any)=>({
        obligationId:q.id,outcome:q.source.quote.includes(after)?'patched':'current',witness:candidate,reason:'实际目标保留条件及边界'})),...overrides};
    return {message:{role:'assistant',content:null,tool_calls:[{id:uid(),type:'function',function:{
      name:'confirmed_check_result',arguments:JSON.stringify(result)}}]},usage:{input:10,output:10,estimated:false},model:'offline-test'};
  }};
}

test('accepted relation survives reopening and reverting a value compares against the latest merged source',()=>{
  const filename=path.join(mkdtempSync(path.join(tmpdir(),'relation-protocol-')),'test.sqlite');
  const s=setup(filename);const saved=s.store.agent.confirmedRelations()[0];
  assert.equal(saved.sourceVersionId,s.checkpoint);assert.equal(saved.direction,'source_to_target');
  assert.notEqual(saved.targetVersionId,s.run.manifest.views.find(v=>v.member.id===s.targetId)!.version.id);
  s.store.close();const reopened=new SQLiteStore(filename);
  const workspace=new Workspace(reopened),service=new AgentService(reopened.agent,workspace,reopened,
    loadStrategyPack(path.resolve('server/agent/tuning/packs/scoped-clauses')));
  const run=service.create({sourceMemberId:s.sourceId,memberIds:[s.targetId],requestId:uid(),relationMode:'auto'});
  assert.equal(run.manifest.source.baseline.id,s.checkpoint);assert.equal(run.deltas.length,1);
  assert.ok(run.deltas[0].before!.text.includes('400'));assert.ok(run.deltas[0].after!.text.includes('300'));
  assert.equal(run.relationReuse?.relation.id,saved.id);reopened.close();
});
test('hot execution uses one fresh provider result, preserves full review, merge, reload and undo guards',async()=>{
  const s=setup(),before=s.workspace.view(s.targetId).version.id,run=s.next();
  const runtime=new AgentRuntime(s.service,fakeResult(),{auditInputs:true});runtime.start(run.id);
  const report=await runtime.wait(run.id);
  assert.equal(report.status,'awaiting_review');assert.equal(report.stats.modelCalls,1);
  assert.equal(report.relationReuse?.state,'verified');assert.equal(report.documentReview!.complete,true);
  assert.equal(report.stats.toolCalls,1);assert.equal(report.relationReuse?.executorToolCalls,6);
  assert.equal(report.coverage.complete,true);assert.equal(s.workspace.view(s.targetId).version.id,before);
  assert.equal(report.proposals.length,1);assert.equal(report.proposals[0].applicable,true);
  const merged=s.service.apply(run.id,{proposalIds:[report.proposals[0].id],requestId:uid()});
  assert.ok(s.workspace.view(s.targetId).version.blocks.some(b=>b.text.includes('300')));
  assert.equal(s.store.agent.confirmedRelations()[0].sourceVersionId,run.manifest.source.version.id);
  s.service.undoBatch(merged.batch!.id,uid());
  assert.equal(s.store.agent.confirmedRelations()[0].status,'invalidated');
  assert.equal(s.service.report(run.id).proposals[0].applicable,false);s.store.close();
});
test('full review ignores relation acceleration while keeping the identical second-change baseline',()=>{
  const s=setup(),run=s.next('full');assert.equal(run.relationReuse,undefined);
  assert.equal(run.manifest.source.baseline.id,s.checkpoint);s.store.close();
});
for(const [name,mutate] of [
  ['target independently changed',(s:any)=>s.edit(s.targetId,'先由财务','先由经理')],
  ['source business meaning changed',(s:any)=>s.edit(s.sourceId,'本申请','所有申请')],
  ['target endpoint deleted',(s:any)=>{const v=s.workspace.view(s.targetId);s.workspace.save(s.targetId,v.document.revision,v.version.blocks.filter((b:any)=>b.kind==='heading'));}],
  ['scope policy changed',(s:any)=>s.store.bumpScope(s.workspace.view(s.sourceId).scope.id)],
] as const) test(name+' invalidates cached relationship instead of applying it',()=>{
  const s=setup();mutate(s);
  if(name==='target endpoint deleted')assert.throws(()=>s.next(),/缺少正文/);
  else assert.equal(s.next().relationReuse,undefined);
  assert.equal(s.store.agent.confirmedRelations()[0].status,'invalidated');s.store.close();
});
test('omitting source clauses rolls back the proposed patch and does not grant confirmation',async()=>{
  const s=setup(),run=s.next();run.status='running';run.stats.startedAt=Date.now();s.store.agent.saveRun(run);
  assert.equal(await confirmedCheck(s.service,fakeResult({checks:[]}),s.tools,run,new AbortController().signal,true),'fallback');
  assert.equal(s.store.agent.proposals(run.id).length,0);assert.equal(s.service.report(run.id).coverage.complete,false);
  assert.equal(s.store.agent.confirmedRelations()[0].status,'invalidated');s.store.close();
});
test('cancellation during fast request never commits late effects',async()=>{
  const s=setup(),run=s.next();let release!:()=>void;
  const wait=new Promise<void>(r=>{release=r;});let started!:()=>void;const entered=new Promise<void>(r=>{started=r;});
  const model:ModelClient={async complete(...args){started();await wait;return fakeResult().complete(...args);}};
  const runtime=new AgentRuntime(s.service,model);runtime.start(run.id);await entered;
  runtime.cancel(run.id);release();const report=await runtime.wait(run.id);
  assert.equal(report.status,'cancelled');assert.equal(report.proposals.length,0);assert.equal(report.stats.modelCalls,1);s.store.close();
});
test('target change during the fast request blocks an otherwise valid late proposal',async()=>{
  const s=setup(),run=s.next();const inner=fakeResult();
  const model:ModelClient={async complete(...args){const response=await inner.complete(...args);s.edit(s.targetId,'先由财务','先由经理');return response;}};
  const runtime=new AgentRuntime(s.service,model);runtime.start(run.id);const report=await runtime.wait(run.id);
  assert.equal(report.proposals.length,0);assert.equal(report.inputValid,false);s.store.close();
});
