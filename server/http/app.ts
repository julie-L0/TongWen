import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { AppError, fail } from '../domain/rules.ts';
import { serializeMarkdown } from '../domain/markdown.ts';
import type { Workspace } from '../application/workspace.ts';
import type { WorkspaceStore } from '../application/ports.ts';
import type { AgentGateway } from '../application/agent-gateway.ts';
import { Organization } from '../application/organization.ts';
export function createApp(
  workspace: Workspace,
  store: WorkspaceStore,
  root: string,
  agent?: AgentGateway,
) {
  const app = express();
  const organization = new Organization(store);
  app.use(express.json({ limit: '8mb' }));
  app.use((q, _r, next) => {
    if (
      q.path.startsWith('/api/') &&
      ['POST', 'PATCH'].includes(q.method) &&
      q.path !== '/api/runs' &&
      (!q.body || typeof q.body !== 'object' || Array.isArray(q.body))
    )
      fail('INVALID_REQUEST', '请提供 JSON 对象作为请求内容。');
    next();
  });
  app.get('/api/config', (_q, r) =>
    r.json({
      keyConfigured: !!process.env.DEEPSEEK_API_KEY,
      model: agent?.configuration?.model || null,
      thinking: agent?.configuration?.thinking ?? false,
      reasoningEffort: agent?.configuration?.effort || null,
      requestTimeoutMs: agent?.configuration?.requestTimeoutMs ?? null,
      transientRetryLimit: agent?.configuration?.transientRetryLimit ?? null,
      agentReady: !!agent,
      strategyVersion: agent?.strategyVersion || null,
      executionIdentity: agent?.executionIdentity || null,
      reviewProtocol: agent?.reviewProtocol || null,
      stage: agent ? 'agent_backend' : 'foundation',
      formats: ['md'],
    }),
  );
  app.get('/api/workspace', (_q, r) => r.json(workspace.snapshot()));
  app.post('/api/folders', (q, r) => {
    const folder = organization.folder(q.body);
    r.status(201).json({ folder, workspace: workspace.snapshot() });
  });
  app.patch('/api/folders/:id', (q, r) => {
    const folder = organization.folder({ ...q.body, id: String(q.params.id) });
    r.json({ folder, workspace: workspace.snapshot() });
  });
  app.patch('/api/documents/:id/presentation', (q, r) => {
    organization.presentation(String(q.params.id), q.body);
    r.json(workspace.snapshot());
  });
  app.post('/api/selection/properties', (q, r) => r.json(workspace.batchProperties(q.body)));
  app.post('/api/imports', (q, r) => r.status(201).json(workspace.importDocuments(q.body)));
  app.patch('/api/views/:id/content', (q, r) =>
    r.json(workspace.save(String(q.params.id), q.body.expectedRevision, q.body.blocks)),
  );
  app.patch('/api/views/:id/properties', (q, r) =>
    r.json(workspace.updateProperties(String(q.params.id), q.body)),
  );
  app.get('/api/views/:id/versions', (q, r) => r.json(workspace.versions(String(q.params.id))));
  app.post('/api/views/:id/history', (q, r) =>
    r.json(workspace.createHistory(String(q.params.id), q.body.versionId, q.body.expectedPolicyRevision)),
  );
  app.get('/api/views/:id/compare', (q, r) =>
    r.json(
      workspace.compare(
        String(q.params.id),
        typeof q.query.before === 'string' ? q.query.before : undefined,
        typeof q.query.after === 'string' ? q.query.after : undefined,
      ),
    ),
  );
  app.post('/api/views/:id/restore', (q, r) => r.json(workspace.restore(String(q.params.id), q.body)));
  app.post('/api/views/:id/patches', (q, r) => r.json(workspace.patch(String(q.params.id), q.body)));
  app.post('/api/operations/:id/undo', (q, r) => {
    r.json(agent?.undoOperation(String(q.params.id), q.body.requestId) ?? workspace.undo(String(q.params.id), q.body.requestId));
  });
  app.get('/api/views/:id/export', (q, r) => {
    const v = workspace.view(String(q.params.id));
    if (v.document.format !== 'md') fail('FORMAT_UNSUPPORTED', '此接口仅导出 Markdown。');
    r.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    r.send(serializeMarkdown(v.version.blocks));
  });
  app.get('/api/assets/:documentId', (q, r) => {
    const d = store.document(String(q.params.documentId));
    if (d.format !== 'pdf' || !d.assetPath) fail('NOT_FOUND', 'PDF 资产不存在。', 404);
    const base = path.resolve(root, 'public/assets'),
      file = path.resolve(base, d.assetPath!),
      relative = path.relative(base, file);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !existsSync(file))
      fail('NOT_FOUND', 'PDF 资产不可用。', 404);
    r.sendFile(file);
  });
  app.post('/api/runs', (q, r) => {
    if (!agent)
      fail(
        process.env.DEEPSEEK_API_KEY ? 'AGENT_NOT_READY' : 'MODEL_NOT_CONFIGURED',
        process.env.DEEPSEEK_API_KEY
          ? '当前完成版本与导入底座，Agent 内核尚未接入。'
          : '请先在本地 .env 配置 DeepSeek；当前完成导入与版本底座，未运行 AI。',
        503,
      );
    if (!q.body || typeof q.body !== 'object' || Array.isArray(q.body))
      fail('INVALID_REQUEST', '请提供任务目标与来源参数。');
    if (
      !Array.isArray(q.body.memberIds) ||
      !q.body.memberIds.length ||
      typeof q.body.sourceMemberId !== 'string'
    )
      fail('INVALID_SELECTION', '请勾选目标资料；当前正在编辑的文档自动作为来源。');
    r.status(202).json(agent!.create(q.body));
  });
  if (agent) {
    app.get('/api/runs', (q, r) =>
      r.json(
        agent.list(),
      ),
    );
    app.get('/api/runs/:id', (q, r) => r.json(agent.report(String(q.params.id))));
    app.post('/api/runs/:id/apply', (q, r) => r.json(agent.apply(String(q.params.id), q.body)));
    app.post('/api/review-batches/:id/undo', (q, r) =>
      r.json(agent.undoBatch(String(q.params.id), q.body.requestId)),
    );
    app.get('/api/runs/:id/events', (q, r) => {
      const cursor = Number(q.query.cursor || 0);
      if (!Number.isSafeInteger(cursor) || cursor < 0) fail('INVALID_ARGUMENT', '事件游标无效。');
      r.json(agent.events(String(q.params.id), cursor));
    });
    app.post('/api/runs/:id/cancel', (q, r) => r.json(agent.cancel(String(q.params.id))));
    app.post('/api/runs/:id/retry', (q, r) => {
      r.status(202).json(agent.retry(String(q.params.id), q.body.requestId));
    });
    app.get('/api/proposals/:id/evidence', (q, r) =>
      r.json(agent.evidence(String(q.params.id))),
    );
    app.get('/api/differences', (_q, r) => r.json(agent.differences()));
    app.post('/api/differences/:id/decisions', (q, r) =>
      r.json(agent.decision(String(q.params.id), q.body)),
    );
    app.post('/api/decisions/:id/revoke', (q, r) =>
      r.json(agent.revokeDecision(String(q.params.id))),
    );
  }
  app.use('/assets', express.static(path.join(root, 'public/assets')));
  if (existsSync(path.join(root, 'dist-v2'))) {
    app.use(express.static(path.join(root, 'dist-v2')));
    app.get('/', (_q, r) => r.sendFile(path.join(root, 'dist-v2/index.html')));
  }
  app.use((e: any, _q: any, r: any, _next: any) => {
    if (e instanceof AppError) r.status(e.status).json({ error: { code: e.code, message: e.message } });
    else if (e.type === 'entity.parse.failed')
      r.status(400).json({ error: { code: 'INVALID_JSON', message: '请求内容不是有效的 JSON。' } });
    else if (e.type === 'entity.too.large')
      r.status(413).json({ error: { code: 'IMPORT_TOO_LARGE', message: '导入总量超过 8 MB，请分批上传。' } });
    else {
      console.error(e instanceof Error ? e.message : 'Unknown error');
      r.status(500).json({
        error: { code: 'STORAGE_ERROR', message: '数据保存失败，原事务未提交。请重试。' },
      });
    }
  });
  return app;
}
