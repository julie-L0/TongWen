import type { AgentGateway } from '../application/agent-gateway.ts';
import type { AgentService } from './service.ts';
import type { AgentRuntime } from './runtime.ts';

// The composition root chooses the engine; routes consume this facade.
export function createAgentGateway(service: AgentService, runtime: AgentRuntime): AgentGateway {
  return {
    get strategyVersion() { return service.strategy.version; },
    get executionIdentity() { return structuredClone(service.executionIdentity); },
    get reviewProtocol() { return service.reviewProtocol; },
    get configuration() {
      return runtime.configuration;
    },
    create(input) {
      const run = service.create(input);
      runtime.start(run.id);
      return { runId: run.id, status: service.store.run(run.id).status };
    },
    list: () =>
      service.store
        .runs()
        .map((run) => ({
          id: run.id,
          status: run.status,
          sourceMemberId: run.manifest.sourceMemberId,
          createdAt: run.createdAt,
        })),
    report: (id) => service.report(id),
    events: (id, cursor) => service.store.events(id, cursor),
    cancel: (id) => runtime.cancel(id),
    retry(id, requestId) {
      const previous = service.store.run(id);
      const run = service.create({
        sourceMemberId: previous.manifest.sourceMemberId,
        sourceBlockIds: previous.sourceBlockIds,
        memberIds: previous.manifest.views.map((v) => v.member.id),
        baselineVersionId: previous.manifest.source.baseline.id,
        requestId,
      });
      runtime.start(run.id);
      return { runId: run.id, retriedFromId: previous.id };
    },
    apply: (id, input) => service.apply(id, input),
    undoBatch: (id, requestId) => service.undoBatch(id, requestId),
    undoOperation(id, requestId) {
      const batch = service.store.reviewBatches().find((b) => b.operations.some((o) => o.operationId === id));
      return batch ? service.undoBatch(batch.id, requestId).workspace : null;
    },
    evidence: (id) => service.proposalEvidence(id),
    differences: () => service.store.differences(),
    decision: (id, input) => service.decision(id, input),
    revokeDecision: (id) => service.revokeDecision(id),
  };
}
