import type { RunStatus, Ref, Evidence, SourceQuote, Change, Relation, FindingStatus, Finding, Difference, Budget, Stats, ReviewBatch, RunEvent } from '../../shared/contracts/agent.ts';
export type { RunStatus, Ref, Evidence, SourceQuote, Change, Relation, FindingStatus, Finding, Difference, Budget, Stats, ReviewBatch, RunEvent } from '../../shared/contracts/agent.ts';
import type { Block, Delta, Patch, View } from '../domain/types.ts';
import type { AgentRound, ExecutionIdentity } from '../../shared/contracts/agent.ts';

export type Proposal = {
  id: string;
  differenceId: string;
  createdRunId: string;
  latestRunId: string;
  changeId: string;
  targetMemberId: string;
  targetVersionId: string;
  targetRefIds: string[];
  patches: Patch[];
  after: Block[];
  evidenceIds: string[];
  state: 'pending' | 'retained' | 'deferred' | 'needs_revalidation' | 'applied' | 'withdrawn';
  reason: string;
  createdAt: string;
};
export type ModelMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string | null;
};
export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type Usage = { input: number; output: number; estimated: boolean };
export const defaultBudget: Budget = {
  modelCalls: 40,
  toolCalls: 120,
  timeMs: 480000,
  inputTokens: 500000,
  outputTokens: 48000,
};
export type SourceDelta = Delta & { id: string; beforeRefId: string | null; afterRefId: string | null };
export type DocumentReview = {
  memberId: string;
  fingerprint: string;
  purpose?: { kind: 'acceptance' | 'procedure' | 'overview' | 'selected' | 'other'; refId: string; quote: string };
  scopeExclusion?: { changeIds: string[]; reason: string };
  checks: { changeId: string; source: SourceQuote; obligationId?: string;
    targetWitness?: { mode: 'present' | 'absent'; quote: string };
    scope?: 'fragment' | 'document';
    targetRefIds: string[]; proposalIds: string[]; outcome: 'patched' | 'current' | 'not_applicable' | 'unresolved'; reason: string }[];
  createdAt: string;
};
export type Run = {
  sourceBlockIds?: string[];
  id: string;
  strategyVersion?: string;
  executionIdentity?: ExecutionIdentity;
  rounds?: AgentRound[];
  reviewProtocol?: 'fragments-v1' | 'documents-v1';
  sourceObligationProtocol?: 'clauses-v1';
  documentCoverageProtocol?: 'scoped-v1';
  documentReviews?: DocumentReview[];
  documentReviewDrafts?: DocumentReview[];
  recoveryHints?: { tool: string; code: string; message: string; details?: unknown; changeId?: string; refId?: string }[];
  requestId: string;
  inputHash: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  manifest: {
    sourceMemberId: string;
    source: View;
    views: View[];
    policyRevision: number;
    policyHash: string;
    refs: Ref[];
    history: { memberId: string; beforeVersionId: string; afterVersionId: string; deltas: Delta[] }[];
  };
  deltas: SourceDelta[];
  changes: Change[];
  evidence: Evidence[];
  relations: Relation[];
  findings: Finding[];
  proposalIds: string[];
  readRefIds: string[];
  entitySequence?: Record<string, number>;
  unresolved: { changeId: string; refId: string; reason: string; questions?: string[]; relatedRefIds?: string[] }[];
  messages: ModelMessage[];
  budget: Budget;
  stats: Stats;
  summary: string;
  stopReason: string;
  stopCode?: 'NO_PROGRESS';
  approvedHeads?: Record<string, { versionId: string; revision: number }>;
};
export interface AgentStore {
  saveRoundInput?(runId: string, round: number, input: unknown): void;
  roundInputs?(runId: string): { round: number; input: unknown }[];
  transaction<T>(fn: () => T): T;
  createRun(run: Run): void;
  saveRun(run: Run): void;
  run(id: string): Run;
  runs(): Run[];
  request(id: string): Run | null;
  event(runId: string, kind: string, summary: string, payload?: unknown): void;
  events(runId: string, cursor?: number): RunEvent[];
  invocation(
    runId: string,
    callId: string,
  ): { name: string; args: unknown; status: string; result: unknown } | null;
  startInvocation(runId: string, call: ToolCall, args: unknown): void;
  commitInvocation(runId: string, callId: string, result: unknown): void;
  difference(value: Omit<Difference, 'id' | 'createdAt' | 'status'>): Difference;
  differences(): Difference[];
  saveDifference(value: Difference): void;
  proposals(runId?: string): Proposal[];
  proposal(id: string): Proposal;
  saveProposal(value: Proposal): void;
  linkProposal(runId: string, id: string): void;
  reviewBatches(runId?: string): ReviewBatch[];
  saveReviewBatch(batch: ReviewBatch): void;
}
export interface ModelClient {
  readonly configuration?: { model: string; thinking: boolean; effort: string | null; maxTokens: number };
  complete(
    messages: ModelMessage[],
    tools: unknown[],
    signal: AbortSignal,
  ): Promise<{ message: ModelMessage; usage: Usage; model: string }>;
}
