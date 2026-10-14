import { AppError, hash } from '../domain/rules.ts';
import { AgentTools } from './tools.ts';
import { modelToolSchemas, readyJudgmentRecovery, readySourceRecovery, readyDocumentReviewRecovery, independentAnchorPhase, constraintReviewPhase } from './model-tools.ts';
import { investigationProgress } from './progress.ts';
import { retryableModelError } from './model-retry.ts';
import { setTimeout as pause } from 'node:timers/promises';
import type { AgentService } from './service.ts';
import type { ModelClient, Run } from './types.ts';
import { ModelResponseError } from './model-errors.ts';
import { rememberRecovery } from './recovery.ts';
import { auditMessages, openRound, refreshRound, effectSnapshot, changedEffects } from './rounds.ts';
import { coverage, candidateRefs, propagationChanges } from './investigation.ts';
import { documentReviewCoverage } from './draft-projection.ts';
import { documentReviewMessages } from './document-review-context.ts';

export class AgentRuntime {
  private service: AgentService;
  private model: ModelClient;
  private tools: AgentTools;
  private auditInputs: boolean;
  private requestTimeoutMs: number;
  private active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  constructor(service: AgentService, model: ModelClient, options: { auditInputs?: boolean; requestTimeoutMs?: number } = {}) {
    this.service = service;
    this.model = model;
    this.tools = new AgentTools(service.store, service.workspaceStore);
    this.auditInputs = options.auditInputs || false;
    this.requestTimeoutMs = options.requestTimeoutMs ?? (model.configuration?.thinking ? 90000 : 45000);
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0 || this.requestTimeoutMs > 180000)
      throw new Error('Invalid model request timeout');
    if (this.auditInputs && !service.store.saveRoundInput)
      throw new Error('Request audit storage unavailable');
  }
  get configuration() {
    return this.model.configuration ? { ...this.model.configuration, requestTimeoutMs: this.requestTimeoutMs, transientRetryLimit: 1 } : null;
  }
  recover() {
    this.service.store.transaction(() => {
      for (const run of this.service.store.runs())
        if (['queued', 'running'].includes(run.status)) {
          run.status = 'interrupted';
          run.stopReason = '服务重启，保存的轨迹可查看；请基于当前版本重新运行。';
          run.updatedAt = new Date().toISOString();
          this.service.store.saveRun(run);
          this.service.store.event(run.id, 'interrupted', run.stopReason);
        }
    });
  }
  start(id: string) {
    if (this.active.has(id) || this.service.store.run(id).status !== 'queued') return;
    const controller = new AbortController();
    const promise = this.loop(id, controller).finally(() => this.active.delete(id));
    this.active.set(id, { controller, promise });
  }
  async wait(id: string) {
    await this.active.get(id)?.promise;
    return this.service.report(id);
  }
  cancel(id: string, origin: 'user' | 'shutdown' = 'user') {
    const run = this.service.store.run(id);
    if (['queued', 'running'].includes(run.status)) {
      run.status = origin === 'shutdown' ? 'interrupted' : 'cancelled';
      run.stopReason = origin === 'shutdown' ? '服务停止，本轮检查已中断；已有记录保留。' : '收到停止检查指令，本次检查已取消。';
      this.save(run, run.status, run.stopReason, { origin });
      this.active.get(id)?.controller.abort();
    }
    return this.service.report(id);
  }
  async shutdown() {
    const jobs = [...this.active.values()].map((v) => v.promise);
    for (const [id] of this.active) this.cancel(id, 'shutdown');
    await Promise.allSettled(jobs);
  }
  private save(run: Run, kind?: string, summary?: string, payload?: unknown) {
    refreshRound(run, this.service.store);
    run.updatedAt = new Date().toISOString();
    this.service.store.transaction(() => {
      this.service.store.saveRun(run);
      if (kind) this.service.store.event(run.id, kind, summary || kind, payload);
    });
  }
  private syncReviewReceipts(run: Run) {
    // Model requests yield to human review. Preserve receipts written while
    // awaiting the response before checking freshness or saving this local run.
    run.approvedHeads = this.service.store.run(run.id).approvedHeads;
  }
  private closeRound(run: Run, status: 'completed' | 'rejected' | 'stopped') {
    const round = run.rounds?.at(-1);
    if (!round || round.finishedAt) return;
    refreshRound(run, this.service.store);
    round.status = status;
    round.finishedAt = new Date().toISOString();
    this.save(run, 'round_finished', `第 ${round.round} 轮：${status}。`, round);
  }
  private progress(run: Run) {
    return investigationProgress(run, this.service.store.proposals(run.id));
  }
  private exceeded(run: Run, checkRequests = true) {
    return (
      (checkRequests && run.stats.modelCalls >= run.budget.modelCalls) ||
      run.stats.toolCalls >= run.budget.toolCalls ||
      run.stats.inputTokens >= run.budget.inputTokens ||
      run.stats.outputTokens >= run.budget.outputTokens ||
      (run.stats.startedAt !== null && Date.now() - run.stats.startedAt >= run.budget.timeMs)
    );
  }
  private stopBudget(run: Run) {
    run.status = 'budget_exhausted';
    run.stopReason = '达到请求、工具、时间或 token 预算，未检查项仍保留。';
    this.save(run, 'budget_exhausted', run.stopReason);
  }
  private async loop(id: string, controller: AbortController) {
    let run = this.service.store.run(id);
    run.status = 'running';
    run.stats.startedAt = Date.now();
    this.save(run, 'running', '开始真实模型工具循环。');
    let previous = '',
      repeats = 0,
      protocolMisses = 0;
    let repeatedReads = 0;
    let truncatedResponses = 0;
    let pendingInputEstimate = 0;
    let transientFailures = 0;
    let idleRounds = 0;
    const seenProgress = new Set([this.progress(run)]);
    try {
      if (run.strategyVersion && run.strategyVersion !== this.service.strategy.version)
        throw new AppError('STRATEGY_CHANGED', '运行绑定的 Agent 策略已变化，请创建新任务。', 409);
      if (run.executionIdentity && hash(run.executionIdentity) !== hash(this.service.executionIdentity))
        throw new AppError('STRATEGY_CHANGED', '运行绑定的策略资产或执行协议已变化，请创建新任务。', 409);
      while (run.status === 'running') {
        this.syncReviewReceipts(run);
        this.closeRound(run, 'completed');
        const live = this.service.store.run(id);
        if (live.status !== 'running') return;
        this.syncReviewReceipts(run);
        this.service.assertFresh(run);
        if (run.reviewProtocol === 'documents-v1' && run.changes.length &&
          !(run.documentCoverageProtocol === 'scoped-v1' && run.findings.some(f => f.status === 'uncertain')) &&
          coverage(run, this.service.store).complete &&
          documentReviewCoverage(run, this.service.store.proposals(run.id)).complete) {
          const state = coverage(run, this.service.store);
          const unresolved = (run.documentReviews?.flatMap((d) => d.checks.filter((c) => c.outcome === 'unresolved')
            .flatMap((c) => c.targetRefIds.map((refId) => ({ changeId: c.changeId, refId, reason: c.reason })))) || [])
            .filter((u) => run.findings.some((f) => f.changeId === u.changeId && f.refId === u.refId &&
              ['conflict', 'uncertain'].includes(f.status)) || state.outstanding.some((f) => f.changeId === u.changeId && f.refId === u.refId));
          const checkpoint = this.tools.execute(run, 'finish_task', {
            summary: '已完成来源覆盖、目标关联核对及文档复核；可审阅建议与未解决事项见实际条目。', unresolved,
          }) as { accepted: boolean };
          if (checkpoint.accepted) {
            this.save(run, 'completion_checkpoint', '执行器核对完成条件成立，直接结束；未额外请求模型生成结束报告。', { actor: 'executor', checkpoint });
            return;
          }
        }
        if (this.exceeded(run)) {
          this.stopBudget(run);
          return;
        }
        if (run.documentCoverageProtocol === 'scoped-v1') {
          const changeFingerprint = hash(run.changes.map(c => ({ id: c.id, fingerprint: c.fingerprint, kind: c.kind })));
          if (run.constraintReview?.changeFingerprint !== changeFingerprint) run.constraintReview = undefined;
          if (!run.constraintReview && propagationChanges(run).length) {
            const pending = candidateRefs(run).filter(r => r.role === 'anchor').flatMap(r =>
              propagationChanges(run).map(c => `${c.id}:${r.id}`));
            run.constraintReview = { changeFingerprint, stage: 'initial', pending };
          }
          if (run.constraintReview?.stage === 'initial' && !independentAnchorPhase(run) &&
            run.constraintReview.pending.every(key => run.findings.some(f => `${f.changeId}:${f.refId}` === key))) {
            run.constraintReview.stage = 'reason_review';
          }
        }
        let messages = this.service.strategy.buildMessages(structuredClone(run), {
          proposals: structuredClone(this.service.store.proposals(run.id)),
        });
        const judgmentRecovery = idleRounds >= 2 && !constraintReviewPhase(run) ? readyJudgmentRecovery(run).slice(0, 6) : [];
        const sourceRecovery = idleRounds >= 2 ? readySourceRecovery(run) : [];
        const documentRecovery = !judgmentRecovery.length && !sourceRecovery.length
          ? readyDocumentReviewRecovery(run, this.service.store.proposals(run.id)) : undefined;
        if (documentRecovery) messages = documentReviewMessages(run, this.service.store.proposals(run.id), documentRecovery);
        if (sourceRecovery.length) messages.push({ role: 'user', content: JSON.stringify({
          kind: 'source_change_recovery',
          instruction: '本次改前改后已真实读取，尚未登记变化。先用describe_change比较这些实际原文，模型自行判断实际业务变化或editorial，给精确真实引用；同一事实的多处修改可合并deltaIds。不要继续重复列目录。登记后恢复正常读取/判断工具；程序不代填变化类型或传播结论。',
          items: sourceRecovery,
        }) });
        if (judgmentRecovery.length) messages.push({ role: 'user', content: JSON.stringify({
          kind: 'judgment_recovery',
          instruction: '这些原文和必要邻近上下文已实际读取，仍无判断。请用record_finding对真实证据作出明确判断；缺少业务定义可uncertain，违反底本可conflict，不造能力或按钮。可以先describe_change修正实际变化分类。不要再次列目录或搜索相同内容。后续正常工具在产生实际判断后恢复。',
          items: judgmentRecovery,
        }) });
        const toolSchemas = modelToolSchemas(run, { recoverJudgments: judgmentRecovery.length > 0, recoverSource: sourceRecovery.length > 0,
          recoverDocumentMemberId: documentRecovery?.memberId,
          documentReviewsComplete: documentReviewCoverage(run, this.service.store.proposals(run.id)).complete });
        const projected = Math.ceil(JSON.stringify({ messages, tools: toolSchemas }).length / 2);
        if (run.stats.inputTokens + projected > run.budget.inputTokens) {
          this.stopBudget(run);
          return;
        }
        run.stats.modelCalls++;
        openRound(run, messages, toolSchemas, this.model.configuration || null);
        if (this.auditInputs)
          this.service.store.saveRoundInput!(run.id, run.stats.modelCalls, {
            messages: auditMessages(messages),
            tools: toolSchemas,
            configuration: this.model.configuration || null,
            executionIdentity: run.executionIdentity,
            privateReasoningOmitted: true,
          });
        pendingInputEstimate = projected;
        this.save(run, 'model_request', `请求模型决定下一步（${run.stats.modelCalls}）。`, {
          configuration: this.model.configuration || null,
        });
        const timeout = Math.max(1, Math.min(this.requestTimeoutMs, run.budget.timeMs - (Date.now() - run.stats.startedAt!)));
        let response;
        try {
          response = await this.model.complete(
            messages,
            toolSchemas,
            AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]),
          );
        } catch (error) {
          this.syncReviewReceipts(run);
          if (!(error instanceof ModelResponseError) && retryableModelError(error) && transientFailures < 1 &&
            this.service.store.run(id).status === 'running' && !this.exceeded(run)) {
            this.service.assertFresh(run);
            transientFailures++;
            // A failed request has executed no model actions. Charge conservative
            // input usage and keep the original audit, then retry from this ledger.
            run.stats.inputTokens += pendingInputEstimate;
            run.stats.estimatedUsage = true;
            run.rounds!.at(-1)!.usage = { input: pendingInputEstimate, output: 0, estimated: true };
            pendingInputEstimate = 0;
            this.save(run, 'model_retry', '模型请求暂时超时或断连，将基于已有调查结果自动重试一次；此前动作不会重复提交。',
              { attempt: transientFailures, requestTimeoutMs: timeout, usageEstimated: true });
            this.closeRound(run, 'stopped');
            await pause(600, undefined, { signal: controller.signal });
            continue;
          }
          if (!(error instanceof ModelResponseError)) throw error;
          run.stats.inputTokens += error.usage.input;
          run.stats.outputTokens += error.usage.output;
          run.stats.estimatedUsage ||= error.usage.estimated;
          run.rounds!.at(-1)!.usage = error.usage;
          pendingInputEstimate = 0;
          const current = this.service.store.run(id);
          if (current.status !== 'running') {
            current.stats = run.stats;
            if (current.rounds?.at(-1)) current.rounds.at(-1)!.usage = error.usage;
            this.save(current, 'late_response', '停止后仅记录用量，未执行任何动作。');
            return;
          }
          this.service.assertFresh(run);
          if (error.code !== 'MODEL_OUTPUT_TRUNCATED' || ++truncatedResponses > 2) throw error;
          run.messages.push({
            role: 'user',
            content:
              '执行器反馈：上一轮响应被截断，其中任何动作均未执行。已有调查状态仍保留。请减少并行工具数，record_finding 每批最多 12 条，理由简短；拆批继续。',
          });
          this.save(run, 'model_output_rejected', error.message, { usage: error.usage });
          this.closeRound(run, 'rejected');
          continue;
        }
        // Costs are recorded even when a response arrives after cancellation; no late action is committed.
        transientFailures = 0;
        this.syncReviewReceipts(run);
        run.stats.inputTokens += response.usage.input;
        run.stats.outputTokens += response.usage.output;
        run.stats.estimatedUsage ||= response.usage.estimated;
        pendingInputEstimate = 0;
        run.rounds!.at(-1)!.usage = response.usage;
        run.rounds!.at(-1)!.status = 'executing';
        const status = this.service.store.run(id).status;
        if (status !== 'running') {
          const stopped = this.service.store.run(id);
          stopped.stats = run.stats;
          if (stopped.rounds?.at(-1)) stopped.rounds.at(-1)!.usage = response.usage;
          this.save(stopped, 'late_response', '已记录迟到响应的用量，未执行任何工具。');
          return;
        }
        this.service.assertFresh(run);
        run.messages.push(response.message);
        run.rounds!.at(-1)!.requestedActions = (response.message.tool_calls || []).map((c) => {
          let args: unknown;
          try {
            args = JSON.parse(c.function.arguments);
          } catch {
            args = { invalidJson: true, excerpt: c.function.arguments.slice(0, 2000) };
          }
          return { callId: c.id, tool: c.function.name, arguments: args };
        });
        this.save(run, 'model_response', '收到模型动作。', {
          model: response.model,
          toolNames: response.message.tool_calls?.map((c) => c.function.name) || [],
          usage: response.usage,
        });
        if (this.exceeded(run, false)) {
          this.stopBudget(run);
          return;
        }
        const calls = response.message.tool_calls;
        if (!Array.isArray(calls) || !calls.length) {
          protocolMisses++;
          if (protocolMisses >= 3)
            throw new AppError('MODEL_PROTOCOL', '模型连续未调用合法工具或 finish_task。');
          run.messages.push({
            role: 'user',
            content: '请继续选择工具。自然语言总结不代表结束，只有 finish_task 通过程序校验才结束。',
          });
          this.save(run);
          this.closeRound(run, 'rejected');
          continue;
        }
        protocolMisses = 0;
        const batchFeedback: string[] = [];
        for (const call of calls) {
          if (run.status !== 'running' || this.service.store.run(id).status !== 'running') break;
          this.service.assertFresh(run);
          if (this.exceeded(run, false)) {
            this.stopBudget(run);
            return;
          }
          if (!call.id || call.type !== 'function' || !call.function?.name)
            throw new AppError('MODEL_PROTOCOL', '无效原生工具调用。');
          const beforeProgress = this.progress(run);
          const beforeEffects = effectSnapshot(run, this.service.store);
          const beforeReadCount = run.readRefIds.length;
          let args: unknown, result: unknown, argumentError: string | undefined;
          try {
            args = JSON.parse(call.function.arguments);
          } catch (error) {
            args = null;
            argumentError = error instanceof Error ? error.message : 'Invalid JSON';
          }
          const prior = this.service.store.invocation(id, call.id);
          if (prior) {
            if (prior.name !== call.function.name || hash(prior.args) !== hash(args))
              throw new AppError('TOOL_CALL_REUSED', '同一工具调用 ID 不允许改用途。');
            result = prior.result;
            if (prior.status !== 'committed')
              throw new AppError('TOOL_INTERRUPTED', '存在未提交工具调用，请重新运行。');
          } else {
            run.stats.toolCalls++;
            this.service.store.transaction(() => {
              this.service.store.startInvocation(id, call, args);
              this.service.store.saveRun(run);
              this.service.store.event(id, 'tool_started', `执行 ${call.function.name}。`, {
                callId: call.id,
                name: call.function.name,
                args,
              });
            });
            const candidate = structuredClone(run);
            try {
              this.service.store.transaction(() => {
                if (argumentError)
                  throw new AppError('TOOL_ARGUMENTS_INVALID_JSON', '工具参数JSON未通过解析，未执行动作；请按具体语法位置修正原请求。', 400, {
                    tool: call.function.name, parserMessage: argumentError,
                    argumentCharacters: call.function.arguments.length, committed: false,
                  });
                result = this.tools.execute(candidate, call.function.name, args);
                this.service.assertFresh(candidate);
                candidate.updatedAt = new Date().toISOString();
                this.service.store.saveRun(candidate);
                this.service.store.commitInvocation(id, call.id, result);
                this.service.store.event(id, 'tool_result', `${call.function.name} 已返回真实执行结果。`, {
                  callId: call.id,
                  name: call.function.name,
                  result,
                });
              });
              run = candidate;
            } catch (e) {
              if (!(e instanceof AppError)) throw e;
              if (e.code === 'INPUT_STALE') throw e;
              result = {
                ok: false,
                error: {
                  code: e.code,
                  message: e.message,
                  ...(e.details ? { details: e.details } : {}),
                  retryable: ![
                    'DOCUMENT_LOCKED',
                    'OUT_OF_SCOPE',
                    'ROLE_FORBIDDEN',
                    'KNOWN_DIFFERENCE',
                    'ANCHOR_CONFLICT',
                  ].includes(e.code),
                },
              };
              this.service.store.transaction(() => {
                this.service.store.commitInvocation(id, call.id, result);
                this.service.store.event(id, 'tool_error', `${call.function.name}：${e.message}`, {
                  callId: call.id,
                  name: call.function.name,
                  result,
                });
              });
            }
          }
          rememberRecovery(run, call.function.name, args, result);
          const error = result as { ok?: boolean; error?: { code?: string } };
          run.rounds!.at(-1)!.actions.push({
            callId: call.id,
            tool: call.function.name,
            status: error?.ok === false ? 'rejected' : prior ? 'reused' : 'committed',
            errorCode: error?.error?.code,
            effects: changedEffects(beforeEffects, effectSnapshot(run, this.service.store)),
          });
          run.messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(
              this.service.strategy.formatObservation(call.function.name, structuredClone(result)),
            ),
          });
          this.save(run);
          const changed = beforeProgress !== this.progress(run);
          if (call.function.name === 'read_context')
            repeatedReads = run.readRefIds.length === beforeReadCount ? repeatedReads + 1 : 0;
          else if (changed) repeatedReads = 0;
          if (repeatedReads === 3 && run.status === 'running') {
            batchFeedback.push(
              '最近三次读取没有获得新原文。已有 evidenceId 可以复用；请描述尚未解释的 delta、登记有依据的判断，或将真实缺证项交代清楚。若必须再读，请说明你仍缺哪项上下文。',
            );
            this.save(run, 'investigation_stalled', '已发现重复读取；本轮工具结果齐备后反馈。');
          }
          if (repeatedReads >= 6 && run.status === 'running') {
            run.status = 'failed';
            run.stopCode = 'NO_PROGRESS';
            run.stopReason = '连续六次重复读取没有新原文或调查进展，保留未检查项。';
            this.save(run, 'repetition_limit', run.stopReason);
            return;
          }
          const action = hash({ name: call.function.name, args });
          const progress = this.progress(run);
          const signature = action + ':' + progress;
          if (signature === previous) repeats++;
          else repeats = 1;
          previous = signature;
          if (repeats >= 3 && run.status === 'running') {
            run.status = 'failed';
            run.stopCode = 'NO_PROGRESS';
            run.stopReason = '连续三次重复动作且没有新增信息。';
            this.save(run, 'repetition_limit', run.stopReason);
            return;
          }
        }
        if (batchFeedback.length && run.status === 'running') {
          run.messages.push({ role: 'user', content: batchFeedback.join('\n') });
          this.save(run);
        }
        if (run.status === 'running') {
          const progress = this.progress(run);
          idleRounds = seenProgress.has(progress) ? idleRounds + 1 : 0;
          seenProgress.add(progress);
          if (idleRounds === 2) {
            run.messages.push({ role: 'user', content:
              '执行器反馈：连续两轮没有新增原文、判断、补丁或文档复核结果。改写理由、重列目录不算新进展。复用已登记证据和真实草案，直接处理当前focus的未判项/复核缺口；不要重复调查完成项。确实无法推进则交代具体缺证或定位问题。' });
            this.save(run, 'no_progress_warning', '两轮未产生新调查状态，反馈当前缺口。');
          }
          if (idleRounds >= 4) {
            run.status = 'failed';
            run.stopCode = 'NO_PROGRESS';
            run.stopReason = '连续四轮没有新增调查状态，检查未完成。已有已复核建议保留；本次因无进展停止，不是资源预算用完。';
            this.save(run, 'no_progress_limit', run.stopReason);
            return;
          }
        }
      }
    } catch (e) {
      const current = this.service.store.run(id);
      this.syncReviewReceipts(run);
      if (['cancelled', 'interrupted'].includes(current.status)) {
        if (pendingInputEstimate) {
          current.stats.inputTokens += pendingInputEstimate;
          current.stats.estimatedUsage = true;
          this.save(current, 'usage_estimated', '取消的请求未提供 usage，输入用量以估计值记录。');
        }
        return;
      }
      if (current.status !== 'running') return;
      run.status =
        e instanceof AppError && e.code === 'INPUT_STALE'
          ? 'stale'
          : this.exceeded(run)
            ? 'budget_exhausted'
            : 'failed';
      run.stopReason =
        e instanceof AppError
          ? `${e.code}: ${e.message}`
          : e instanceof Error && e.name === 'TimeoutError'
            ? 'MODEL_TIMEOUT: 模型请求超时。'
            : 'MODEL_NETWORK_OR_STORAGE: 请求或存储失败，未执行离线判断。';
      // Failed model requests without usage are conservatively estimated and explicitly labeled.
      if (pendingInputEstimate) {
        run.stats.inputTokens += pendingInputEstimate;
        run.stats.estimatedUsage = true;
      }
      this.save(run, 'stopped', run.stopReason);
    } finally {
      const current = this.service.store.run(id);
      this.closeRound(
        current,
        ['awaiting_review', 'needs_input', 'no_changes'].includes(current.status) ? 'completed' : 'stopped',
      );
    }
  }
}
