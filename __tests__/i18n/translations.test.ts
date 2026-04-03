import fs from 'fs';
import path from 'path';

const pluralCategories = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;
type PluralCategory = typeof pluralCategories[number];

const requiredPluralCategoriesByLocale: Record<string, readonly PluralCategory[]> = {
  en: ['one', 'other'],
  ru: ['one', 'few', 'many', 'other'],
};

function loadJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function flattenKeys(value: unknown, prefix = ''): string[] {
  if (!isPlainObject(value)) {
    return prefix ? [prefix] : [];
  }

  const keys: string[] = [];

  for (const [key, child] of Object.entries(value)) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(child)) {
      keys.push(...flattenKeys(child, nextPrefix));
    } else {
      keys.push(nextPrefix);
    }
  }

  return keys;
}

function splitPluralKey(key: string): { baseKey: string; pluralCategory: PluralCategory | null } {
  const parts = key.split('.');
  const last = parts[parts.length - 1] ?? '';

  const match = last.match(new RegExp(`^(.*)_(${pluralCategories.join('|')})$`));
  if (!match) {
    return { baseKey: key, pluralCategory: null };
  }

  parts[parts.length - 1] = match[1];
  return { baseKey: parts.join('.'), pluralCategory: match[2] as PluralCategory };
}

function analyzeLocale(value: unknown): { baseKeys: Set<string>; pluralFormsByBaseKey: Map<string, Set<PluralCategory>> } {
  const baseKeys = new Set<string>();
  const pluralFormsByBaseKey = new Map<string, Set<PluralCategory>>();

  for (const leafKey of flattenKeys(value)) {
    const { baseKey, pluralCategory } = splitPluralKey(leafKey);
    baseKeys.add(baseKey);

    if (pluralCategory) {
      const existing = pluralFormsByBaseKey.get(baseKey) ?? new Set<PluralCategory>();
      existing.add(pluralCategory);
      pluralFormsByBaseKey.set(baseKey, existing);
    }
  }

  return { baseKeys, pluralFormsByBaseKey };
}

describe('i18n locale parity', () => {
  it('keeps en and ru locales in sync', () => {
    const enPath = path.resolve(__dirname, '../../src/i18n/locales/en.json');
    const ruPath = path.resolve(__dirname, '../../src/i18n/locales/ru.json');

    const en = loadJson(enPath);
    const ru = loadJson(ruPath);

    const enAnalysis = analyzeLocale(en);
    const ruAnalysis = analyzeLocale(ru);

    const missingInRu = [...enAnalysis.baseKeys].filter((key) => !ruAnalysis.baseKeys.has(key)).sort();
    const missingInEn = [...ruAnalysis.baseKeys].filter((key) => !enAnalysis.baseKeys.has(key)).sort();

    const missingPluralFormsInRu = [...enAnalysis.pluralFormsByBaseKey.keys()]
      .filter((key) => !ruAnalysis.pluralFormsByBaseKey.has(key))
      .sort();
    const missingPluralFormsInEn = [...ruAnalysis.pluralFormsByBaseKey.keys()]
      .filter((key) => !enAnalysis.pluralFormsByBaseKey.has(key))
      .sort();

    const pluralBaseKeys = new Set<string>([
      ...enAnalysis.pluralFormsByBaseKey.keys(),
      ...ruAnalysis.pluralFormsByBaseKey.keys(),
    ]);

    const missingPluralCategoriesInEn: string[] = [];
    const missingPluralCategoriesInRu: string[] = [];

    for (const baseKey of pluralBaseKeys) {
      const enPlural = enAnalysis.pluralFormsByBaseKey.get(baseKey);
      const ruPlural = ruAnalysis.pluralFormsByBaseKey.get(baseKey);

      if (!enPlural || !ruPlural) continue;

      for (const requiredCategory of requiredPluralCategoriesByLocale.en) {
        if (!enPlural.has(requiredCategory)) {
          missingPluralCategoriesInEn.push(`${baseKey}:${requiredCategory}`);
        }
      }
      for (const requiredCategory of requiredPluralCategoriesByLocale.ru) {
        if (!ruPlural.has(requiredCategory)) {
          missingPluralCategoriesInRu.push(`${baseKey}:${requiredCategory}`);
        }
      }
    }

    missingPluralCategoriesInEn.sort();
    missingPluralCategoriesInRu.sort();

    expect({
      missingInRu,
      missingInEn,
      missingPluralFormsInRu,
      missingPluralFormsInEn,
      missingPluralCategoriesInEn,
      missingPluralCategoriesInRu,
    }).toEqual({
      missingInRu: [],
      missingInEn: [],
      missingPluralFormsInRu: [],
      missingPluralFormsInEn: [],
      missingPluralCategoriesInEn: [],
      missingPluralCategoriesInRu: [],
    });
  });
});
