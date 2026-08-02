import { toByteArray } from 'base64-js';
import { Inflate } from 'pako';

export type PdfTextExtractionFailureReason =
  | 'encrypted'
  | 'invalid_pdf'
  | 'no_extractable_text'
  | 'resource_limit'
  | 'unsupported_filter'
  | 'unsupported_structure';

export class PdfTextExtractionError extends Error {
  public readonly reason: PdfTextExtractionFailureReason;

  constructor(reason: PdfTextExtractionFailureReason, message: string) {
    super(message);
    this.name = 'PdfTextExtractionError';
    this.reason = reason;
    Object.setPrototypeOf(this, PdfTextExtractionError.prototype);
  }
}

export interface PdfTextExtractionResult {
  text: string;
  pageCount?: number;
  isScanned: boolean;
}

type PdfStreamCandidate = {
  objectKey: string;
  dictionary: string;
  bytes: Uint8Array;
};

type PdfObjectReference = {
  objectNumber: number;
  generationNumber: number;
  key: string;
};

type PdfDictionaryObject = PdfObjectReference & {
  dictionary: string;
  stream?: PdfStreamCandidate;
};

type CollectedPdfStructure = {
  objects: Map<string, PdfDictionaryObject>;
  objectOrder: PdfDictionaryObject[];
  trailers: string[];
};

type PdfPageContentStructure = {
  pageCount: number;
  pages: PdfStreamCandidate[][];
};

type PdfDictionaryEntryRange = {
  valueStart: number;
  valueEnd: number;
};

type PdfStreamFilterMode = 'flate' | 'none' | 'unsupported';

type PdfByteRange = {
  start: number;
  end: number;
};

type PdfExtractionBudget = {
  deadlineMs: number;
  decodedDocumentBytes: number;
  parsedTokens: number;
};

type PdfContentToken =
  | { type: 'array'; value: PdfContentToken[] }
  | { type: 'name'; value: string }
  | { type: 'number'; value: number }
  | { type: 'string'; value: string }
  | { type: 'word'; value: string };

const PDF_BINARY_HEADER_PATTERN = /^%PDF-\d+\.\d/u;
const PDF_OBJECT_HEADER_PATTERN = /(\d+)\s+(\d+)\s+obj\b/gu;
const PDF_WHITESPACE_PATTERN = /[\u0000\t\n\f\r ]/u;
const PDF_DELIMITER_PATTERN = /[\u0000\t\n\f\r ()<>\[\]{}/%]/u;

const MAX_PDF_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_PDF_STREAM_COUNT = 256;
const MAX_PDF_OBJECT_COUNT = 4_096;
const MAX_PDF_XREF_SECTION_ENTRIES = 16_384;
const MAX_PDF_XREF_CHAIN_DEPTH = 8;
const MAX_PDF_PAGE_TREE_DEPTH = 64;
const MAX_PDF_PAGE_CONTENT_REFERENCES = 16_384;
const MAX_PDF_DECODED_STREAM_BYTES = 4 * 1024 * 1024;
const MAX_PDF_DECODED_DOCUMENT_BYTES = 12 * 1024 * 1024;
const MAX_PDF_DECOMPRESSION_RATIO = 128;
const MIN_PDF_RATIO_ALLOWANCE_BYTES = 1024 * 1024;
const MAX_PDF_CONTENT_TOKENS = 200_000;
const MAX_PDF_ARRAY_DEPTH = 16;
const MAX_PDF_OPERANDS = 32;
const MAX_PDF_PROCESSING_MILLIS = 2_000;
const INFLATE_INPUT_CHUNK_BYTES = 32 * 1024;
const INFLATE_OUTPUT_CHUNK_BYTES = 64 * 1024;
// TJ adjustments are expressed in thousandths of text space and subtracted
// from the text position. A sufficiently negative value therefore represents
// visible forward spacing rather than normal glyph kerning.
const PDF_TJ_WORD_BREAK_THRESHOLD = -250;

function createPdfExtractionError(
  reason: Extract<PdfTextExtractionFailureReason, 'resource_limit' | 'unsupported_structure'>,
  message: string,
): PdfTextExtractionError {
  return new PdfTextExtractionError(reason, message);
}

function assertWithinProcessingTime(budget: PdfExtractionBudget): void {
  if (Date.now() > budget.deadlineMs) {
    throw createPdfExtractionError('resource_limit', 'PDF processing exceeded the local time limit.');
  }
}

function reserveDecodedBytes(
  byteCount: number,
  streamDecodedBytes: number,
  compressedBytes: number | undefined,
  budget: PdfExtractionBudget,
): void {
  const nextStreamBytes = streamDecodedBytes + byteCount;
  const nextDocumentBytes = budget.decodedDocumentBytes + byteCount;
  if (nextStreamBytes > MAX_PDF_DECODED_STREAM_BYTES) {
    throw createPdfExtractionError('resource_limit', 'PDF stream exceeds the local decoded-size limit.');
  }
  if (nextDocumentBytes > MAX_PDF_DECODED_DOCUMENT_BYTES) {
    throw createPdfExtractionError('resource_limit', 'PDF document exceeds the local decoded-size limit.');
  }

  if (compressedBytes !== undefined) {
    const ratioLimit = Math.max(
      MIN_PDF_RATIO_ALLOWANCE_BYTES,
      compressedBytes * MAX_PDF_DECOMPRESSION_RATIO,
    );
    if (nextStreamBytes > ratioLimit) {
      throw createPdfExtractionError('resource_limit', 'PDF stream exceeds the local compression-ratio limit.');
    }
  }

  budget.decodedDocumentBytes = nextDocumentBytes;
}

function bytesToBinaryString(bytes: Uint8Array): string {
  let text = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    text += String.fromCharCode(...chunk);
  }

  return text;
}

function normalizeExtractedWhitespace(text: string): string {
  return text
    .replace(/[ \t\f\v]+/gu, ' ')
    .replace(/[ \t]*\n[ \t]*/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function isPdfWhitespace(char: string | undefined): boolean {
  return char !== undefined && PDF_WHITESPACE_PATTERN.test(char);
}

function isPdfDelimiter(char: string | undefined): boolean {
  return char === undefined || PDF_DELIMITER_PATTERN.test(char);
}

function skipPdfWhitespaceAndComments(input: string, start: number): number {
  let cursor = start;
  while (cursor < input.length) {
    if (isPdfWhitespace(input[cursor])) {
      cursor += 1;
      continue;
    }

    if (input[cursor] === '%') {
      cursor += 1;
      while (cursor < input.length && input[cursor] !== '\n' && input[cursor] !== '\r') {
        cursor += 1;
      }
      continue;
    }

    break;
  }
  return cursor;
}

function isKeywordAt(input: string, start: number, keyword: string): boolean {
  return input.startsWith(keyword, start)
    && isPdfDelimiter(input[start - 1])
    && isPdfDelimiter(input[start + keyword.length]);
}

function skipLiteralString(input: string, start: number, budget: PdfExtractionBudget): number {
  let depth = 1;
  for (let cursor = start + 1; cursor < input.length; cursor += 1) {
    if ((cursor & 0xfff) === 0) {
      assertWithinProcessingTime(budget);
    }

    const char = input[cursor];
    if (char === '\\') {
      cursor += 1;
      if (input[cursor] === '\r' && input[cursor + 1] === '\n') {
        cursor += 1;
      }
      continue;
    }
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return cursor + 1;
      }
    }
  }

  throw createPdfExtractionError('unsupported_structure', 'PDF contains an unterminated literal string.');
}

function findDictionaryEnd(input: string, start: number, budget: PdfExtractionBudget): number {
  if (!input.startsWith('<<', start)) {
    throw createPdfExtractionError('unsupported_structure', 'PDF object dictionary is malformed.');
  }

  let depth = 0;
  for (let cursor = start; cursor < input.length; cursor += 1) {
    if ((cursor & 0xfff) === 0) {
      assertWithinProcessingTime(budget);
    }

    if (input[cursor] === '%') {
      cursor = skipPdfWhitespaceAndComments(input, cursor) - 1;
      continue;
    }
    if (input[cursor] === '(') {
      cursor = skipLiteralString(input, cursor, budget) - 1;
      continue;
    }
    if (input.startsWith('<<', cursor)) {
      depth += 1;
      cursor += 1;
      continue;
    }
    if (input.startsWith('>>', cursor)) {
      depth -= 1;
      cursor += 1;
      if (depth === 0) {
        return cursor + 1;
      }
      continue;
    }
    if (input[cursor] === '<') {
      const hexEnd = input.indexOf('>', cursor + 1);
      if (hexEnd < 0) {
        throw createPdfExtractionError('unsupported_structure', 'PDF contains an unterminated hex string.');
      }
      cursor = hexEnd;
    }
  }

  throw createPdfExtractionError('unsupported_structure', 'PDF contains an unterminated object dictionary.');
}

function readPdfNameToken(input: string, start: number): { next: number; value: string } {
  if (input[start] !== '/') {
    throw createPdfExtractionError('unsupported_structure', 'PDF dictionary name is malformed.');
  }

  let next = start + 1;
  while (next < input.length && !isPdfDelimiter(input[next])) {
    next += 1;
  }

  const value = input.slice(start + 1, next).replace(/#([0-9A-Fa-f]{2})/gu, (_match, hex: string) => (
    String.fromCharCode(Number.parseInt(hex, 16))
  ));
  return { next, value };
}

function readIndirectReferenceAt(
  input: string,
  start: number,
): { next: number; reference: PdfObjectReference } | undefined {
  const firstStart = skipPdfWhitespaceAndComments(input, start);
  const objectNumberMatch = /^(\d+)\b/u.exec(input.slice(firstStart));
  if (!objectNumberMatch) {
    return undefined;
  }

  const generationStart = skipPdfWhitespaceAndComments(
    input,
    firstStart + objectNumberMatch[0].length,
  );
  const generationNumberMatch = /^(\d+)\b/u.exec(input.slice(generationStart));
  if (!generationNumberMatch) {
    return undefined;
  }

  const referenceMarkerStart = skipPdfWhitespaceAndComments(
    input,
    generationStart + generationNumberMatch[0].length,
  );
  if (!isKeywordAt(input, referenceMarkerStart, 'R')) {
    return undefined;
  }

  const objectNumber = Number.parseInt(objectNumberMatch[1] ?? '', 10);
  const generationNumber = Number.parseInt(generationNumberMatch[1] ?? '', 10);
  if (!Number.isSafeInteger(objectNumber) || !Number.isSafeInteger(generationNumber)) {
    throw createPdfExtractionError('unsupported_structure', 'PDF indirect object reference is invalid.');
  }

  return {
    next: referenceMarkerStart + 1,
    reference: {
      objectNumber,
      generationNumber,
      key: `${objectNumber} ${generationNumber}`,
    },
  };
}

function readPdfObjectEnd(
  input: string,
  start: number,
  budget: PdfExtractionBudget,
  arrayDepth = 0,
): number {
  const cursor = skipPdfWhitespaceAndComments(input, start);
  const char = input[cursor];
  if (char === undefined) {
    throw createPdfExtractionError('unsupported_structure', 'PDF dictionary value is missing.');
  }
  if (char === '(') {
    return skipLiteralString(input, cursor, budget);
  }
  if (input.startsWith('<<', cursor)) {
    return findDictionaryEnd(input, cursor, budget);
  }
  if (char === '<') {
    const end = input.indexOf('>', cursor + 1);
    if (end < 0) {
      throw createPdfExtractionError('unsupported_structure', 'PDF contains an unterminated hex string.');
    }
    return end + 1;
  }
  if (char === '[') {
    if (arrayDepth >= MAX_PDF_ARRAY_DEPTH) {
      throw createPdfExtractionError('resource_limit', 'PDF dictionary array nesting exceeds local limits.');
    }

    let next = cursor + 1;
    while (next < input.length) {
      assertWithinProcessingTime(budget);
      next = skipPdfWhitespaceAndComments(input, next);
      if (input[next] === ']') {
        return next + 1;
      }
      next = readPdfObjectEnd(input, next, budget, arrayDepth + 1);
    }
    throw createPdfExtractionError('unsupported_structure', 'PDF contains an unterminated dictionary array.');
  }
  if (char === '/') {
    return readPdfNameToken(input, cursor).next;
  }

  const reference = readIndirectReferenceAt(input, cursor);
  if (reference) {
    return reference.next;
  }

  if (isPdfDelimiter(char)) {
    throw createPdfExtractionError('unsupported_structure', 'PDF dictionary value is malformed.');
  }
  let next = cursor + 1;
  while (next < input.length && !isPdfDelimiter(input[next])) {
    next += 1;
  }
  return next;
}

function findDictionaryEntry(
  dictionary: string,
  key: string,
  budget: PdfExtractionBudget,
): PdfDictionaryEntryRange | undefined {
  if (!dictionary.startsWith('<<')) {
    throw createPdfExtractionError('unsupported_structure', 'PDF dictionary is malformed.');
  }

  let cursor = 2;
  while (cursor < dictionary.length) {
    assertWithinProcessingTime(budget);
    cursor = skipPdfWhitespaceAndComments(dictionary, cursor);
    if (dictionary.startsWith('>>', cursor)) {
      return undefined;
    }
    if (dictionary[cursor] !== '/') {
      throw createPdfExtractionError('unsupported_structure', 'PDF dictionary entry is malformed.');
    }

    const name = readPdfNameToken(dictionary, cursor);
    const valueStart = skipPdfWhitespaceAndComments(dictionary, name.next);
    const valueEnd = readPdfObjectEnd(dictionary, valueStart, budget);
    if (name.value === key) {
      return { valueStart, valueEnd };
    }
    cursor = valueEnd;
  }

  throw createPdfExtractionError('unsupported_structure', 'PDF dictionary is unterminated.');
}

function readDictionaryNameValue(
  dictionary: string,
  key: string,
  budget: PdfExtractionBudget,
): string | undefined {
  const entry = findDictionaryEntry(dictionary, key, budget);
  if (!entry) {
    return undefined;
  }
  if (dictionary[entry.valueStart] !== '/') {
    throw createPdfExtractionError('unsupported_structure', `PDF /${key} entry is not a name.`);
  }
  const name = readPdfNameToken(dictionary, entry.valueStart);
  if (name.next !== entry.valueEnd) {
    throw createPdfExtractionError('unsupported_structure', `PDF /${key} name entry is malformed.`);
  }
  return name.value;
}

function readDictionaryReference(
  dictionary: string,
  key: string,
  budget: PdfExtractionBudget,
): PdfObjectReference | undefined {
  const entry = findDictionaryEntry(dictionary, key, budget);
  if (!entry) {
    return undefined;
  }
  const reference = readIndirectReferenceAt(dictionary, entry.valueStart);
  if (!reference || reference.next !== entry.valueEnd) {
    throw createPdfExtractionError('unsupported_structure', `PDF /${key} entry is not an indirect reference.`);
  }
  return reference.reference;
}

function readDictionaryNonNegativeInteger(
  dictionary: string,
  key: string,
  budget: PdfExtractionBudget,
): number | undefined {
  const entry = findDictionaryEntry(dictionary, key, budget);
  if (!entry) {
    return undefined;
  }
  const rawValue = dictionary.slice(entry.valueStart, entry.valueEnd);
  if (!/^\d+$/u.test(rawValue)) {
    throw createPdfExtractionError('unsupported_structure', `PDF /${key} entry is not an integer.`);
  }
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isSafeInteger(value)) {
    throw createPdfExtractionError('unsupported_structure', `PDF /${key} integer is invalid.`);
  }
  return value;
}

function readReferenceArray(
  dictionary: string,
  entry: PdfDictionaryEntryRange,
  key: string,
  budget: PdfExtractionBudget,
): PdfObjectReference[] {
  if (dictionary[entry.valueStart] !== '[') {
    throw createPdfExtractionError('unsupported_structure', `PDF /${key} entry is not a reference array.`);
  }

  const references: PdfObjectReference[] = [];
  let cursor = entry.valueStart + 1;
  while (cursor < entry.valueEnd) {
    assertWithinProcessingTime(budget);
    cursor = skipPdfWhitespaceAndComments(dictionary, cursor);
    if (dictionary[cursor] === ']') {
      if (cursor + 1 !== entry.valueEnd) {
        throw createPdfExtractionError('unsupported_structure', `PDF /${key} array is malformed.`);
      }
      return references;
    }

    const reference = readIndirectReferenceAt(dictionary, cursor);
    if (!reference) {
      throw createPdfExtractionError('unsupported_structure', `PDF /${key} array contains a direct object.`);
    }
    references.push(reference.reference);
    if (references.length > MAX_PDF_PAGE_CONTENT_REFERENCES) {
      throw createPdfExtractionError('resource_limit', `PDF /${key} array exceeds local limits.`);
    }
    cursor = reference.next;
  }

  throw createPdfExtractionError('unsupported_structure', `PDF /${key} array is unterminated.`);
}

function findKeyword(input: string, keyword: string, start: number): number {
  let cursor = input.indexOf(keyword, start);
  while (cursor >= 0) {
    if (isKeywordAt(input, cursor, keyword)) {
      return cursor;
    }
    cursor = input.indexOf(keyword, cursor + keyword.length);
  }
  return -1;
}

function readLine(input: string, start: number): { line: string; next: number } {
  let end = start;
  while (end < input.length && input[end] !== '\n' && input[end] !== '\r') {
    end += 1;
  }

  let next = end;
  if (input[next] === '\r') {
    next += 1;
    if (input[next] === '\n') {
      next += 1;
    }
  } else if (input[next] === '\n') {
    next += 1;
  }

  return { line: input.slice(start, end).trim(), next };
}

function findLastStartXrefOffset(pdfText: string): number | undefined {
  const pattern = /startxref\s+(\d+)/gu;
  let offset: number | undefined;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(pdfText)) !== null) {
    const candidate = Number.parseInt(match[1] ?? '', 10);
    if (Number.isSafeInteger(candidate) && candidate >= 0) {
      offset = candidate;
    }
  }
  return offset;
}

function parseClassicXrefOffsets(
  pdfText: string,
  budget: PdfExtractionBudget,
): Map<string, number> {
  const offsets = new Map<string, number>();
  let xrefOffset = findLastStartXrefOffset(pdfText);
  if (xrefOffset === undefined) {
    return offsets;
  }

  const visited = new Set<number>();
  for (let depth = 0; xrefOffset !== undefined; depth += 1) {
    assertWithinProcessingTime(budget);
    if (depth >= MAX_PDF_XREF_CHAIN_DEPTH || visited.has(xrefOffset)) {
      throw createPdfExtractionError('unsupported_structure', 'PDF cross-reference chain is invalid or too deep.');
    }
    visited.add(xrefOffset);

    if (!isKeywordAt(pdfText, xrefOffset, 'xref')) {
      throw createPdfExtractionError('unsupported_structure', 'PDF cross-reference streams are not supported.');
    }

    let cursor = skipPdfWhitespaceAndComments(pdfText, xrefOffset + 'xref'.length);
    let parsedEntries = 0;
    while (!isKeywordAt(pdfText, cursor, 'trailer')) {
      const section = readLine(pdfText, cursor);
      const sectionMatch = /^(\d+)\s+(\d+)$/u.exec(section.line);
      if (!sectionMatch) {
        throw createPdfExtractionError('unsupported_structure', 'PDF cross-reference section is malformed.');
      }
      cursor = section.next;

      const firstObjectNumber = Number.parseInt(sectionMatch[1] ?? '', 10);
      const entryCount = Number.parseInt(sectionMatch[2] ?? '', 10);
      if (!Number.isSafeInteger(firstObjectNumber)
        || !Number.isSafeInteger(entryCount)
        || entryCount < 0
        || parsedEntries + entryCount > MAX_PDF_XREF_SECTION_ENTRIES) {
        throw createPdfExtractionError('resource_limit', 'PDF cross-reference section exceeds local limits.');
      }

      for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
        const entry = readLine(pdfText, cursor);
        const entryMatch = /^(\d{10})\s+(\d{5})\s+([fn])\b/u.exec(entry.line);
        if (!entryMatch) {
          throw createPdfExtractionError('unsupported_structure', 'PDF cross-reference entry is malformed.');
        }
        cursor = entry.next;
        parsedEntries += 1;

        if (entryMatch[3] === 'n') {
          const objectNumber = firstObjectNumber + entryIndex;
          const generationNumber = Number.parseInt(entryMatch[2] ?? '', 10);
          const objectOffset = Number.parseInt(entryMatch[1] ?? '', 10);
          const key = `${objectNumber} ${generationNumber}`;
          if (!offsets.has(key)) {
            offsets.set(key, objectOffset);
          }
        }
      }

      cursor = skipPdfWhitespaceAndComments(pdfText, cursor);
    }

    cursor = skipPdfWhitespaceAndComments(pdfText, cursor + 'trailer'.length);
    if (!pdfText.startsWith('<<', cursor)) {
      throw createPdfExtractionError('unsupported_structure', 'PDF trailer dictionary is malformed.');
    }
    const dictionaryEnd = findDictionaryEnd(pdfText, cursor, budget);
    const trailerDictionary = pdfText.slice(cursor, dictionaryEnd);
    xrefOffset = readDictionaryNonNegativeInteger(trailerDictionary, 'Prev', budget);
  }

  return offsets;
}

function resolveIndirectInteger(
  pdfText: string,
  objectNumber: number,
  generationNumber: number,
  xrefOffsets: Map<string, number>,
): number {
  const offset = xrefOffsets.get(`${objectNumber} ${generationNumber}`);
  if (offset === undefined) {
    throw createPdfExtractionError(
      'unsupported_structure',
      'PDF uses an indirect stream length without a usable cross-reference entry.',
    );
  }

  const headerMatch = /^(\d+)\s+(\d+)\s+obj\b/u.exec(pdfText.slice(offset));
  if (!headerMatch
    || Number.parseInt(headerMatch[1] ?? '', 10) !== objectNumber
    || Number.parseInt(headerMatch[2] ?? '', 10) !== generationNumber) {
    throw createPdfExtractionError('unsupported_structure', 'PDF indirect length object is invalid.');
  }

  const valueStart = skipPdfWhitespaceAndComments(pdfText, offset + headerMatch[0].length);
  const valueMatch = /^(\d+)\b/u.exec(pdfText.slice(valueStart));
  if (!valueMatch) {
    throw createPdfExtractionError('unsupported_structure', 'PDF indirect stream length is not an integer.');
  }
  const value = Number.parseInt(valueMatch[1] ?? '', 10);
  const valueEnd = skipPdfWhitespaceAndComments(pdfText, valueStart + valueMatch[0].length);
  if (!isKeywordAt(pdfText, valueEnd, 'endobj') || !Number.isSafeInteger(value) || value < 0) {
    throw createPdfExtractionError('unsupported_structure', 'PDF indirect stream length object is malformed.');
  }
  return value;
}

function resolveStreamLength(
  dictionary: string,
  pdfText: string,
  xrefOffsets: Map<string, number>,
  budget: PdfExtractionBudget,
): number {
  const entry = findDictionaryEntry(dictionary, 'Length', budget);
  if (!entry) {
    throw createPdfExtractionError('unsupported_structure', 'PDF stream is missing a supported /Length entry.');
  }

  const rawValue = dictionary.slice(entry.valueStart, entry.valueEnd);
  const directLength = /^\d+$/u.test(rawValue)
    ? Number.parseInt(rawValue, 10)
    : undefined;
  const indirectLengthReference = directLength === undefined
    ? readIndirectReferenceAt(dictionary, entry.valueStart)
    : undefined;
  if (
    directLength === undefined
    && (!indirectLengthReference || indirectLengthReference.next !== entry.valueEnd)
  ) {
    throw createPdfExtractionError('unsupported_structure', 'PDF stream length is not a supported integer.');
  }

  const length = directLength ?? resolveIndirectInteger(
    pdfText,
    indirectLengthReference!.reference.objectNumber,
    indirectLengthReference!.reference.generationNumber,
    xrefOffsets,
  );
  if (!Number.isSafeInteger(length) || length < 0 || length > pdfText.length) {
    throw createPdfExtractionError('unsupported_structure', 'PDF stream length is outside the document bounds.');
  }
  return length;
}

function resolveStreamDataStart(pdfText: string, streamTokenEnd: number): number {
  let cursor = streamTokenEnd;
  while (pdfText[cursor] === ' ' || pdfText[cursor] === '\t') {
    cursor += 1;
  }
  if (pdfText.startsWith('\r\n', cursor)) {
    return cursor + 2;
  }
  if (pdfText[cursor] === '\n' || pdfText[cursor] === '\r') {
    return cursor + 1;
  }
  throw createPdfExtractionError('unsupported_structure', 'PDF stream keyword is not followed by a line ending.');
}

function resolveEndStreamTokenStart(pdfText: string, dataEnd: number): number {
  if (pdfText.startsWith('\r\n', dataEnd)) {
    return dataEnd + 2;
  }
  if (pdfText[dataEnd] === '\n' || pdfText[dataEnd] === '\r') {
    return dataEnd + 1;
  }
  return dataEnd;
}

function collectTrailerDictionaries(
  pdfText: string,
  objectRanges: PdfByteRange[],
  budget: PdfExtractionBudget,
): string[] {
  const trailers: string[] = [];
  let rangeIndex = 0;
  let cursor = 0;
  while ((cursor = findKeyword(pdfText, 'trailer', cursor)) >= 0) {
    assertWithinProcessingTime(budget);
    while (rangeIndex < objectRanges.length && objectRanges[rangeIndex].end <= cursor) {
      rangeIndex += 1;
    }
    if (rangeIndex < objectRanges.length
      && objectRanges[rangeIndex].start <= cursor
      && cursor < objectRanges[rangeIndex].end) {
      cursor = objectRanges[rangeIndex].end;
      continue;
    }

    const dictionaryStart = skipPdfWhitespaceAndComments(pdfText, cursor + 'trailer'.length);
    if (!pdfText.startsWith('<<', dictionaryStart)) {
      throw createPdfExtractionError('unsupported_structure', 'PDF trailer dictionary is malformed.');
    }
    const dictionaryEnd = findDictionaryEnd(pdfText, dictionaryStart, budget);
    trailers.push(pdfText.slice(dictionaryStart, dictionaryEnd));
    cursor = dictionaryEnd;
  }
  return trailers;
}

function collectPdfStructure(
  bytes: Uint8Array,
  pdfText: string,
  budget: PdfExtractionBudget,
): CollectedPdfStructure {
  const xrefOffsets = parseClassicXrefOffsets(pdfText, budget);
  const objects = new Map<string, PdfDictionaryObject>();
  const objectOrder: PdfDictionaryObject[] = [];
  const objectRanges: PdfByteRange[] = [];
  let objectCount = 0;
  let streamCount = 0;
  let searchStart = 0;

  PDF_OBJECT_HEADER_PATTERN.lastIndex = 0;
  while (searchStart < pdfText.length) {
    assertWithinProcessingTime(budget);
    PDF_OBJECT_HEADER_PATTERN.lastIndex = searchStart;
    const match = PDF_OBJECT_HEADER_PATTERN.exec(pdfText);
    if (!match) {
      break;
    }
    objectCount += 1;
    if (objectCount > MAX_PDF_OBJECT_COUNT) {
      throw createPdfExtractionError('resource_limit', 'PDF contains too many objects.');
    }

    const objectStart = match.index;
    const objectNumber = Number.parseInt(match[1] ?? '', 10);
    const generationNumber = Number.parseInt(match[2] ?? '', 10);
    if (!Number.isSafeInteger(objectNumber) || !Number.isSafeInteger(generationNumber)) {
      throw createPdfExtractionError('unsupported_structure', 'PDF object identifier is invalid.');
    }
    const objectKey = `${objectNumber} ${generationNumber}`;
    const contentStart = skipPdfWhitespaceAndComments(pdfText, PDF_OBJECT_HEADER_PATTERN.lastIndex);
    let objectEnd: number;
    let dictionaryObject: PdfDictionaryObject | undefined;

    if (pdfText.startsWith('<<', contentStart)) {
      const dictionaryEnd = findDictionaryEnd(pdfText, contentStart, budget);
      const dictionary = pdfText.slice(contentStart, dictionaryEnd);
      if (readDictionaryNameValue(dictionary, 'Type', budget) === 'XRef') {
        throw createPdfExtractionError('unsupported_structure', 'PDF cross-reference streams are not supported.');
      }

      const afterDictionary = skipPdfWhitespaceAndComments(pdfText, dictionaryEnd);
      if (isKeywordAt(pdfText, afterDictionary, 'stream')) {
        streamCount += 1;
        if (streamCount > MAX_PDF_STREAM_COUNT) {
          throw createPdfExtractionError('resource_limit', 'PDF contains too many streams.');
        }

        const dataStart = resolveStreamDataStart(pdfText, afterDictionary + 'stream'.length);
        const streamLength = resolveStreamLength(dictionary, pdfText, xrefOffsets, budget);
        const dataEnd = dataStart + streamLength;
        if (!Number.isSafeInteger(dataEnd) || dataEnd > bytes.length) {
          throw createPdfExtractionError('unsupported_structure', 'PDF stream extends past the document boundary.');
        }
        const endStreamStart = resolveEndStreamTokenStart(pdfText, dataEnd);
        if (!isKeywordAt(pdfText, endStreamStart, 'endstream')) {
          throw createPdfExtractionError('unsupported_structure', 'PDF stream length does not match its endstream boundary.');
        }
        const endObjectStart = skipPdfWhitespaceAndComments(
          pdfText,
          endStreamStart + 'endstream'.length,
        );
        if (!isKeywordAt(pdfText, endObjectStart, 'endobj')) {
          throw createPdfExtractionError('unsupported_structure', 'PDF stream object is missing endobj.');
        }
        objectEnd = endObjectStart + 'endobj'.length;
        const stream = {
          objectKey,
          dictionary,
          bytes: bytes.subarray(dataStart, dataEnd),
        };
        dictionaryObject = {
          objectNumber,
          generationNumber,
          key: objectKey,
          dictionary,
          stream,
        };
      } else {
        const endObjectStart = findKeyword(pdfText, 'endobj', dictionaryEnd);
        if (endObjectStart < 0) {
          throw createPdfExtractionError('unsupported_structure', 'PDF dictionary object is missing endobj.');
        }
        objectEnd = endObjectStart + 'endobj'.length;
        dictionaryObject = {
          objectNumber,
          generationNumber,
          key: objectKey,
          dictionary,
        };
      }
    } else {
      const endObjectStart = findKeyword(pdfText, 'endobj', contentStart);
      if (endObjectStart < 0) {
        throw createPdfExtractionError('unsupported_structure', 'PDF object is missing endobj.');
      }
      objectEnd = endObjectStart + 'endobj'.length;
    }

    objectRanges.push({ start: objectStart, end: objectEnd });
    if (dictionaryObject) {
      objects.set(objectKey, dictionaryObject);
      objectOrder.push(dictionaryObject);
    }
    searchStart = objectEnd;
  }

  const trailers = collectTrailerDictionaries(pdfText, objectRanges, budget);
  return {
    objects,
    objectOrder,
    trailers,
  };
}

function resolveCatalogObject(
  structure: CollectedPdfStructure,
  budget: PdfExtractionBudget,
): PdfDictionaryObject {
  for (let index = structure.trailers.length - 1; index >= 0; index -= 1) {
    const rootReference = readDictionaryReference(structure.trailers[index], 'Root', budget);
    if (!rootReference) {
      continue;
    }
    const rootObject = structure.objects.get(rootReference.key);
    if (!rootObject) {
      throw createPdfExtractionError('unsupported_structure', 'PDF trailer references a missing catalog object.');
    }
    if (readDictionaryNameValue(rootObject.dictionary, 'Type', budget) !== 'Catalog') {
      throw createPdfExtractionError('unsupported_structure', 'PDF trailer root is not a catalog object.');
    }
    return rootObject;
  }

  for (let index = structure.objectOrder.length - 1; index >= 0; index -= 1) {
    const candidate = structure.objectOrder[index];
    if (structure.objects.get(candidate.key) !== candidate) {
      continue;
    }
    if (readDictionaryNameValue(candidate.dictionary, 'Type', budget) === 'Catalog') {
      return candidate;
    }
  }

  throw createPdfExtractionError('unsupported_structure', 'PDF catalog could not be resolved.');
}

function readPageContentReferences(
  dictionary: string,
  budget: PdfExtractionBudget,
): PdfObjectReference[] {
  const entry = findDictionaryEntry(dictionary, 'Contents', budget);
  if (!entry) {
    return [];
  }
  if (dictionary[entry.valueStart] === '[') {
    return readReferenceArray(dictionary, entry, 'Contents', budget);
  }

  const reference = readIndirectReferenceAt(dictionary, entry.valueStart);
  if (!reference || reference.next !== entry.valueEnd) {
    throw createPdfExtractionError(
      'unsupported_structure',
      'PDF /Contents entry is not an indirect stream reference.',
    );
  }
  return [reference.reference];
}

function resolvePageContentStructure(
  structure: CollectedPdfStructure,
  budget: PdfExtractionBudget,
): PdfPageContentStructure {
  const catalog = resolveCatalogObject(structure, budget);
  const pagesReference = readDictionaryReference(catalog.dictionary, 'Pages', budget);
  if (!pagesReference) {
    throw createPdfExtractionError('unsupported_structure', 'PDF catalog is missing its page tree reference.');
  }

  const pages: PdfStreamCandidate[][] = [];
  const visited = new Set<string>();
  const pending: { depth: number; reference: PdfObjectReference }[] = [{
    depth: 0,
    reference: pagesReference,
  }];
  let contentReferenceCount = 0;

  while (pending.length > 0) {
    assertWithinProcessingTime(budget);
    const current = pending.pop();
    if (!current) {
      break;
    }
    if (current.depth > MAX_PDF_PAGE_TREE_DEPTH || visited.has(current.reference.key)) {
      throw createPdfExtractionError('unsupported_structure', 'PDF page tree is cyclic or too deep.');
    }
    visited.add(current.reference.key);

    const object = structure.objects.get(current.reference.key);
    if (!object) {
      throw createPdfExtractionError('unsupported_structure', 'PDF page tree references a missing object.');
    }
    const type = readDictionaryNameValue(object.dictionary, 'Type', budget);
    if (type === 'Pages') {
      const kidsEntry = findDictionaryEntry(object.dictionary, 'Kids', budget);
      if (!kidsEntry) {
        throw createPdfExtractionError('unsupported_structure', 'PDF page tree node is missing /Kids.');
      }
      const kids = readReferenceArray(object.dictionary, kidsEntry, 'Kids', budget);
      for (let index = kids.length - 1; index >= 0; index -= 1) {
        pending.push({ depth: current.depth + 1, reference: kids[index] });
      }
      continue;
    }
    if (type !== 'Page') {
      throw createPdfExtractionError('unsupported_structure', 'PDF page tree contains a non-page object.');
    }

    const contentReferences = readPageContentReferences(object.dictionary, budget);
    contentReferenceCount += contentReferences.length;
    if (contentReferenceCount > MAX_PDF_PAGE_CONTENT_REFERENCES) {
      throw createPdfExtractionError('resource_limit', 'PDF page content references exceed local limits.');
    }

    const pageStreams = contentReferences.map((reference) => {
      const contentObject = structure.objects.get(reference.key);
      if (!contentObject?.stream) {
        throw createPdfExtractionError(
          'unsupported_structure',
          'PDF page references a missing or non-stream content object.',
        );
      }
      return contentObject.stream;
    });
    pages.push(pageStreams);
  }

  return { pageCount: pages.length, pages };
}

function decodePdfHexString(value: string): string {
  const normalized = value.replace(/\s+/gu, '');
  const evenHex = normalized.length % 2 === 0 ? normalized : `${normalized}0`;
  const bytes = new Uint8Array(evenHex.length / 2);
  for (let index = 0; index < evenHex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(evenHex.slice(index, index + 2), 16);
  }

  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let text = '';
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      text += String.fromCharCode((bytes[index] << 8) | bytes[index + 1]);
    }
    return text;
  }

  return bytesToBinaryString(bytes);
}

function decodePdfLiteralString(value: string): string {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== '\\') {
      output += char;
      continue;
    }

    index += 1;
    const escaped = value[index];
    if (escaped === undefined) {
      break;
    }

    switch (escaped) {
      case 'n':
        output += '\n';
        break;
      case 'r':
        output += '\r';
        break;
      case 't':
        output += '\t';
        break;
      case 'b':
        output += '\b';
        break;
      case 'f':
        output += '\f';
        break;
      case '(':
      case ')':
      case '\\':
        output += escaped;
        break;
      case '\n':
        break;
      case '\r':
        if (value[index + 1] === '\n') {
          index += 1;
        }
        break;
      default: {
        if (/[0-7]/u.test(escaped)) {
          let octal = escaped;
          for (let count = 0; count < 2 && /[0-7]/u.test(value[index + 1] ?? ''); count += 1) {
            index += 1;
            octal += value[index];
          }
          output += String.fromCharCode(Number.parseInt(octal, 8));
        } else {
          output += escaped;
        }
      }
    }
  }

  return output;
}

function consumeContentTokenBudget(budget: PdfExtractionBudget): void {
  budget.parsedTokens += 1;
  if (budget.parsedTokens > MAX_PDF_CONTENT_TOKENS) {
    throw createPdfExtractionError('resource_limit', 'PDF content contains too many tokens.');
  }
  if ((budget.parsedTokens & 0xff) === 0) {
    assertWithinProcessingTime(budget);
  }
}

function readContentToken(
  input: string,
  start: number,
  budget: PdfExtractionBudget,
  arrayDepth = 0,
): { next: number; token?: PdfContentToken } {
  const cursor = skipPdfWhitespaceAndComments(input, start);
  if (cursor >= input.length) {
    return { next: cursor };
  }
  consumeContentTokenBudget(budget);

  const char = input[cursor];
  if (char === '(') {
    const end = skipLiteralString(input, cursor, budget);
    return {
      next: end,
      token: {
        type: 'string',
        value: decodePdfLiteralString(input.slice(cursor + 1, end - 1)),
      },
    };
  }

  if (char === '<' && input[cursor + 1] !== '<') {
    const end = input.indexOf('>', cursor + 1);
    if (end < 0) {
      throw createPdfExtractionError('unsupported_structure', 'PDF content contains an unterminated hex string.');
    }
    const hex = input.slice(cursor + 1, end);
    if (!/^[0-9A-Fa-f\s]*$/u.test(hex)) {
      throw createPdfExtractionError('unsupported_structure', 'PDF content contains an invalid hex string.');
    }
    return {
      next: end + 1,
      token: { type: 'string', value: decodePdfHexString(hex) },
    };
  }

  if (char === '[') {
    if (arrayDepth >= MAX_PDF_ARRAY_DEPTH) {
      throw createPdfExtractionError('resource_limit', 'PDF content array nesting exceeds local limits.');
    }
    const entries: PdfContentToken[] = [];
    let next = cursor + 1;
    while (next < input.length) {
      next = skipPdfWhitespaceAndComments(input, next);
      if (input[next] === ']') {
        return { next: next + 1, token: { type: 'array', value: entries } };
      }
      const result = readContentToken(input, next, budget, arrayDepth + 1);
      if (!result.token || result.next <= next) {
        throw createPdfExtractionError('unsupported_structure', 'PDF content array is malformed.');
      }
      entries.push(result.token);
      next = result.next;
    }
    throw createPdfExtractionError('unsupported_structure', 'PDF content contains an unterminated array.');
  }

  if (char === ']' || char === '>' || (char === '<' && input[cursor + 1] === '<')) {
    return { next: cursor + (char === '<' ? 2 : 1), token: { type: 'word', value: char } };
  }

  if (char === '\'' || char === '"') {
    return { next: cursor + 1, token: { type: 'word', value: char } };
  }

  if (char === '/') {
    let end = cursor + 1;
    while (end < input.length && !isPdfDelimiter(input[end])) {
      end += 1;
    }
    return { next: end, token: { type: 'name', value: input.slice(cursor, end) } };
  }

  const numberMatch = /^[+-]?(?:\d+\.?\d*|\.\d+)/u.exec(input.slice(cursor));
  if (numberMatch) {
    return {
      next: cursor + numberMatch[0].length,
      token: { type: 'number', value: Number.parseFloat(numberMatch[0]) },
    };
  }

  let end = cursor;
  while (end < input.length && !isPdfDelimiter(input[end]) && input[end] !== '\'' && input[end] !== '"') {
    end += 1;
  }
  if (end === cursor) {
    end += 1;
  }
  return { next: end, token: { type: 'word', value: input.slice(cursor, end) } };
}

function findLastOperand<T extends PdfContentToken['type']>(
  operands: PdfContentToken[],
  type: T,
): Extract<PdfContentToken, { type: T }> | undefined {
  for (let index = operands.length - 1; index >= 0; index -= 1) {
    if (operands[index].type === type) {
      return operands[index] as Extract<PdfContentToken, { type: T }>;
    }
  }
  return undefined;
}

function extractTextFromTextArray(entries: PdfContentToken[]): string {
  const fragments: string[] = [];
  let hasText = false;
  let previousTextEndsWithWhitespace = false;
  let pendingAdjustment = 0;

  for (const entry of entries) {
    if (entry.type === 'number') {
      if (!Number.isFinite(entry.value)) {
        throw createPdfExtractionError('unsupported_structure', 'PDF TJ array contains an invalid adjustment.');
      }
      pendingAdjustment += entry.value;
      continue;
    }
    if (entry.type !== 'string') {
      throw createPdfExtractionError('unsupported_structure', 'PDF TJ array contains an unsupported operand.');
    }
    if (entry.value.length === 0) {
      continue;
    }

    const startsWithWhitespace = /^\s/u.test(entry.value);
    if (
      hasText
      && pendingAdjustment <= PDF_TJ_WORD_BREAK_THRESHOLD
      && !previousTextEndsWithWhitespace
      && !startsWithWhitespace
    ) {
      fragments.push(' ');
    }
    fragments.push(entry.value);
    hasText = true;
    previousTextEndsWithWhitespace = /\s$/u.test(entry.value);
    pendingAdjustment = 0;
  }

  return fragments.join('');
}

function extractTextFromContentStream(content: string, budget: PdfExtractionBudget): string {
  const output: string[] = [];
  const operands: PdfContentToken[] = [];
  let cursor = 0;
  let insideTextObject = false;
  let hasShownText = false;
  let pendingSeparator: 'line' | 'space' | undefined;

  const rememberOperand = (token: PdfContentToken) => {
    operands.push(token);
    if (operands.length > MAX_PDF_OPERANDS) {
      operands.shift();
    }
  };
  const requestLineBreak = () => {
    if (hasShownText) {
      pendingSeparator = 'line';
    }
  };
  const appendShownText = (text: string) => {
    if (text.length === 0) {
      return;
    }
    if (hasShownText) {
      output.push(pendingSeparator === 'line' ? '\n' : ' ');
    }
    output.push(text);
    hasShownText = true;
    pendingSeparator = 'space';
  };

  while (cursor < content.length) {
    const result = readContentToken(content, cursor, budget);
    cursor = result.next;
    const token = result.token;
    if (!token) {
      break;
    }

    if (token.type !== 'word') {
      if (insideTextObject) {
        rememberOperand(token);
      }
      continue;
    }

    const operator = token.value;
    if (operator === 'BT') {
      if (insideTextObject) {
        throw createPdfExtractionError('unsupported_structure', 'PDF contains nested text objects.');
      }
      insideTextObject = true;
      requestLineBreak();
      operands.length = 0;
      continue;
    }
    if (operator === 'ET') {
      insideTextObject = false;
      requestLineBreak();
      operands.length = 0;
      continue;
    }
    if (!insideTextObject) {
      continue;
    }

    if (operator === 'Tj') {
      appendShownText(findLastOperand(operands, 'string')?.value ?? '');
    } else if (operator === 'TJ') {
      const array = findLastOperand(operands, 'array');
      const text = array ? extractTextFromTextArray(array.value) : '';
      appendShownText(text);
    } else if (operator === '\'' || operator === '"') {
      requestLineBreak();
      appendShownText(findLastOperand(operands, 'string')?.value ?? '');
    } else if (operator === 'T*' || operator === 'Td' || operator === 'TD') {
      requestLineBreak();
    }

    operands.length = 0;
  }

  if (insideTextObject) {
    throw createPdfExtractionError('unsupported_structure', 'PDF contains an unterminated text object.');
  }
  assertWithinProcessingTime(budget);
  return normalizeExtractedWhitespace(output.join(''));
}

function resolvePdfStreamFilterMode(
  dictionary: string,
  budget: PdfExtractionBudget,
): PdfStreamFilterMode {
  const entry = findDictionaryEntry(dictionary, 'Filter', budget);
  if (!entry) {
    return 'none';
  }

  if (dictionary[entry.valueStart] === '/') {
    const filter = readPdfNameToken(dictionary, entry.valueStart);
    if (filter.next !== entry.valueEnd) {
      return 'unsupported';
    }
    return filter.value === 'FlateDecode' ? 'flate' : 'unsupported';
  }
  if (dictionary[entry.valueStart] !== '[') {
    return 'unsupported';
  }

  const filters: string[] = [];
  let cursor = entry.valueStart + 1;
  while (cursor < entry.valueEnd) {
    assertWithinProcessingTime(budget);
    cursor = skipPdfWhitespaceAndComments(dictionary, cursor);
    if (dictionary[cursor] === ']') {
      if (cursor + 1 !== entry.valueEnd) {
        return 'unsupported';
      }
      if (filters.length === 0) {
        return 'none';
      }
      return filters.length === 1 && filters[0] === 'FlateDecode'
        ? 'flate'
        : 'unsupported';
    }
    if (dictionary[cursor] !== '/') {
      return 'unsupported';
    }
    const filter = readPdfNameToken(dictionary, cursor);
    filters.push(filter.value);
    cursor = filter.next;
  }

  return 'unsupported';
}

function inflateStream(candidate: PdfStreamCandidate, budget: PdfExtractionBudget): string {
  const textChunks: string[] = [];
  let streamDecodedBytes = 0;
  const inflater = new Inflate({ chunkSize: INFLATE_OUTPUT_CHUNK_BYTES });
  inflater.onData = (chunk) => {
    const bytes = typeof chunk === 'string'
      ? Uint8Array.from(chunk, (char: string) => char.charCodeAt(0) & 0xff)
      : chunk;
    reserveDecodedBytes(bytes.length, streamDecodedBytes, candidate.bytes.length, budget);
    streamDecodedBytes += bytes.length;
    assertWithinProcessingTime(budget);
    textChunks.push(bytesToBinaryString(bytes));
  };

  for (let offset = 0; offset < candidate.bytes.length; offset += INFLATE_INPUT_CHUNK_BYTES) {
    assertWithinProcessingTime(budget);
    const end = Math.min(candidate.bytes.length, offset + INFLATE_INPUT_CHUNK_BYTES);
    const isLast = end === candidate.bytes.length;
    const accepted = inflater.push(candidate.bytes.subarray(offset, end), isLast);
    if (!accepted || inflater.err) {
      throw new Error(inflater.msg || 'Unable to inflate PDF stream.');
    }
  }

  if (candidate.bytes.length === 0) {
    const accepted = inflater.push(new Uint8Array(), true);
    if (!accepted || inflater.err) {
      throw new Error(inflater.msg || 'Unable to inflate PDF stream.');
    }
  }
  return textChunks.join('');
}

function decodeStream(
  candidate: PdfStreamCandidate,
  budget: PdfExtractionBudget,
): { text?: string; unsupportedFilter: boolean } {
  if (readDictionaryNameValue(candidate.dictionary, 'Subtype', budget) === 'Image') {
    return { unsupportedFilter: false };
  }

  const filterMode = resolvePdfStreamFilterMode(candidate.dictionary, budget);
  if (filterMode === 'unsupported') {
    return { unsupportedFilter: true };
  }

  try {
    if (filterMode === 'flate') {
      return { text: inflateStream(candidate, budget), unsupportedFilter: false };
    }

    reserveDecodedBytes(candidate.bytes.length, 0, undefined, budget);
    assertWithinProcessingTime(budget);
    return {
      text: bytesToBinaryString(candidate.bytes),
      unsupportedFilter: false,
    };
  } catch (error) {
    if (error instanceof PdfTextExtractionError) {
      throw error;
    }
    return { unsupportedFilter: true };
  }
}

export function extractTextFromPdfBase64(base64: string): PdfTextExtractionResult {
  const normalizedBase64 = base64.trim();
  if (normalizedBase64.length > Math.ceil(MAX_PDF_INPUT_BYTES * 4 / 3) + 4) {
    throw createPdfExtractionError('resource_limit', 'PDF input exceeds the local file-size limit.');
  }

  const budget: PdfExtractionBudget = {
    deadlineMs: Date.now() + MAX_PDF_PROCESSING_MILLIS,
    decodedDocumentBytes: 0,
    parsedTokens: 0,
  };
  let bytes: Uint8Array;
  try {
    bytes = toByteArray(normalizedBase64);
  } catch {
    throw new PdfTextExtractionError('invalid_pdf', 'PDF attachment could not be decoded.');
  }
  if (bytes.length > MAX_PDF_INPUT_BYTES) {
    throw createPdfExtractionError('resource_limit', 'PDF input exceeds the local file-size limit.');
  }

  const pdfText = bytesToBinaryString(bytes);
  assertWithinProcessingTime(budget);
  if (!PDF_BINARY_HEADER_PATTERN.test(pdfText.slice(0, 32))) {
    throw new PdfTextExtractionError('invalid_pdf', 'Document is not a valid PDF file.');
  }

  const collectedStructure = collectPdfStructure(bytes, pdfText, budget);
  if (collectedStructure.trailers.some((trailer) => (
    findDictionaryEntry(trailer, 'Encrypt', budget) !== undefined
  ))) {
    throw new PdfTextExtractionError('encrypted', 'Encrypted PDF documents cannot be processed locally.');
  }
  const structure = resolvePageContentStructure(collectedStructure, budget);

  let unsupportedFilterCount = 0;
  let referencedStreamCount = 0;
  let processedPageContentBytes = 0;
  const decodedStreamCache = new Map<
    string,
    { text?: string; unsupportedFilter: boolean }
  >();
  const extractedPages: string[] = [];
  for (const page of structure.pages) {
    const decodedPageStreams: string[] = [];
    for (const stream of page) {
      referencedStreamCount += 1;
      let decoded = decodedStreamCache.get(stream.objectKey);
      if (!decoded) {
        decoded = decodeStream(stream, budget);
        decodedStreamCache.set(stream.objectKey, decoded);
      }
      if (decoded.unsupportedFilter) {
        unsupportedFilterCount += 1;
        continue;
      }
      if (decoded.text) {
        processedPageContentBytes += decoded.text.length;
        if (processedPageContentBytes > MAX_PDF_DECODED_DOCUMENT_BYTES) {
          throw createPdfExtractionError(
            'resource_limit',
            'PDF page content exceeds the local decoded-size limit.',
          );
        }
        decodedPageStreams.push(decoded.text);
      }
    }

    const pageText = decodedPageStreams.length > 0
      ? extractTextFromContentStream(decodedPageStreams.join('\n'), budget)
      : '';
    if (pageText.trim().length > 0) {
      extractedPages.push(pageText);
    }
  }
  assertWithinProcessingTime(budget);
  const text = normalizeExtractedWhitespace(extractedPages.join('\n\n'));

  if (text.length > 0) {
    return {
      text,
      isScanned: false,
      pageCount: structure.pageCount,
    };
  }

  if (referencedStreamCount > 0 && unsupportedFilterCount === referencedStreamCount) {
    throw new PdfTextExtractionError('unsupported_filter', 'PDF uses unsupported compression or content filters.');
  }

  throw new PdfTextExtractionError('no_extractable_text', 'PDF has no extractable text.');
}
