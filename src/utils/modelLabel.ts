export function getShortModelLabel(modelId: string): string {
  const normalized = String(modelId ?? '').trim().replace(/\/+$/, '');
  if (!normalized) {
    return '';
  }

  const lastSegment = normalized.split('/').filter(Boolean).pop();
  return lastSegment ?? normalized;
}
