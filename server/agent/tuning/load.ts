import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { AgentStrategy } from '../strategy.ts';
import { modelContext, compactObservation } from './context.ts';
import { leanModelContext, leanObservation } from './lean-context.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const defaultPackDirectory = fileURLToPath(new URL('./packs/default/', import.meta.url));

// Data-only packs select trusted projections; they cannot load executable modules or guards.
export function loadStrategyPack(directory = defaultPackDirectory): AgentStrategy {
  const root = realpathSync(directory);
  function read(relative: string) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..'))
      throw new Error('Strategy assets must stay inside their pack');
    const resolved = realpathSync(path.join(root, relative));
    const inside = path.relative(root, resolved);
    if (inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('Strategy asset escapes pack');
    const bytes = readFileSync(resolved);
    if (bytes.length > 256000) throw new Error('Strategy asset exceeds 256 KB');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  const rawManifest = read('strategy.json');
  const manifest = JSON.parse(rawManifest);
  const allowed = ['id', 'version', 'projection', 'observation', 'prompts'];
  if (
    !manifest ||
    Array.isArray(manifest) ||
    Object.keys(manifest).some((k) => !allowed.includes(k)) ||
    typeof manifest.id !== 'string' ||
    !/^[a-z0-9-]{1,64}$/.test(manifest.id) ||
    typeof manifest.version !== 'string' ||
    !manifest.version.trim() ||
    !['documents-v1', 'lean-documents-v1', 'lean-source-clauses-v1', 'lean-source-clauses-v2'].includes(manifest.projection) ||
    !['compact-v1', 'lean-v1'].includes(manifest.observation) ||
    !Array.isArray(manifest.prompts) ||
    !manifest.prompts.length ||
    manifest.prompts.length > 8 ||
    manifest.prompts.some((p: unknown) => typeof p !== 'string' || !p.endsWith('.md'))
  )
    throw new Error('Invalid strategy manifest; packs cannot configure execution permissions');
  const assets = (manifest.prompts as string[]).map((file) => ({ file, text: read(file) }));
  const systemPrompt = assets.map((a) => a.text).join('\n\n');
  if (!systemPrompt.trim()) throw new Error('Empty strategy prompt');
  const identity = {
    packId: manifest.id as string,
    promptHash: digest(systemPrompt),
    manifestHash: digest(rawManifest),
    assets: assets.map(({ file, text }) => ({ file, hash: digest(text) })),
    projection: manifest.projection as string,
    observation: manifest.observation as string,
    fingerprint: '',
  };
  identity.fingerprint = digest(JSON.stringify(identity));
  return Object.freeze({
    version: manifest.version as string,
    identity: Object.freeze(identity),
    systemPrompt,
    buildMessages: manifest.projection.startsWith('lean-') ? leanModelContext : modelContext,
    formatObservation: manifest.observation === 'lean-v1' ? leanObservation : compactObservation,
  });
}
