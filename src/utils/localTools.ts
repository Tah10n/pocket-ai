import { sanitizeLocalToolRun, type LocalToolRun } from '../types/localTools';

/** A run envelope is bookkeeping; only parsed content or canonical calls are progress. */
export function hasLocalToolRunProgress(run: LocalToolRun | undefined): boolean {
  const canonicalRun = sanitizeLocalToolRun(run);
  return canonicalRun?.rounds.some((round) => round.content.trim().length > 0 || round.calls.length > 0) ?? false;
}

/** Shared by terminal commits and the streaming journal so cold recovery agrees with rollback. */
export function hasAssistantTurnProgress(value: {
  content: string;
  thoughtContent?: string;
  toolRun?: LocalToolRun;
}): boolean {
  return value.content.trim().length > 0
    || (value.thoughtContent?.trim().length ?? 0) > 0
    || hasLocalToolRunProgress(value.toolRun);
}
