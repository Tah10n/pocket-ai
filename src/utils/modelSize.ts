export const DECIMAL_GIGABYTE = 1000 * 1000 * 1000;

export function formatModelFileSize(
  value: number | null | undefined,
  unknownLabel: string,
): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return unknownLabel;
  }

  return `${(value / DECIMAL_GIGABYTE).toFixed(2)} GB`;
}
