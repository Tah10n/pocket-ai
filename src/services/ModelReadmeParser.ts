import type { HuggingFaceModelCardData, ReadmeFrontMatterValue, ReadmeModelData } from '../types/huggingFace';

const README_SUMMARY_MAX_LENGTH = 320;

export function extractReadmeData(markdown: string): ReadmeModelData {
  if (!markdown.trim()) {
    return {};
  }

  let body = markdown.replace(/\r\n/g, '\n');
  let frontMatter: Record<string, ReadmeFrontMatterValue> | undefined;
  if (body.startsWith('---\n')) {
    const frontMatterEnd = body.indexOf('\n---\n', 4);
    if (frontMatterEnd >= 0) {
      frontMatter = parseReadmeFrontMatter(body.slice(4, frontMatterEnd));
      body = body.slice(frontMatterEnd + 5);
    }
  }

  return {
    description: extractReadmeSummaryFromBody(body),
    cardData: frontMatter ? mapReadmeFrontMatterToCardData(frontMatter) : undefined,
    maxContextTokens: frontMatter ? resolveFrontMatterMaxContextTokens(frontMatter) : undefined,
  };
}

function extractReadmeSummaryFromBody(body: string): string | undefined {
  if (!body.trim()) {
    return undefined;
  }

  const paragraphs = body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => isReadableReadmeParagraph(paragraph))
    .map((paragraph) => stripMarkdown(paragraph))
    .filter((paragraph) => paragraph.length >= 24);

  const summary = paragraphs[0];
  if (!summary) {
    return undefined;
  }

  if (summary.length <= README_SUMMARY_MAX_LENGTH) {
    return summary;
  }

  return `${summary.slice(0, README_SUMMARY_MAX_LENGTH).trimEnd()}...`;
}

export function parseReadmeFrontMatter(frontMatter: string): Record<string, ReadmeFrontMatterValue> {
  const parsed: Record<string, ReadmeFrontMatterValue> = {};
  let activeListKey: string | null = null;

  for (const rawLine of frontMatter.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const listMatch = trimmed.match(/^-\s+(.+)$/);
    if (listMatch && activeListKey) {
      const normalizedItem = normalizeFrontMatterScalar(listMatch[1]);
      if (!normalizedItem) {
        continue;
      }

      const existing = parsed[activeListKey];
      const nextList = Array.isArray(existing) ? existing : [];
      nextList.push(normalizedItem);
      parsed[activeListKey] = nextList;
      continue;
    }

    const keyValueMatch = trimmed.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!keyValueMatch) {
      activeListKey = null;
      continue;
    }

    const [, key, rawValue] = keyValueMatch;
    const value = rawValue.trim();

    if (!value) {
      parsed[key] = [];
      activeListKey = key;
      continue;
    }

    activeListKey = null;
    if (value.startsWith('[') && value.endsWith(']')) {
      const inlineList = value
        .slice(1, -1)
        .split(',')
        .map((entry) => normalizeFrontMatterScalar(entry))
        .filter((entry): entry is string => entry.length > 0);

      if (inlineList.length > 0) {
        parsed[key] = inlineList;
      }
      continue;
    }

    const normalizedValue = normalizeFrontMatterScalar(value);
    if (normalizedValue) {
      parsed[key] = normalizedValue;
    }
  }

  return parsed;
}

function mapReadmeFrontMatterToCardData(
  frontMatter: Record<string, ReadmeFrontMatterValue>,
): Partial<HuggingFaceModelCardData> | undefined {
  const baseModels = getFrontMatterArray(frontMatter, 'base_model');
  const languages = getFrontMatterArray(frontMatter, 'language');
  const datasets = getFrontMatterArray(frontMatter, 'datasets');
  const license = getFrontMatterString(frontMatter, 'license');
  const modelCreator = getFrontMatterString(frontMatter, 'model_creator');
  const quantizedBy = getFrontMatterString(frontMatter, 'quantized_by');
  const modelType = getFrontMatterString(frontMatter, 'model_type');

  const cardData: Partial<HuggingFaceModelCardData> = {};
  if (baseModels?.length) {
    cardData.base_model = baseModels.length === 1 ? baseModels[0] : baseModels;
  }
  if (languages?.length) {
    cardData.language = languages.length === 1 ? languages[0] : languages;
  }
  if (datasets?.length) {
    cardData.datasets = datasets;
  }
  if (license) {
    cardData.license = license;
  }
  if (modelCreator) {
    cardData.model_creator = modelCreator;
  }
  if (quantizedBy) {
    cardData.quantized_by = quantizedBy;
  }
  if (modelType) {
    cardData.model_type = modelType;
  }

  return Object.keys(cardData).length > 0 ? cardData : undefined;
}

function resolveFrontMatterMaxContextTokens(frontMatter: Record<string, ReadmeFrontMatterValue>): number | undefined {
  return resolveLargestContextTokenValue([
    getFrontMatterString(frontMatter, 'context_length'),
    getFrontMatterString(frontMatter, 'max_position_embeddings'),
    getFrontMatterString(frontMatter, 'n_positions'),
    getFrontMatterString(frontMatter, 'max_sequence_length'),
    getFrontMatterString(frontMatter, 'seq_length'),
    getFrontMatterString(frontMatter, 'sliding_window'),
    getFrontMatterString(frontMatter, 'model_max_length'),
    getFrontMatterString(frontMatter, 'n_ctx'),
    getFrontMatterString(frontMatter, 'n_ctx_train'),
    getFrontMatterString(frontMatter, 'num_ctx'),
    getFrontMatterString(frontMatter, 'original_max_position_embeddings'),
  ]);
}

function normalizeFrontMatterScalar(value: string): string {
  const normalized = value
    .trim()
    .replace(/^['"]/, '')
    .replace(/['"]$/, '')
    .replace(/^"(.*)"$/, '$1')
    .replace(/^'(.*)'$/, '$1')
    .trim();

  if (normalized === 'null' || normalized === '[]') {
    return '';
  }

  return normalized;
}

function getFrontMatterString(
  frontMatter: Record<string, ReadmeFrontMatterValue>,
  key: string,
): string | undefined {
  const value = frontMatter[key];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  if (Array.isArray(value) && value.length > 0) {
    return value[0];
  }

  return undefined;
}

function getFrontMatterArray(
  frontMatter: Record<string, ReadmeFrontMatterValue>,
  key: string,
): string[] | undefined {
  const value = frontMatter[key];
  if (Array.isArray(value)) {
    return value.length > 0 ? value : undefined;
  }

  if (typeof value === 'string' && value.length > 0) {
    return [value];
  }

  return undefined;
}

function isReadableReadmeParagraph(paragraph: string): boolean {
  if (!paragraph) {
    return false;
  }

  return !(
    paragraph.startsWith('#')
    || paragraph.startsWith('![')
    || paragraph.startsWith('[')
    || paragraph.startsWith('<')
    || paragraph.startsWith('|')
    || paragraph.startsWith('```')
    || paragraph.startsWith('---')
  );
}

export function stripMarkdown(text: string): string {
  return text
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*_~>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveLargestContextTokenValue(values: unknown[]): number | undefined {
  let resolved: number | undefined;

  for (const value of values) {
    const normalized = normalizeContextTokenValue(value);
    if (normalized === undefined) {
      continue;
    }

    resolved = resolved === undefined ? normalized : Math.max(resolved, normalized);
  }

  return resolved;
}

function normalizeContextTokenValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 256) {
    return Math.round(value);
  }

  if (typeof value === 'string') {
    const normalizedValue = value.trim().toLowerCase().replace(/[_\s,]/g, '');
    const shorthandMatch = normalizedValue.match(/^(\d+(?:\.\d+)?)([km])?(?:tokens?)?$/);
    const multiplier = shorthandMatch?.[2] === 'm'
      ? 1024 * 1024
      : shorthandMatch?.[2] === 'k'
        ? 1024
        : 1;
    const normalized = shorthandMatch
      ? Number(shorthandMatch[1]) * multiplier
      : Number(normalizedValue);
    if (Number.isFinite(normalized) && normalized >= 256) {
      return Math.round(normalized);
    }
  }

  return undefined;
}

