const AUTH_MATERIAL_PATTERN = /\b(?:authorization|bearer)\b/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOpaqueResumeData(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || AUTH_MATERIAL_PATTERN.test(trimmed)) {
    return undefined;
  }

  return value;
}

/**
 * Normalize persisted/native download resume state to the only safe value we can
 * store: Expo's opaque native resumeData string. Full DownloadResumable.savable()
 * snapshots can include url/fileUri/options/headers, so this helper deliberately
 * extracts only the inner resumeData value and drops anything that appears to
 * contain Authorization/Bearer material.
 */
export function normalizeDownloadResumeData(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (isRecord(parsed)) {
        return normalizeOpaqueResumeData(parsed.resumeData);
      }

      return undefined;
    } catch {
      return normalizeOpaqueResumeData(trimmed);
    }
  }

  if (isRecord(value)) {
    return normalizeOpaqueResumeData(value.resumeData);
  }

  return undefined;
}
