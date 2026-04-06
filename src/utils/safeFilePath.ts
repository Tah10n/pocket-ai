/**
 * Validates that a filename is safe for use as a direct child of a base directory.
 * Rejects path traversal sequences, path separators, and empty/whitespace-only names.
 */
export function isValidLocalFileName(name: unknown): name is string {
  if (typeof name !== 'string' || name.length === 0) {
    return false;
  }

  if (name !== name.trim()) {
    return false;
  }

  if (name === '.' || name === '..') {
    return false;
  }

  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return false;
  }

  // Reject null bytes
  if (name.includes('\0')) {
    return false;
  }

  return true;
}

/**
 * Joins a base directory with a filename, returning null if the filename is unsafe.
 * The base directory must end with '/'.
 */
export function safeJoinModelPath(baseDir: string, fileName: string): string | null {
  if (!isValidLocalFileName(fileName)) {
    return null;
  }

  return baseDir + fileName;
}
