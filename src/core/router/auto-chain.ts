import { rankModels, type ModelStats } from '../models/stats.ts';
import { modelStrength } from '../models/strength.ts';

export interface ChainCandidate {
  id: string;
  provider: string;
  fallback: boolean;
}

const MAX_FALLBACK_MODELS = 8;
const MAX_AGENT_MODELS = 8;

function webRank(order: readonly string[], provider: string) {
  const index = order.indexOf(provider);
  return index === -1 ? order.length : index;
}

export function buildAutoChain(
  candidates: ChainCandidate[],
  stats: Pick<ModelStats, 'get'>,
  isAvailable: (model: string) => boolean = () => true,
  webOrder: readonly string[] = [],
) {
  const usable = candidates.filter(candidate => isAvailable(candidate.id));
  const primary = [...new Set(usable.filter(candidate => !candidate.fallback).map(candidate => candidate.provider))]
    .sort((a, b) => webRank(webOrder, a) - webRank(webOrder, b))
    .map(provider => rankModels(usable.filter(candidate => candidate.provider === provider).map(candidate => candidate.id), stats)[0]!);
  const fallback = rankModels(usable.filter(candidate => candidate.fallback).map(candidate => candidate.id), stats)
    .slice(0, MAX_FALLBACK_MODELS);
  return [...primary, ...fallback];
}

export function buildAgentChain(
  candidates: Array<ChainCandidate & { nativeTools: boolean }>,
  stats: Pick<ModelStats, 'get'>,
  fallback: readonly string[],
  isAvailable: (model: string) => boolean = () => true,
) {
  const native = candidates
    .filter(candidate => candidate.nativeTools && isAvailable(candidate.id) && modelStrength(candidate.id) < 2)
    .map(candidate => candidate.id);
  const ranked = rankModels(native, stats)
    .sort((a, b) => modelStrength(a) - modelStrength(b))
    .slice(0, MAX_AGENT_MODELS);
  return [...fallback, ...ranked.filter(model => !fallback.includes(model))];
}
