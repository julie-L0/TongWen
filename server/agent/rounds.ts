import { hash } from '../domain/rules.ts';
import { coverage } from './investigation.ts';
import { documentReviewCoverage } from './draft-projection.ts';
import type { AgentStore, ModelMessage, Run } from './types.ts';
import type { AgentRound, RoundEffects } from '../../shared/contracts/agent.ts';

export function auditMessages(messages: ModelMessage[]) {
  // Persist supplied content and native actions; never persist private reasoning in request audits.
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    ...(m.tool_calls ? { tool_calls: structuredClone(m.tool_calls) } : {}),
  }));
}
export function openRound(
  run: Run,
  messages: ModelMessage[],
  tools: unknown[],
  configuration: unknown,
): AgentRound {
  const visible = { messages: auditMessages(messages), tools, configuration };
  let focusMemberId: string | undefined;
  for (const m of messages) {
    if (m.role !== 'user' || !m.content) continue;
    try {
      const p = JSON.parse(m.content);
      if (Array.isArray(p.documents) && typeof p.focus?.memberId === 'string')
        focusMemberId = p.focus.memberId;
    } catch {
      /* A user goal is not necessarily JSON. */
    }
  }
  const round: AgentRound = {
    round: run.stats.modelCalls,
    startedAt: new Date().toISOString(),
    status: 'requested',
    input: {
      hash: hash(visible),
      messageCount: messages.length,
      characters: JSON.stringify(visible).length,
      focusMemberId,
    },
    actions: [],
  };
  (run.rounds ||= []).push(round);
  return round;
}
export function refreshRound(run: Run, store: AgentStore) {
  const round = run.rounds?.at(-1);
  if (!round || round.finishedAt) return;
  const c = coverage(run, store);
  round.outcome = {
    runStatus: run.status,
    missingDeltas: c.missingDeltas.length,
    unjudged: c.gaps.length,
    outstanding: c.outstanding.length,
    unresolved: run.unresolved.length,
    documentReviewGaps: documentReviewCoverage(run, store.proposals(run.id)).gaps.length,
    stopReason: run.stopReason,
  };
  round.remaining = {
    modelCalls: Math.max(0, run.budget.modelCalls - run.stats.modelCalls),
    toolCalls: Math.max(0, run.budget.toolCalls - run.stats.toolCalls),
    inputTokens: Math.max(0, run.budget.inputTokens - run.stats.inputTokens),
    outputTokens: Math.max(0, run.budget.outputTokens - run.stats.outputTokens),
    timeMs: Math.max(0, run.budget.timeMs - (Date.now() - (run.stats.startedAt || Date.now()))),
  };
}
export function effectSnapshot(run: Run, store: AgentStore) {
  const indexed = <T>(values: T[], key: (v: T) => string) => new Map(values.map((v) => [key(v), hash(v)]));
  return {
    evidenceIds: indexed(run.evidence, (v) => v.id),
    changeIds: indexed(run.changes, (v) => v.id),
    relationIds: indexed(run.relations, (v) => v.id),
    findingKeys: indexed(run.findings, (v) => `${v.changeId}/${v.refId}`),
    proposalIds: indexed(store.proposals(run.id), (v) => v.id),
    reviewedMemberIds: indexed(run.documentReviews || [], (v) => v.memberId),
  };
}
export function changedEffects(
  before: ReturnType<typeof effectSnapshot>,
  after: ReturnType<typeof effectSnapshot>,
): RoundEffects {
  const result = {} as RoundEffects;
  for (const key of Object.keys(before) as (keyof RoundEffects)[])
    result[key] = [...new Set([...before[key].keys(), ...after[key].keys()])].filter(
      (id) => before[key].get(id) !== after[key].get(id),
    );
  return result;
}
