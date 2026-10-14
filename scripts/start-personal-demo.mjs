import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SQLiteStore} from '../server/infrastructure/sqlite-store.ts';
import {Workspace} from '../server/application/workspace.ts';
import {uid} from '../server/domain/rules.ts';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(Number(process.versions.node.split('.')[0])!==24)throw Error('请使用Node.js 24。');
try{process.loadEnvFile(path.join(root,'.env'));}catch(e){if(e.code!=='ENOENT')throw e;}
process.env.PORT=process.env.PORT||'3084';
process.env.WORKSPACE_STATE_DIR=process.env.WORKSPACE_STATE_DIR||path.join(root,'runtime');
process.env.AGENT_STRATEGY_DIR=path.join(root,'server/agent/tuning/packs/scoped-clauses');
process.env.DEEPSEEK_MODEL='deepseek-v4-pro';
process.env.DEEPSEEK_THINKING='disabled';
delete process.env.DEEPSEEK_REASONING_EFFORT;
const db=path.join(process.env.WORKSPACE_STATE_DIR,'workspace-v2.sqlite');
try{await fs.access(db);}catch(e){
  if(e.code!=='ENOENT')throw e;
  const seed=JSON.parse(await fs.readFile(path.join(root,'examples/confirmed-relation-documents.json'),'utf8'));
  const store=new SQLiteStore(db);
  try{new Workspace(store).importDocuments({scopeName:'关系复用·个人原型两段演示',requestId:uid(),files:seed.files});}
  finally{store.close();}
}
console.log('个人原型：两份单段合成资料，首次AI发现关系，确认后后台复用。');
console.log(process.env.DEEPSEEK_API_KEY?'模型key仅从本机配置读取；检查由本人主动发起。':'未配置key：可以编辑和浏览；不会外发模型请求。');
await import('../server/bootstrap.ts');
