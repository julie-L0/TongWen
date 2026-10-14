import { api, type ApiRequest } from './client.ts';
import type {
  AgentReport,
  CreateRunRequest,
  DecisionRequest,
  ProposalEvidence,
  ReviewResult,
  RunCreated,
  RunSummary,
  RunEvent,
} from '../../shared/contracts/agent.ts';
import type { Decision, Snapshot } from '../../shared/contracts/workspace.ts';

// UI calls named commands; HTTP paths and public DTOs have one owner.
export function createAgentClient(request: ApiRequest = api) {
  const id = encodeURIComponent;
  return {
    create: (input: CreateRunRequest) => request<RunCreated>('/runs', input),
    list: () => request<RunSummary[]>('/runs'),
    report: (runId: string, signal?: AbortSignal) => request<AgentReport>(`/runs/${id(runId)}`, undefined, 'GET', { signal }),
    events: (runId: string, cursor = 0) => request<RunEvent[]>(`/runs/${id(runId)}/events?cursor=${cursor}`),
    async toolResult(runId: string, callId: string): Promise<unknown> {
      let cursor = 0;
      for (;;) {
        const events = await request<RunEvent[]>(`/runs/${id(runId)}/events?cursor=${cursor}`);
        if (!events.length) throw new Error('未找到该动作的执行反馈；尚在执行时请稍后重试。');
        for (const event of events) {
          const payload = event.payload as { callId?: string; result?: unknown } | null;
          if (['tool_result', 'tool_error'].includes(event.kind) && payload?.callId === callId) return payload.result;
        }
        const next = events.at(-1)!.id;
        if (next <= cursor) throw new Error('调查记录游标未推进，请重新打开任务。');
        cursor = next;
      }
    },
    cancel: (runId: string) => request<AgentReport>(`/runs/${id(runId)}/cancel`, {}),
    retry: (runId: string, requestId: string) =>
      request<RunCreated>(`/runs/${id(runId)}/retry`, { requestId }),
    apply: (runId: string, proposalIds: string[], requestId: string) =>
      request<ReviewResult>(`/runs/${id(runId)}/apply`, { proposalIds, requestId }),
    undo: (batchId: string, requestId: string) =>
      request<ReviewResult>(`/review-batches/${id(batchId)}/undo`, { requestId }),
    evidence: (proposalId: string) => request<ProposalEvidence>(`/proposals/${id(proposalId)}/evidence`),
    decide: (differenceId: string, input: DecisionRequest) =>
      request<Decision>(`/differences/${id(differenceId)}/decisions`, input),
    revoke: (decisionId: string) => request<Snapshot>(`/decisions/${id(decisionId)}/revoke`, {}),
  };
}
export const agentApi = createAgentClient();
export type AgentClient = ReturnType<typeof createAgentClient>;
