import fs from 'fs';
import * as i18next from 'i18next';
import path from 'path';
import enLocale from '../../src/i18n/locales/en.json';
import ruLocale from '../../src/i18n/locales/ru.json';

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

function getNestedValue(value: unknown, keyPath: string): unknown {
  return keyPath.split('.').reduce<unknown>((current, key) => {
    if (!isPlainObject(current)) {
      return undefined;
    }

    return current[key];
  }, value);
}

async function createI18n(language: 'en' | 'ru'): Promise<i18next.i18n> {
  const instance = i18next.createInstance();
  await instance.init({
    resources: {
      en: { translation: enLocale },
      ru: { translation: ruLocale },
    },
    lng: language,
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false,
    },
    compatibilityJSON: 'v4',
  });
  return instance;
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

  it('covers all multimodal readiness explanation keys in both locales', () => {
    const en = loadJson(path.resolve(__dirname, '../../src/i18n/locales/en.json'));
    const ru = loadJson(path.resolve(__dirname, '../../src/i18n/locales/ru.json'));
    const readinessKeys = [
      'chat.visionReadiness.ready',
      'chat.visionReadiness.textOnly',
      'chat.visionReadiness.missingProjector',
      'chat.visionReadiness.ambiguousProjector',
      'chat.visionReadiness.projectorDownloading',
      'chat.visionReadiness.initializing',
      'chat.visionReadiness.failed',
      'chat.visionReadiness.noModel',
      'chat.visionReadiness.editingMessage',
      'chat.visionReadiness.unsupported',
    ];

    for (const readinessKey of readinessKeys) {
      expect(typeof getNestedValue(en, readinessKey)).toBe('string');
      expect(typeof getNestedValue(ru, readinessKey)).toBe('string');
    }
  });

  it('resolves multimodal attachment and projector copy through real i18n lookups', async () => {
    for (const language of ['en', 'ru'] as const) {
      const i18n = await createI18n(language);
      const tooLargeReason = i18n.t('chat.attachments.tooLarge');
      const lookupCases = [
        {
          key: 'chat.attachments.attachImageAccessibilityLabel',
        },
        {
          key: 'chat.attachments.limitReached',
          options: { count: 4 },
          expectedFragments: ['4'],
        },
        {
          key: 'chat.attachments.preparingImage',
        },
        {
          key: 'chat.attachments.copyFailed',
        },
        {
          key: 'chat.attachments.mixedFailures',
        },
        {
          key: 'chat.attachments.failedPreviewIndexedAccessibilityLabel',
          options: { index: 1, count: 2, reason: tooLargeReason },
          expectedFragments: ['1', '2', tooLargeReason],
        },
        {
          key: 'chat.visionReadiness.missingProjector',
        },
        {
          key: 'chat.visionReadiness.ambiguousProjector',
        },
        {
          key: 'chat.visionReadiness.projectorDownloading',
        },
        {
          key: 'chat.visionReadiness.failed',
        },
        {
          key: 'chat.visionReadiness.unsupported',
        },
      ];

      for (const { key, options, expectedFragments = [] } of lookupCases) {
        const value = i18n.t(key, options);

        expect(value).not.toBe(key);
        expect(value).not.toContain('{{');
        for (const expectedFragment of expectedFragments) {
          expect(value).toContain(expectedFragment);
        }
      }
    }
  });
});
