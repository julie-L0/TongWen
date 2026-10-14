export function seed(epoch=1) {
  const documents=[
    {id:'prd',title:'高级会员功能需求',type:'md',role:'source',isEffective:true,followSource:false,syncGroupId:'membership-v2',sourceDocumentId:'prd',writeMode:'editable',revision:1,indexed:true,label:'PRD · 当前版本',subtitle:'产品需求 · V2.0'},
    {id:'api',title:'会员权益接口说明',type:'md',role:'reference',isEffective:true,followSource:true,syncGroupId:'membership-v2',sourceDocumentId:'prd',writeMode:'editable',revision:1,indexed:true,label:'接口说明',subtitle:'研发资料 · 可编辑'},
    {id:'manual',title:'高级会员使用指南',type:'pdf',role:'reference',isEffective:true,followSource:true,syncGroupId:'membership-v2',sourceDocumentId:'prd',writeMode:'annotation_only',revision:1,indexed:true,label:'用户指南 · PDF',subtitle:'2 页 · 修订建议'},
    {id:'qa',title:'会员功能测试用例',type:'md',role:'reference',isEffective:true,followSource:true,syncGroupId:'membership-v2',sourceDocumentId:'prd',writeMode:'editable',revision:1,indexed:true,label:'测试用例',subtitle:'测试资料 · 可编辑'},
    {id:'faq',title:'运营常见问题',type:'md',role:'reference',isEffective:true,followSource:true,syncGroupId:'membership-v2',sourceDocumentId:'prd',writeMode:'editable',revision:1,indexed:true,label:'运营说明',subtitle:'包含无关参数及已更新内容'},
    {id:'archive',title:'会员使用指南 V1.0',type:'md',role:'reference',isEffective:false,followSource:false,syncGroupId:'membership-v2',sourceDocumentId:'prd',writeMode:'annotation_only',revision:1,indexed:true,label:'历史归档',subtitle:'保留当时的业务规则'},
    {id:'independent',title:'企业定制会员说明',type:'md',role:'reference',isEffective:true,followSource:false,syncGroupId:'membership-v2',sourceDocumentId:'prd',writeMode:'annotation_only',revision:1,indexed:true,label:'独立规则',subtitle:'生效，但不跟随当前 PRD'},
    {id:'other',title:'普通会员功能说明',type:'md',role:'reference',isEffective:true,followSource:true,syncGroupId:'standard-v1',sourceDocumentId:'standard-prd',writeMode:'annotation_only',revision:1,indexed:true,label:'其他同步组',subtitle:'跟随普通会员规则'},
    {id:'unindexed',title:'待整理的交付资料',type:'md',role:'reference',isEffective:null,followSource:false,syncGroupId:'membership-v2',sourceDocumentId:'prd',writeMode:'annotation_only',revision:1,indexed:false,label:'未检查',subtitle:'生效状态与索引尚未确认'},
  ];
  const records=[
    ['p-intro','prd','项目目标','为高级会员提供稳定、可追溯的智能识别服务，统一会员权益说明。','背景'],
    ['p-valid','prd','功能有效期','高级会员开通后，智能识别功能可在 30 天内使用。','高级会员智能识别权益的使用有效期。'],
    ['p-limit','prd','使用限制','每位高级会员每天最多发起 100 次识别任务。','每日次数上限，和权益有效期是不同参数。'],
    ['p-trial','prd','免费试用','免费用户可体验 7 天基础识别功能。','免费用户试用期，不属于高级会员有效期。'],
    ['api-valid','api','有效期字段','valid_days: 30','GET /membership/recognition/benefit 返回高级会员智能识别功能的有效期，单位为天。'],
    ['api-quota','api','每日调用上限','daily_limit: 100','高级会员每日识别调用次数上限。'],
    ['manual-valid','manual','权益有效期','高级会员开通后，智能识别权益的有效期为 30 天。','使用指南第二页：高级会员智能识别功能的有效期。'],
    ['manual-log','manual','记录保留','识别任务日志保留 30 天，可在任务记录中查询。','日志保留周期，和会员权益有效期无关。'],
    ['qa-valid','qa','边界测试','开通高级会员后的第 30 天，智能识别功能仍可使用；下一天权益失效。','会员智能识别功能有效期的边界测试。'],
    ['qa-unclear','qa','待确认条目','有效期为 30 天。','旧草稿未写明业务对象，需要人工确认。'],
    ['faq-trial','faq','试用说明','免费体验期为 30 天，到期后可选择升级。','免费体验期，与高级会员智能识别权益不同。'],
    ['faq-current','faq','已更新说明','高级会员的智能识别功能有效期已调整为 40 天。','当前高级会员智能识别权益有效期。'],
    ['archive-valid','archive','旧版规则','高级会员智能识别功能可使用 30 天。','历史版本保留当时规则。'],
    ['independent-valid','independent','客户约定','企业定制会员的智能识别权益有效期为 20 天。','客户定制的独立生效规则。'],
    ['other-valid','other','普通会员规则','普通会员的智能识别有效期为 30 天。','另一个产品及同步组。'],
    ['unknown-valid','unindexed','交付摘录','智能识别有效期为 30 天。','未整理，不能保证信息生效。'],
  ];
  const fragments=records.map(([id,documentId,title,text,context])=>({id,documentId,blockId:id,title,text,context,revision:1,excludedFromSync:false,locator:documentId==='manual'?{kind:'pdf',assetId:'membership-guide',page:2,bbox:{x:0.085,y:id==='manual-valid'?0.292:0.52,width:0.83,height:0.057}}:{kind:'text',blockId:id}}));
  const histories=Object.fromEntries(fragments.filter(f=>f.documentId==='prd').map(f=>[f.id,{initialText:f.text,lastCheckedText:null,lastKnownChange:null}]));
  return {schemaVersion:1,epoch,revision:1,documents,fragments,histories,tasks:[],annotations:[],batches:[],requestResults:{}};
}
