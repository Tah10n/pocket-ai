export const ANDROID_QA_INSTANCE_PATTERN: string;
export function normalizeAndroidQaInstance(value?: string | null): string | null;
export function resolveAndroidQaApplicationId(
  defaultApplicationId?: string | null,
  isolatedQaInstall?: boolean,
  qaInstance?: string | null,
): string | null;
export function parseAndroidQaApplicationId(
  applicationId: string,
  defaultApplicationId: string,
): { instance: string | null } | null;
