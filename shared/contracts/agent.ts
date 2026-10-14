import type { Block, Delta, Patch, View, Decision, Snapshot } from './workspace.ts';

export type RunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_review'
  | 'needs_input'
  | 'no_changes'
  | 'budget_exhausted'
  | 'cancelled'
  | 'interrupted'
  | 'stale'
  | 'failed';
export type Ref = {
  id: string;
  memberId: string;
  versionId: string;
  blockId: string;
  title: string;
  section: string;
  role: View['member']['role'];
  kind: Block['kind'];
  text: string;
  order: number;
  baseline: boolean;
};
export type Evidence = { id: string; refId: string; quote: string; hash: string };
export type SourceQuote = { evidenceId: string; quote: string };
export type SourceObligation = { id: string; source: SourceQuote };
export type Change = {
  id: string;
  deltaIds: string[];
  kind: 'add' | 'remove' | 'rule' | 'terminology' | 'editorial' | 'unknown';
  businessObject: string;
  summary: string;
  before: SourceQuote[];
  after: SourceQuote[];
  fingerprint: string;
  obligations?: SourceObligation[];
};
export type Relation = {
  id: string;
  changeIds: string[];
  targetRefIds: string[];
  type: 'equivalent' | 'summary_of' | 'implements' | 'feature_set' | 'ambiguous';
  coverageMode: 'complete' | 'selective' | 'unknown';
  evidenceIds: string[];
  reason: string;
};
export type FindingStatus =
  | 'needs_update'
  | 'already_current'
  | 'compatible'
  | 'unrelated'
  | 'uncertain'
  | 'known_retained'
  | 'not_conflicting'
  | 'conflict';
export type Finding = {
  id: string;
  changeId: string;
  refId: string;
  status: FindingStatus;
  evidenceIds: string[];
  relationIds: string[];
  reason: string;
  differenceId?: string;
};
export type Difference = {
  id: string;
  issueKey: string;
  sourceHash: string;
  targetHash: string;
  policyHash: string;
  targetMemberId: string;
  status: 'pending' | 'retained' | 'deferred' | 'applied';
  reason: string;
  createdAt: string;
};
export type Budget = {
  modelCalls: number;
  toolCalls: number;
  timeMs: number;
  inputTokens: number;
  outputTokens: number;
};
export type Stats = {
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedUsage: boolean;
  startedAt: number | null;
};
export type ReviewBatch = {
  id: string;
  runId: string;
  proposalIds: string[];
  requestId: string;
  createdAt: string;
  undoneAt: string | null;
  operations: { operationId: string; memberId: string; beforeVersionId: string; afterVersionId: string }[];
};
export type RunEvent = {
  id: number;
  runId: string;
  kind: string;
  summary: string;
  payload: unknown;
  createdAt: string;
};

export type ExecutionIdentity = {
  strategyFingerprint: string;
  promptHash: string;
  toolSchemaHash: string;
  codeHash: string;
  packId: string;
  assets: { file: string; hash: string }[];
};
export type RoundEffects = {
  evidenceIds: string[];
  changeIds: string[];
  relationIds: string[];
  findingKeys: string[];
  proposalIds: string[];
  reviewedMemberIds: string[];
};
export type AgentRound = {
  round: number;
  startedAt: string;
  finishedAt?: string;
  status: 'requested' | 'executing' | 'completed' | 'rejected' | 'stopped';
  input: { hash: string; messageCount: number; characters: number; focusMemberId?: string };
  actions: {
    callId: string;
    tool: string;
    status: 'committed' | 'rejected' | 'reused';
    errorCode?: string;
    effects: RoundEffects;
  }[];
  requestedActions?: { callId: string; tool: string; arguments: unknown }[];
  usage?: { input: number; output: number; estimated: boolean };
  outcome?: {
    runStatus: RunStatus;
    missingDeltas: number;
    unjudged: number;
    outstanding: number;
    unresolved: number;
    documentReviewGaps: number;
    stopReason: string;
  };
  remaining?: Budget;
};

export type CreateRunRequest = {
  sourceBlockIds?: string[];
  sourceMemberId: string;
  requestId: string;
  memberIds?: string[];
  baselineVersionId?: string;
  budget?: Partial<Budget>;
};
export type RunSummary = {
  id: string;
  status: RunStatus;
  sourceMemberId: string;
  createdAt: string;
};
export type ProposalState =
  'pending' | 'retained' | 'deferred' | 'needs_revalidation' | 'applied' | 'withdrawn';
export type ProposalSummary = {
  id: string;
  differenceId: string;
  changeId: string;
  targetMemberId: string;
  title?: string;
  state: ProposalState;
  reason: string;
  patches: Patch[];
  targetVersionId: string;
  applicable: boolean;
};
export type AgentReport = {
  conflicts?: { memberId: string; title: string; section: string; original: string; sourceAfter: string; reason: string }[];
  sourceEdits?: { blockId: string; kind: string; before: string; after: string }[];
  sourceBlockIds?: string[];
  id: string;
  status: RunStatus;
  inputValid: boolean;
  strategyVersion?: string;
  executionIdentity?: ExecutionIdentity;
  rounds?: AgentRound[];
  documentReview?: { required: boolean; complete: boolean; gaps: { memberId: string; title: string }[] };
  documents: {
    memberId: string;
    title: string;
    displayName: string;
    role: View['member']['role'];
    versionId: string;
    isSource: boolean;
  }[];
  source: { memberId: string; title: string; versionId: string; baselineVersionId: string };
  createdAt: string;
  updatedAt: string;
  summary: string;
  stopReason: string;
  stopCode?: 'NO_PROGRESS';
  stats: Stats;
  budget: Budget;
  reviewBatches: ReviewBatch[];
  decisions: Decision[];
  coverage: {
    expected: number;
    judged: number;
    complete: boolean;
    missingDeltas: string[];
    unchecked: number;
    candidateBodies: number;
    changesDescribed: number;
    gaps: { changeId: string; refId: string; reason: string }[];
  };
  changes: Change[];
  findings: Finding[];
  anchorGates: {
    changeId: string;
    missing: string[];
    blocking: { refId: string; status: FindingStatus; reason: string; evidenceIds: string[] }[];
  }[];
  proposals: ProposalSummary[];
  history: { memberId: string; beforeVersionId: string; afterVersionId: string; deltas: Delta[] }[];
  unresolved: { changeId: string; refId: string; reason: string; questions?: string[]; relatedRefIds?: string[] }[];
  toolResultNote: string;
};
export type ProposalEvidence = {
  proposalId: string;
  runId: string;
  target?: View;
  source: View;
  change?: Change;
  evidence: (Evidence & { ref?: Ref })[];
  patches: Patch[];
  reason: string;
};
export type ReviewResult = { batch?: ReviewBatch; report: AgentReport; workspace: Snapshot };
export type DecisionRequest = {
  action: 'retain' | 'defer';
  reason: string;
  sourceHash?: string;
  targetHash?: string;
  policyHash?: string;
};
export type RunCreated = { runId: string; status?: RunStatus; retriedFromId?: string };
export type ModelConfiguration = {
  requestTimeoutMs?: number;
  transientRetryLimit?: number;
  model: string;
  thinking: boolean;
  effort: string | null;
  maxTokens: number;
};
