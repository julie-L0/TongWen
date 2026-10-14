import { createHash, randomUUID } from 'node:crypto';
export const id=()=>randomUUID();
export function failure(code,message,status=400){return Object.assign(new Error(message),{code,status});}
export function numericChange(before,after){
  if(before===after)return null;
  if(/\d\.\d/.test(before+after))throw failure('UNSUPPORTED_CHANGE','第一版暂支持单个整数参数修改，其他文字和单位请保持不变。',422);
  const a=before.split(/(\d+)/),b=after.split(/(\d+)/);
  if(a.length!==b.length)throw failure('UNSUPPORTED_CHANGE','请只修改一个整数参数，暂不支持新增或改写规则。',422);
  const changed=a.map((v,i)=>v===b[i]?-1:i).filter(i=>i>=0);
  if(changed.length!==1||changed[0]%2!==1)throw failure('UNSUPPORTED_CHANGE','请只修改一个整数参数，其他文字和单位保持不变。',422);
  const unit=(b[changed[0]+1]||'').match(/^\s*(天|次|元|小时)/)?.[1]||'';
  return {oldValue:a[changed[0]],newValue:b[changed[0]],unit,beforeText:before,afterText:after};
}
export function scope(state,sourceId='prd'){
  const src=state.documents.find(d=>d.id===sourceId);if(!src||src.isEffective!==true||src.role!=='source')throw failure('INVALID_SOURCE','源 PRD 配置无效。');
  const included=[],excluded=[],unchecked=[];
  for(const d of state.documents.filter(d=>d.id!==sourceId)){
    if(d.isEffective===null||!d.indexed){unchecked.push({documentId:d.id,reason:'资料生效状态或索引未确认'});continue;}
    let reason=d.isEffective!==true?'历史版本未生效':d.syncGroupId!==src.syncGroupId||d.sourceDocumentId!==src.id?'属于其他同步组':!d.followSource?'独立规则，不跟随当前 PRD':null;
    if(reason){excluded.push({documentId:d.id,reason});continue;}
    for(const f of state.fragments.filter(f=>f.documentId===d.id))if(f.excludedFromSync)excluded.push({documentId:d.id,fragmentId:f.id,reason:'片段独立规则'});else included.push(f);
  }
  return {included,excluded,unchecked};
}
export function fingerprint(state){return createHash('sha256').update(JSON.stringify(state.documents.map(d=>[d.id,d.isEffective,d.followSource,d.syncGroupId,d.sourceDocumentId,d.indexed]).sort())).update(JSON.stringify(state.fragments.map(f=>[f.id,f.excludedFromSync]).sort())).digest('hex');}
export function fresh(state,task){return task.epoch===state.epoch&&task.sourceRevision===state.documents.find(d=>d.id===task.sourceDocumentId)?.revision&&task.scopeFingerprint===fingerprint(state)&&task.candidateSnapshots.every(s=>{const f=state.fragments.find(f=>f.id===s.id);return f&&f.revision===s.revision&&f.text===s.text;});}
export function invalidate(state){for(const t of state.tasks)if(t.status!=='failed'&&!fresh(state,t))t.status='stale';}
export function proposalFrom(f,decision,change){
  const anchor=decision.anchorText;
  if(typeof anchor!=='string'||!anchor.length)return null;
  const start=f.text.indexOf(anchor);
  if(start<0||f.text.indexOf(anchor,start+1)>=0)return null;
  const numbers=[...anchor.matchAll(/\d+/g)];if(numbers.length!==1||/\d\.\d/.test(anchor))return null;
  const n=numbers[0];if(n[0]===change.newValue)return null;
  const at=start+n.index;
  const after=f.text.slice(0,at)+change.newValue+f.text.slice(at+n[0].length);
  return {id:id(),fragmentId:f.id,documentId:f.documentId,title:f.title,beforeText:f.text,afterText:after,anchorText:anchor,prefix:f.text.slice(0,at),oldValue:n[0],newValue:change.newValue,suffix:f.text.slice(at+n[0].length),reason:decision.reason,expectedRevision:f.revision,status:'pending'};
}
export function validateDecisions(payload,candidates,change){
  if(!payload||!Array.isArray(payload.decisions))throw failure('MODEL_OUTPUT_INVALID','模型没有返回可识别的判断结果。',502);
  const allowed=new Set(candidates.map(f=>f.id)),seen=new Set(),decisions=[],proposals=[];
  for(const raw of payload.decisions){
    if(!raw||!allowed.has(raw.fragmentId)||seen.has(raw.fragmentId)||!['needs_update','already_current','unrelated','uncertain'].includes(raw.relation)||typeof raw.reason!=='string'||raw.reason.length>700)throw failure('MODEL_OUTPUT_INVALID','模型返回了重复片段、未知来源或无效分类。',502);
    seen.add(raw.fragmentId);const dec={...raw};
    const f=candidates.find(f=>f.id===dec.fragmentId);
    if(dec.relation==='needs_update'){
      const p=proposalFrom(f,dec,change);
      if(p)proposals.push(p);else{
        const anchor=dec.anchorText,at=typeof anchor==='string'?f.text.indexOf(anchor):-1;
        if(at>=0&&anchor.length&&f.text.indexOf(anchor,at+1)<0&&anchor.match(/\d+/g)?.length===1&&anchor.match(/\d+/)?.[0]===change.newValue){dec.relation='already_current';dec.reason='目标参数已等于源新值，无需重复修改。';}
        else{dec.relation='uncertain';dec.reason='无法唯一定位要修改的参数，请查看原文人工核对。';}
      }
    }
    decisions.push(dec);
  }
  for(const f of candidates)if(!seen.has(f.id))decisions.push({fragmentId:f.id,relation:'uncertain',reason:'本次模型未完成该片段的判断。',anchorText:null});
  return {decisions,proposals};
}
export function taskStatus(task){if(task.status==='stale'||task.status==='failed')return task.status;const pending=task.proposals.filter(p=>['pending','failed'].includes(p.status)).length,done=task.proposals.length-pending;if(pending)return done?'partial':'ready';if(done)return 'completed';return task.decisions.some(d=>d.relation==='uncertain')?'needs_review':'no_updates';}
export function apply(state,taskId,proposalIds,requestId){
  if(state.requestResults[requestId])return state.requestResults[requestId];
  const task=state.tasks.find(t=>t.id===taskId);if(!task||!fresh(state,task)||task.status==='stale')throw failure('TASK_STALE','源内容、资料或同步范围已变化，请重新检查。',409);
  if(!Array.isArray(proposalIds)||!proposalIds.length||proposalIds.some(x=>!task.proposals.some(p=>p.id===x)))throw failure('INVALID_SELECTION','请选择本轮检查中的修改建议。');
  const results=[],successfulChanges=[];
  for(const pid of new Set(proposalIds)){
    const p=task.proposals.find(p=>p.id===pid);
    if(['applied','annotation_saved'].includes(p.status)){results.push({proposalId:pid,status:'already_processed'});continue;}
    const f=state.fragments.find(f=>f.id===p.fragmentId),doc=state.documents.find(d=>d.id===f.documentId);
    if(f.text!==p.beforeText||f.revision!==p.expectedRevision){p.status='failed';results.push({proposalId:pid,status:'failed',message:'目标内容已变化'});continue;}
    if(doc.writeMode==='editable'){
      successfulChanges.push({kind:'text',fragmentId:f.id,before:f.text,after:p.afterText});f.text=p.afterText;f.revision++;doc.revision++;p.status='applied';
    }else{
      const old=state.annotations.filter(a=>a.fragmentId===f.id&&a.status==='active').map(a=>a.id);
      for(const a of state.annotations.filter(a=>old.includes(a.id)))a.status='superseded';
      const annotation={id:id(),fragmentId:f.id,documentId:doc.id,beforeText:f.text,suggestedText:p.afterText,proposalId:p.id,sourceChange:task.change,status:'active',createdAt:new Date().toISOString()};state.annotations.push(annotation);
      successfulChanges.push({kind:'annotation',annotationId:annotation.id,previousActiveIds:old});p.status='annotation_saved';
    }
    results.push({proposalId:pid,status:p.status});
  }
  for(const snap of task.candidateSnapshots){const f=state.fragments.find(f=>f.id===snap.id);snap.text=f.text;snap.revision=f.revision;}
  const batch={id:id(),requestId,taskId,results,successfulChanges,createdAt:new Date().toISOString(),undoneAt:null};if(successfulChanges.length)state.batches.push(batch);
  task.status=taskStatus(task);invalidate(state);
  const result={batchId:successfulChanges.length?batch.id:null,results,task};state.requestResults[requestId]=result;return result;
}
export function undo(state,batchId,requestId){
  if(state.requestResults[requestId])return state.requestResults[requestId];
  const batch=state.batches.find(b=>b.id===batchId),latest=state.batches.filter(b=>!b.undoneAt).at(-1);
  if(!batch||batch.undoneAt||latest?.id!==batchId)throw failure('UNDO_CONFLICT','只能撤销最近一次未撤销的修改。',409);
  for(const c of batch.successfulChanges){if(c.kind==='text'&&state.fragments.find(f=>f.id===c.fragmentId)?.text!==c.after)throw failure('UNDO_CONFLICT','目标后来已被修改，不能覆盖后续内容。',409);if(c.kind==='annotation'&&state.annotations.find(a=>a.id===c.annotationId)?.status!=='active')throw failure('UNDO_CONFLICT','修订建议后来已有变化，无法撤销这一批。',409);}
  for(const c of batch.successfulChanges){if(c.kind==='text'){const f=state.fragments.find(f=>f.id===c.fragmentId);f.text=c.before;f.revision++;state.documents.find(d=>d.id===f.documentId).revision++;}else{state.annotations.find(a=>a.id===c.annotationId).status='withdrawn';for(const a of state.annotations.filter(a=>c.previousActiveIds.includes(a.id)))a.status='active';}}
  const task=state.tasks.find(t=>t.id===batch.taskId);
  for(const r of batch.results)if(['applied','annotation_saved'].includes(r.status)){const p=task.proposals.find(p=>p.id===r.proposalId);p.status='pending';p.expectedRevision=state.fragments.find(f=>f.id===p.fragmentId).revision;}
  for(const snap of task.candidateSnapshots){const f=state.fragments.find(f=>f.id===snap.id);snap.text=f.text;snap.revision=f.revision;}
  batch.undoneAt=new Date().toISOString();task.status=taskStatus(task);invalidate(state);
  const result={undone:batch.id,task};state.requestResults[requestId]=result;return result;
}
