import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fail } from '../domain/rules.ts';
import type { ModelClient, ModelMessage, Run } from '../agent/types.ts';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class DemoBudgetClient implements ModelClient {
  private inner:ModelClient;
  private filename:string;
  private taskId:string|null=null;
  private active=false;
  constructor(inner:ModelClient,filename:string){this.inner=inner;this.filename=filename;}
  get configuration(){return this.inner.configuration;}
  private read(){return JSON.parse(readFileSync(this.filename,'utf8'));}
  private save(value:any){writeFileSync(this.filename,JSON.stringify(value,null,2));}
  bind(run:Run,label:string){
    const ledger=this.read();
    if(this.active)fail('DEMO_TASK_ACTIVE','已有演示模型请求进行中。');
    if(ledger.tasks.length>=ledger.limits.tasks)fail('DEMO_TASK_LIMIT','已用完三个获批真实任务，不追加重试任务。');
    const views=run.manifest.views;
    if(views.length!==2 || views.some(v=>v.member.role!=='sync' || v.version.blocks.filter(b=>b.kind!=='heading').length!==1))
      fail('DEMO_BUSINESS_SCOPE','本授权只允许两份各一个正文段落的合成资料。');
    const allowed=ledger.business;
    for(const v of views){
      const source=v.member.id===run.manifest.sourceMemberId;
      const expected=source?allowed.source:allowed.target;
      const text=v.version.blocks.find(b=>b.kind!=='heading')!.text;
      const baseline=source?run.manifest.source.baseline.blocks.find(b=>b.kind!=='heading')!.text:text;
      if(v.document.title!==expected.title || !expected.versions.includes(text) || !expected.versions.includes(baseline))
        fail('DEMO_BUSINESS_SCOPE','材料不在直接人类批准的精确字面薄包中。');
    }
    ledger.tasks.push({id:run.id,label,createdAt:new Date().toISOString(),businessFingerprint:digest(views.map(v=>({
      memberId:v.member.id,documentId:v.document.id,versionId:v.version.id,blocks:v.version.blocks}))),
      sourceBaselineVersionId:run.manifest.source.baseline.id,executionIdentity:run.executionIdentity});
    this.save(ledger);this.taskId=run.id;
  }
  async complete(messages:ModelMessage[],tools:unknown[],signal:AbortSignal){
    if(!this.taskId || this.active)fail('DEMO_BUDGET_TASK','模型请求没有唯一的已登记任务。');
    const ledger=this.read();
    const totals=ledger.requests.reduce((s:any,r:any)=>({input:s.input+(r.usage?.input??r.reservedInput),
      output:s.output+(r.usage?.output??(r.status==='dispatched'?r.reservedOutput:0))}),{input:0,output:0});
    const reservedInput=Buffer.byteLength(JSON.stringify({messages,tools}),'utf8')+4096;
    const reservedOutput=this.configuration?.maxTokens||4096;
    if(ledger.requests.length>=ledger.limits.requests || totals.input+reservedInput>ledger.limits.inputTokens ||
      totals.output+reservedOutput>ledger.limits.outputTokens)
      fail('DEMO_SHARED_BUDGET','三个任务的共用请求或token预算已达上限，停止外发。');
    const request={sequence:ledger.requests.length+1,taskId:this.taskId,status:'dispatched',
      startedAt:new Date().toISOString(),inputHash:digest({messages,tools}),reservedInput,reservedOutput} as any;
    ledger.requests.push(request);this.save(ledger);this.active=true;
    const started=Date.now();
    try{
      const response=await this.inner.complete(messages,tools,signal);
      request.status='completed';request.usage=response.usage;request.model=response.model;
      return response;
    }catch(error:any){
      request.status='failed';request.errorCode=error.code||error.name;request.errorMessage=error.message;
      request.usage=error.usage||{input:reservedInput,output:0,estimated:true};throw error;
    }finally{
      request.finishedAt=new Date().toISOString();request.elapsedMs=Date.now()-started;
      const latest=this.read();latest.requests[request.sequence-1]=request;this.save(latest);this.active=false;
    }
  }
}
