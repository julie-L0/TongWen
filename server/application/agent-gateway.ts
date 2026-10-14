import type {
  AgentReport,
  ExecutionIdentity,
  CreateRunRequest,
  DecisionRequest,
  Difference,
  ModelConfiguration,
  ProposalEvidence,
  ReviewResult,
  RunCreated,
  RunEvent,
  RunSummary,
} from '../../shared/contracts/agent.ts';
import type { Decision, Snapshot } from '../../shared/contracts/workspace.ts';

// HTTP knows commands and public values, never model loops, prompts or stores.
export interface AgentGateway {
  readonly strategyVersion?: string;
  readonly executionIdentity?: ExecutionIdentity;
  readonly reviewProtocol?: 'fragments-v1' | 'documents-v1';
  readonly configuration: ModelConfiguration | null;
  create(input: CreateRunRequest): RunCreated;
  list(): RunSummary[];
  report(id: string): AgentReport;
  events(id: string, cursor: number): RunEvent[];
  cancel(id: string): AgentReport;
  retry(id: string, requestId: string): RunCreated;
  apply(id: string, input: { proposalIds: string[]; requestId: string }): ReviewResult;
  undoBatch(id: string, requestId: string): ReviewResult;
  undoOperation(id: string, requestId: string): Snapshot | null;
  evidence(id: string): ProposalEvidence;
  differences(): Difference[];
  decision(id: string, input: DecisionRequest): Decision;
  revokeDecision(id: string): Snapshot;
}
