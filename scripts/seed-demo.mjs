import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SQLiteStore} from '../server/infrastructure/sqlite-store.ts';
import {uid} from '../server/domain/rules.ts';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const state=process.env.WORKSPACE_STATE_DIR||path.join(root,'runtime'),db=path.join(state,'workspace-v2.sqlite');
try{await fs.access(db);console.log('已有演示资料库，保留编辑和记录。');}catch(e){
 if(e.code!=='ENOENT')throw e;
 const seed=JSON.parse(await fs.readFile(path.join(root,'examples/seed-materials.json'),'utf8'));
 const store=new SQLiteStore(db);
 try{store.transaction(()=>{for(const group of seed.groups){const scope=store.ensureScope(group.scopeName),folder={id:uid(),name:group.name,parentId:null};store.saveFolder(folder);for(const d of group.documents){const blocks=d.blocks.map(b=>({...b,id:uid()})),id=store.insertDocument(d.title,'md'),v=store.insertVersion(id,blocks,'首次初始化纯合成演示资料');store.setHead(id,v.id);store.insertMember({scopeId:scope.id,documentId:id,role:d.role,baselineVersionId:v.id,pinVersionId:d.role==='anchor'?v.id:null,compareDocumentId:null});store.savePresentation({documentId:id,displayName:d.title,fileName:d.title+'.md',folderId:folder.id});}}});console.log('已创建'+seed.groups.length+'组纯合成演示资料，无历史模型记录。');}finally{store.close();}
}
