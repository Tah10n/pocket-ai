export const LOCAL_TOOL_LIMITS = Object.freeze({
  rounds: 4, calls: 8, argumentBytes: 4096, resultBytes: 8192,
  totalResultBytes: 32768, runMilliseconds: 180000, toolMilliseconds: 10000,
  predictedTokens: 4096, totalTokens: 32768, documentQueryCharacters: 256, documentCount: 4,
  documentChunks: 4, documentExcerptCharacters: 1200, documentFileBytes: 10 * 1024 * 1024,
});

/** UTF-8 byte count, including replacement bytes for unpaired UTF-16 surrogates. */
export function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}
