const SHA256_PREFIX = 'sha256:';
const SHA256_HEX_RE = /^[a-f0-9]{64}$/u;

export function normalizeSha256Digest(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const lower = trimmed.toLowerCase();
  const digest = lower.startsWith(SHA256_PREFIX)
    ? lower.slice(SHA256_PREFIX.length)
    : lower;

  return SHA256_HEX_RE.test(digest) ? digest : undefined;
}

export function isSha256Digest(value: string | null | undefined): boolean {
  return normalizeSha256Digest(value) !== undefined;
}
