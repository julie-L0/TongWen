import type { AgentStrategy } from '../strategy.ts';
import { loadStrategyPack } from './load.ts';

export const defaultStrategy: AgentStrategy = loadStrategyPack();
