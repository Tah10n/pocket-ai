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
 */
export function safeJoinModelPath(baseDir: string, fileName: string): string | null {
  if (!isValidLocalFileName(fileName)) {
    return null;
  }

  if (typeof baseDir !== 'string' || baseDir.length === 0) {
    return null;
  }

  const normalizedBaseDir = baseDir.endsWith('/') ? baseDir : `${baseDir}/`;
  return `${normalizedBaseDir}${fileName}`;
}

function decodeSafePercentSequences(segment: string): string {
  return segment.replace(/(?:%[0-9A-Fa-f]{2})+/g, (encoded) => {
    try {
      const decoded = decodeURIComponent(encoded);
      return decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')
        ? encoded
        : decoded;
    } catch {
      return encoded;
    }
  });
}

export function fileUriToNativePath(pathOrUri: string): string {
  if (!pathOrUri.startsWith('file://')) {
    return pathOrUri;
  }

  const pathWithEscapes = pathOrUri.replace(/^file:\/+/, '/');
  return pathWithEscapes.split('/').map(decodeSafePercentSequences).join('/');
}
