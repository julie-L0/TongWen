import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SQLiteStore } from './infrastructure/sqlite-store.ts';
import { preserveLegacy } from './infrastructure/legacy-migration.ts';
import { Workspace } from './application/workspace.ts';
import { createApp } from './http/app.ts';
import { AgentService } from './agent/service.ts';
import { AgentRuntime } from './agent/runtime.ts';
import { DeepSeekClient } from './infrastructure/deepseek-client.ts';
import { createAgentGateway } from './agent/gateway.ts';
import { loadStrategyPack } from './agent/tuning/load.ts';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch (e: any) {
  if (e.code !== 'ENOENT') throw e;
}
const runtime = process.env.WORKSPACE_STATE_DIR || path.join(root, 'runtime');
const store = new SQLiteStore(path.join(runtime, 'workspace-v2.sqlite'));
await preserveLegacy(store, runtime);
const workspace = new Workspace(store);
const service = new AgentService(store.agent, workspace, store, loadStrategyPack(process.env.AGENT_STRATEGY_DIR));
let agent: { service: AgentService; runtime: AgentRuntime } | undefined;
if (process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_MODEL) {
  const runtime = new AgentRuntime(
    service,
    new DeepSeekClient({
      key: process.env.DEEPSEEK_API_KEY,
      model: process.env.DEEPSEEK_MODEL,
      baseUrl: process.env.DEEPSEEK_BASE_URL,
      thinking: process.env.DEEPSEEK_THINKING !== 'disabled',
      effort: process.env.DEEPSEEK_REASONING_EFFORT,
    }),
    { auditInputs: process.env.AGENT_AUDIT_INPUTS === '1' },
  );
  runtime.recover();
  agent = { service, runtime };
}
const app = createApp(workspace, store, root, agent ? createAgentGateway(agent.service, agent.runtime) : undefined);
const server = app.listen(Number(process.env.PORT || 3001), '127.0.0.1', () =>
  console.log(
    `同文工作台 http://127.0.0.1:${process.env.PORT || 3001} · ${agent ? 'Agent 后端已接入' : '模型未配置'}`,
  ),
);
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  server.close(async () => {
    await agent?.runtime.shutdown();
    store.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
