import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { seed } from './fixtures.mjs';
import { id, failure, scope, fingerprint, numericChange, fresh, invalidate, validateDecisions, taskStatus, apply, undo } from './domain.mjs';
import { judge } from './model.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
try{process.loadEnvFile(path.join(root,'.env'));}catch(e){if(e.code!=='ENOENT')throw e;}
const runtime=process.env.WORKSPACE_STATE_DIR||path.join(root,'runtime');await fs.mkdir(runtime,{recursive:true});
const stateFile=path.join(runtime,'workspace.json');
let state;try{state=JSON.parse(await fs.readFile(stateFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;state=seed();await fs.writeFile(stateFile,JSON.stringify(state,null,2));}
let tail=Promise.resolve();
function transact(fn){const job=tail.then(async()=>{const next=structuredClone(state),result=fn(next);next.revision++;await fs.writeFile(stateFile+'.tmp',JSON.stringify(next,null,2));await fs.rename(stateFile+'.tmp',stateFile);state=next;return result;});tail=job.catch(()=>{});return job;}
const app=express();app.use(express.json({limit:'500kb'}));
app.get('/api/config',(_q,r)=>r.json({keyConfigured:!!process.env.DEEPSEEK_API_KEY,model:process.env.DEEPSEEK_MODEL||'deepseek-chat',defaultMode:process.env.DEEPSEEK_API_KEY?'deepseek':'demo'}));
app.get('/api/workspace',(_q,r)=>r.json(state));
app.patch('/api/documents/:id/content',async(q,r)=>{
 const result=await transact(s=>{const doc=s.documents.find(d=>d.id===q.params.id);if(!doc||doc.writeMode!=='editable')throw failure('NOT_EDITABLE','这份资料不能直接编辑。');if(doc.revision!==q.body.expectedRevision)throw failure('SAVE_CONFLICT','资料已变化，请刷新后重试。',409);if(!Array.isArray(q.body.blocks))throw failure('BAD_INPUT','缺少段落内容。');let changed=false;for(const b of q.body.blocks){if(typeof b.text!=='string'||b.text.length>10000)throw failure('BAD_INPUT','段落内容无效或过长。');const f=s.fragments.find(f=>f.id===b.id&&f.documentId===doc.id);if(!f)throw failure('NO_BASELINE','第一版只支持编辑已有段落。');if(f.text!==b.text){f.text=b.text;f.revision++;changed=true;}}if(changed){doc.revision++;invalidate(s);}return {document:doc,fragments:s.fragments.filter(f=>f.documentId===doc.id)};});r.json(result);
});
app.patch('/api/documents/:id/scope',async(q,r)=>{
 await transact(s=>{const doc=s.documents.find(d=>d.id===q.params.id),src=s.documents.find(d=>d.id==='prd');if(!doc||doc.role==='source'||doc.isEffective!==true||doc.syncGroupId!==src.syncGroupId||doc.sourceDocumentId!==src.id||!doc.indexed)throw failure('SCOPE_DISABLED','历史版本、其他同步组和未确认资料不能进入当前同步范围。');if(doc.revision!==q.body.expectedRevision)throw failure('SAVE_CONFLICT','资料状态已变化。',409);if(typeof q.body.followSource!=='boolean')throw failure('BAD_INPUT','范围标记无效。');doc.followSource=q.body.followSource;doc.revision++;invalidate(s);});r.json(state);
});
app.post('/api/checks',async(q,r)=>{
 const sourceDocumentId=q.body.sourceDocumentId||'prd',blockId=q.body.blockId,requestId=q.body.requestId||id();
 const existing=state.tasks.find(t=>t.requestId===requestId);if(existing){r.json(existing);return;}
 const doc=state.documents.find(d=>d.id===sourceDocumentId),f=state.fragments.find(f=>f.id===blockId&&f.documentId===sourceDocumentId);
 if(!doc||!f||doc.revision!==q.body.expectedRevision)throw failure('SAVE_CONFLICT','请先保存最新源内容，再检查。',409);
 const hist=state.histories[blockId];if(!hist)throw failure('NO_BASELINE','该段落没有可靠的修改前基线。',422);
 let change=numericChange(hist.lastCheckedText??hist.initialText,f.text);
 if(!change&&hist.lastKnownChange?.afterText===f.text)change=hist.lastKnownChange;
 if(!change){r.json({id:id(),blockId,status:'no_change',change:null,proposals:[],decisions:[],coverage:{excluded:[],unchecked:[],candidateCount:0}});return;}
 const selection=scope(state,sourceDocumentId),mode=q.body.mode==='deepseek'?'deepseek':'demo';
 const task={id:id(),requestId,blockId,sourceDocumentId,sourceRevision:doc.revision,epoch:state.epoch,scopeFingerprint:fingerprint(state),candidateSnapshots:selection.included.map(f=>({id:f.id,text:f.text,revision:f.revision})),change,mode,proposals:[],decisions:[],status:'checking',coverage:{excluded:selection.excluded,unchecked:selection.unchecked,candidateCount:selection.included.length},createdAt:new Date().toISOString()};
 await transact(s=>{s.tasks.push(task);s.tasks=s.tasks.slice(-40);});
 try{
  const output=selection.included.length?await judge(selection.included,change,mode):{decisions:[]};
  const validated=validateDecisions(output,selection.included,change);
  const result=await transact(s=>{const t=s.tasks.find(x=>x.id===task.id);if(!t)throw failure('TASK_STALE','样例已重置，请重新检查。',409);if(!fresh(s,t)){t.status='stale';return t;}Object.assign(t,validated);t.status=taskStatus(t);s.histories[blockId].lastCheckedText=f.text;s.histories[blockId].lastKnownChange=change;
   // Previously confirmed readonly suggestions remain separate from the PDF original.
   for(const p of t.proposals){const prior=s.annotations.find(a=>a.status==='active'&&a.fragmentId===p.fragmentId&&a.suggestedText===p.afterText);if(prior)p.status='annotation_saved';}
   t.status=taskStatus(t);return t;});r.json(result);
 }catch(e){await transact(s=>{const t=s.tasks.find(t=>t.id===task.id);if(t){t.status='failed';t.error=e.message;}});throw e;}
});
app.get('/api/checks/:id',(q,r)=>{const t=state.tasks.find(t=>t.id===q.params.id);if(!t)throw failure('NOT_FOUND','检查记录不存在。',404);r.json(t);});
app.get('/api/proposals/:id/evidence',(q,r)=>{const p=state.tasks.flatMap(t=>t.proposals).find(p=>p.id===q.params.id);if(!p)throw failure('NOT_FOUND','建议不存在。',404);const f=state.fragments.find(f=>f.id===p.fragmentId);r.json({fragment:f,document:state.documents.find(d=>d.id===f.documentId),annotations:state.annotations.filter(a=>a.fragmentId===f.id&&a.status==='active')});});
app.post('/api/operations',async(q,r)=>{r.json(await transact(s=>apply(s,q.body.taskId,q.body.proposalIds,q.body.requestId||id())));});
app.post('/api/operations/:id/undo',async(q,r)=>{r.json(await transact(s=>undo(s,q.params.id,q.body.requestId||id())));});
app.post('/api/demo/reset',async(_q,r)=>{await transact(s=>{const next=seed(s.epoch+1);for(const k of Object.keys(s))delete s[k];Object.assign(s,next);});r.json(state);});
app.use('/assets',express.static(path.join(root,'public','assets')));
if(existsSync(path.join(root,'dist'))){app.use(express.static(path.join(root,'dist')));app.get('/',(_q,r)=>r.sendFile(path.join(root,'dist','index.html')));}
app.use((e,_q,r,_n)=>{const known=e.code&&e.status;r.status(known?e.status:500).json({error:{code:known?e.code:'STORAGE_ERROR',message:known?e.message:'服务保存或处理失败，请重试。',retryable:!known||e.status>=500}});});
const port=Number(process.env.PORT||3001);app.listen(port,'127.0.0.1',()=>console.log(`同文工作台 http://127.0.0.1:${port} · ${process.env.DEEPSEEK_API_KEY?'DeepSeek 已配置':'离线交互演示，未调用大模型'}`));
