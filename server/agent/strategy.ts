import type { ModelMessage, Run, Proposal } from './types.ts';
export type StrategyKnowledge = { proposals: Proposal[] };

// A trusted, replaceable strategy has no writer/store/runtime handle.
// Inputs are detached copies. Tools and execution guards remain in the core.
export interface AgentStrategy {
  readonly identity?: {
    packId: string;
    fingerprint: string;
    promptHash: string;
    manifestHash: string;
    assets: { file: string; hash: string }[];
    projection: string;
    observation: string;
  };
  readonly version: string;
  readonly systemPrompt: string;
  buildMessages(run: Run, knowledge?: StrategyKnowledge): ModelMessage[];
  formatObservation(toolName: string, result: unknown): unknown;
}
