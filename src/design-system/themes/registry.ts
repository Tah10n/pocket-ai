import type { ThemeDefinition, ThemeMetadata } from './contract';
import { defaultTheme } from './default.theme';
import { glassTheme } from './glass.theme';
import { deepFreeze } from './immutable';

export const themeDefinitions = deepFreeze(
  [defaultTheme, glassTheme] as const satisfies readonly ThemeDefinition[],
);

export type ThemeId = typeof themeDefinitions[number]['id'];
type RegisteredThemeDefinition<Id extends ThemeId> = Extract<(typeof themeDefinitions)[number], { id: Id }>;

export const DEFAULT_THEME_ID = 'default' satisfies ThemeId;

const themeDefinitionById = new Map<string, (typeof themeDefinitions)[number]>(
  themeDefinitions.map((definition) => [definition.id, definition]),
);

const themeMetadata = deepFreeze(themeDefinitions.map(({ id, labelKey, descriptionKey, preview }) => ({
  id,
  labelKey,
  descriptionKey,
  preview: { ...preview },
}))) as readonly ThemeMetadata<ThemeId>[];

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && themeDefinitionById.has(value);
}

export function getThemeDefinition<Id extends ThemeId>(value: Id): RegisteredThemeDefinition<Id>;
export function getThemeDefinition(value: unknown): (typeof themeDefinitions)[number];
export function getThemeDefinition(value: unknown): (typeof themeDefinitions)[number] {
  return isThemeId(value)
    ? themeDefinitionById.get(value) ?? defaultTheme
    : defaultTheme;
}

export function getThemeMetadata(): readonly ThemeMetadata<ThemeId>[] {
  return themeMetadata;
}
