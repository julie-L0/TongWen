import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { hash } from '../domain/rules.ts';
import { toolSchemas } from './schemas.ts';
import type { AgentStrategy } from './strategy.ts';
import type { ExecutionIdentity } from '../../shared/contracts/agent.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const digest = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
// Read at startup/run creation; experiments also compare this with the end snapshot.
export function codeFingerprint() {
  const files: { file: string; hash: string }[] = [];
  function visit(relative: string) {
    for (const e of readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const file = path.posix.join(relative, e.name);
      if (e.isDirectory()) visit(file);
      else if (e.name.endsWith('.ts'))
        files.push({ file, hash: digest(readFileSync(path.join(root, file))) });
    }
  }
  visit('server');
  visit('shared');
  return hash(files);
}
export function executionIdentity(strategy: AgentStrategy): ExecutionIdentity {
  return {
    packId: strategy.identity?.packId || 'injected',
    strategyFingerprint:
      hash({
        packFingerprint: strategy.identity?.fingerprint || null,
        version: strategy.version,
        prompt: strategy.systemPrompt,
        projection: String(strategy.buildMessages),
        observation: String(strategy.formatObservation),
      }),
    promptHash: digest(strategy.systemPrompt),
    assets: structuredClone(strategy.identity?.assets || []),
    toolSchemaHash: hash(toolSchemas),
    codeHash: codeFingerprint(),
  };
}
