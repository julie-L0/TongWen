import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(Number(process.versions.node.split('.')[0])!==24)throw Error('请使用Node.js 24运行本演示。');
try{process.loadEnvFile(path.join(root,'.env'));}catch(e){if(e.code!=='ENOENT')throw e;}
const version=JSON.parse(await fs.readFile(path.join(root,'submission-version.json'),'utf8'));
process.env.WORKSPACE_STATE_DIR=process.env.WORKSPACE_STATE_DIR||path.join(root,'runtime');
process.env.AGENT_STRATEGY_DIR=path.join(root,'server/agent/tuning/packs',version.executionIdentity.packId);
process.env.DEEPSEEK_MODEL=version.model.model;
process.env.DEEPSEEK_THINKING=version.model.thinking?'enabled':'disabled';
if(version.model.effort)process.env.DEEPSEEK_REASONING_EFFORT=version.model.effort;else delete process.env.DEEPSEEK_REASONING_EFFORT;
process.env.PORT=process.env.PORT||'3010';
await import('./seed-demo.mjs');
console.log('待验收试用版：'+version.strategyVersion);
console.log(process.env.DEEPSEEK_API_KEY?'已配置真实模型；确认前请核对修改与依据。':'未配置模型key：可浏览编辑保存，不能进行真实模型检查。');
await import('../server/bootstrap.ts');
if(process.argv.includes('--open'))setTimeout(()=>{const url='http://127.0.0.1:'+process.env.PORT+'/';let child;if(process.platform==='win32')child=spawn('cmd.exe',['/c','start','',url],{windowsHide:true,stdio:'ignore'});else child=spawn(process.platform==='darwin'?'open':'xdg-open',[url],{stdio:'ignore'});child.on('error',()=>console.log('请手动打开 '+url));},800);
