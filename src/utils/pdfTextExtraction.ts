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

type ClassicXrefParseResult = {
  offsets: Map<string, number>;
  trailers: string[];
  hasStartXref: boolean;
};

type PdfPageContent = {
  streams: PdfStreamCandidate[];
  formXObjectNames: Set<string>;
};

type PdfPageContentStructure = {
  pageCount: number;
  pages: PdfPageContent[];
};

type PdfDictionaryEntryRange = {
  valueStart: number;
  valueEnd: number;
};

type PdfStreamFilterMode = 'flate' | 'none' | 'unsupported';

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
const PDF_WHITESPACE_PATTERN = /[\u0000\t\n\f\r ]/u;
const PDF_DELIMITER_PATTERN = /[\u0000\t\n\f\r ()<>\[\]{}/%]/u;
// Sticky patterns match in place at `lastIndex`, so integer tokens and object
// headers can be validated without copying the remainder of the document for
// every object the cross-reference table lists.
const PDF_INTEGER_TOKEN_PATTERN = /(\d+)\b/yu;
const PDF_OBJECT_HEADER_PATTERN = /(\d+)\s+(\d+)\s+obj\b/yu;
const PDF_CONTENT_NUMBER_PATTERN = /[+-]?(?:\d+\.?\d*|\.\d+)/yu;

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
const MAX_PDF_INLINE_IMAGE_DICTIONARY_ENTRIES = 64;
const MAX_PDF_INLINE_IMAGE_DECODED_BYTES = 16 * 1024 * 1024;
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

function matchIntegerTokenAt(input: string, start: number): { value: string; next: number } | undefined {
  PDF_INTEGER_TOKEN_PATTERN.lastIndex = start;
  const match = PDF_INTEGER_TOKEN_PATTERN.exec(input);
  if (!match) {
    return undefined;
  }
  return { value: match[0], next: start + match[0].length };
}

function matchObjectHeaderAt(
  input: string,
  start: number,
): { objectNumber: number; generationNumber: number; contentStart: number } | undefined {
  PDF_OBJECT_HEADER_PATTERN.lastIndex = start;
  const match = PDF_OBJECT_HEADER_PATTERN.exec(input);
  if (!match) {
    return undefined;
  }
  return {
    objectNumber: Number.parseInt(match[1] ?? '', 10),
    generationNumber: Number.parseInt(match[2] ?? '', 10),
    contentStart: start + match[0].length,
  };
}

function readIndirectReferenceAt(
  input: string,
  start: number,
): { next: number; reference: PdfObjectReference } | undefined {
  const firstStart = skipPdfWhitespaceAndComments(input, start);
  const objectNumberMatch = matchIntegerTokenAt(input, firstStart);
  if (!objectNumberMatch) {
    return undefined;
  }

  const generationStart = skipPdfWhitespaceAndComments(input, objectNumberMatch.next);
  const generationNumberMatch = matchIntegerTokenAt(input, generationStart);
  if (!generationNumberMatch) {
    return undefined;
  }

  const referenceMarkerStart = skipPdfWhitespaceAndComments(input, generationNumberMatch.next);
  if (!isKeywordAt(input, referenceMarkerStart, 'R')) {
    return undefined;
  }

  const objectNumber = Number.parseInt(objectNumberMatch.value, 10);
  const generationNumber = Number.parseInt(generationNumberMatch.value, 10);
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

function readIndirectObjectHeaderAt(
  input: string,
  start: number,
): {
  start: number;
  contentStart: number;
  objectNumber: number;
  generationNumber: number;
  key: string;
} | undefined {
  const objectNumberMatch = matchIntegerTokenAt(input, start);
  if (!objectNumberMatch) {
    return undefined;
  }

  const generationStart = skipPdfWhitespaceAndComments(input, objectNumberMatch.next);
  if (generationStart === objectNumberMatch.next) {
    return undefined;
  }
  const generationNumberMatch = matchIntegerTokenAt(input, generationStart);
  if (!generationNumberMatch) {
    return undefined;
  }

  const keywordStart = skipPdfWhitespaceAndComments(input, generationNumberMatch.next);
  if (keywordStart === generationNumberMatch.next) {
    return undefined;
  }
  if (!isKeywordAt(input, keywordStart, 'obj')) {
    return undefined;
  }

  const objectNumber = Number.parseInt(objectNumberMatch.value, 10);
  const generationNumber = Number.parseInt(generationNumberMatch.value, 10);
  if (!Number.isSafeInteger(objectNumber) || !Number.isSafeInteger(generationNumber)) {
    throw createPdfExtractionError('unsupported_structure', 'PDF object identifier is invalid.');
  }

  return {
    start,
    contentStart: skipPdfWhitespaceAndComments(input, keywordStart + 'obj'.length),
    objectNumber,
    generationNumber,
    key: `${objectNumber} ${generationNumber}`,
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

function findTopLevelEndObjectStart(
  input: string,
  start: number,
  budget: PdfExtractionBudget,
): number {
  let cursor = start;
  while (cursor < input.length) {
    assertWithinProcessingTime(budget);
    cursor = skipPdfWhitespaceAndComments(input, cursor);
    if (cursor >= input.length) {
      return -1;
    }
    if (isKeywordAt(input, cursor, 'endobj')) {
      return cursor;
    }

    const next = readPdfObjectEnd(input, cursor, budget);
    if (next <= cursor) {
      throw createPdfExtractionError('unsupported_structure', 'PDF object is malformed.');
    }
    cursor = next;
  }

  return -1;
}

function findNextTopLevelStructure(
  input: string,
  start: number,
  budget: PdfExtractionBudget,
):
  | { type: 'object'; header: NonNullable<ReturnType<typeof readIndirectObjectHeaderAt>> }
  | { type: 'trailer'; start: number; next: number; dictionary: string }
  | undefined {
  let cursor = start;
  while (cursor < input.length) {
    assertWithinProcessingTime(budget);
    cursor = skipPdfWhitespaceAndComments(input, cursor);
    if (cursor >= input.length) {
      return undefined;
    }

    const header = readIndirectObjectHeaderAt(input, cursor);
    if (header) {
      return { type: 'object', header };
    }

    if (isKeywordAt(input, cursor, 'trailer')) {
      const dictionaryStart = skipPdfWhitespaceAndComments(input, cursor + 'trailer'.length);
      if (!input.startsWith('<<', dictionaryStart)) {
        throw createPdfExtractionError('unsupported_structure', 'PDF trailer dictionary is malformed.');
      }
      const dictionaryEnd = findDictionaryEnd(input, dictionaryStart, budget);
      return {
        type: 'trailer',
        start: cursor,
        next: dictionaryEnd,
        dictionary: input.slice(dictionaryStart, dictionaryEnd),
      };
    }

    const next = readPdfObjectEnd(input, cursor, budget);
    if (next <= cursor) {
      throw createPdfExtractionError('unsupported_structure', 'PDF top-level structure is malformed.');
    }
    cursor = next;
  }

  return undefined;
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

// Parses backward from `endLimit` so `startxref` text embedded in comments, strings,
// dictionaries, or stream bytes can never be selected. The strict call passes the
// physical document end; the rescue path passes the position right after a `%%EOF`
// marker so bytes appended after the marker cannot influence the parse.
function findLastStartXrefOffset(pdfText: string, endLimit: number): number | undefined {
  const startxrefKeyword = 'startxref';
  const eofMarker = '%%EOF';

  let end = Math.min(endLimit, pdfText.length);
  while (end > 0 && isPdfWhitespace(pdfText[end - 1])) {
    end -= 1;
  }

  if (end < eofMarker.length || !pdfText.endsWith(eofMarker, end)) {
    return undefined;
  }
  end -= eofMarker.length;

  const beforeEofMarker = end;
  while (end > 0 && isPdfWhitespace(pdfText[end - 1])) {
    end -= 1;
  }
  if (end === beforeEofMarker) {
    return undefined;
  }

  const digitsEnd = end;
  while (end > 0 && pdfText[end - 1] >= '0' && pdfText[end - 1] <= '9') {
    end -= 1;
  }
  const digitsStart = end;
  // Cap the digit span so parseInt cannot round beyond Number.MAX_SAFE_INTEGER.
  if (digitsStart === digitsEnd || digitsEnd - digitsStart > 15) {
    return undefined;
  }

  const beforeOffset = end;
  while (end > 0 && isPdfWhitespace(pdfText[end - 1])) {
    end -= 1;
  }
  if (end === beforeOffset) {
    return undefined;
  }

  if (end < startxrefKeyword.length || !pdfText.endsWith(startxrefKeyword, end)) {
    return undefined;
  }
  end -= startxrefKeyword.length;
  if (end > 0 && !isPdfWhitespace(pdfText[end - 1])) {
    return undefined;
  }

  const offset = Number.parseInt(pdfText.slice(digitsStart, digitsEnd), 10);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return undefined;
  }
  return offset;
}

const MAX_PDF_STARTXREF_TAIL_SEARCH_BYTES = 1024;
const PDF_EOF_MARKER = '%%EOF';

// Returns every xref section offset reachable from `startOffset` through the
// /Prev chain, or undefined when the chain is malformed and therefore cannot
// prove which revision is the newest one.
function collectXrefChainOffsets(
  pdfText: string,
  startOffset: number,
  budget: PdfExtractionBudget,
): Set<number> | undefined {
  const chain = new Set<number>();
  let xrefOffset: number | undefined = startOffset;
  let parsedEntries = 0;

  while (xrefOffset !== undefined) {
    assertWithinProcessingTime(budget);
    if (chain.size >= MAX_PDF_XREF_CHAIN_DEPTH || chain.has(xrefOffset)) {
      return undefined;
    }
    if (!isKeywordAt(pdfText, xrefOffset, 'xref')) {
      return undefined;
    }
    chain.add(xrefOffset);

    let cursor = skipPdfWhitespaceAndComments(pdfText, xrefOffset + 'xref'.length);
    while (!isKeywordAt(pdfText, cursor, 'trailer')) {
      const section = readLine(pdfText, cursor);
      const sectionMatch = /^(\d+)\s+(\d+)$/u.exec(section.line);
      if (!sectionMatch) {
        return undefined;
      }
      cursor = section.next;

      const entryCount = Number.parseInt(sectionMatch[2] ?? '', 10);
      if (!Number.isSafeInteger(entryCount)
        || entryCount < 0
        || parsedEntries + entryCount > MAX_PDF_XREF_SECTION_ENTRIES) {
        return undefined;
      }

      for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
        const entry = readLine(pdfText, cursor);
        if (!/^(\d{10})\s+(\d{5})\s+([fn])\b/u.test(entry.line)) {
          return undefined;
        }
        cursor = entry.next;
        parsedEntries += 1;
      }

      cursor = skipPdfWhitespaceAndComments(pdfText, cursor);
    }

    cursor = skipPdfWhitespaceAndComments(pdfText, cursor + 'trailer'.length);
    if (!pdfText.startsWith('<<', cursor)) {
      return undefined;
    }
    const dictionaryEnd = findDictionaryEnd(pdfText, cursor, budget);
    const trailerDictionary = pdfText.slice(cursor, dictionaryEnd);
    xrefOffset = readDictionaryNonNegativeInteger(trailerDictionary, 'Prev', budget);
  }

  return chain;
}

// Rescue for documents whose tail is truncated or extended after %%EOF: the
// strict end-anchored parse rejects them even when a genuine startxref
// survived near the end. Candidates are collected from the startxref
// structure anchored at every surviving %%EOF marker (bytes appended after a
// marker can never shadow the revision ending at the marker) plus bare
// startxref keywords in the trailing window (a truncated incremental update
// keeps its startxref after the previous revision's marker). Only candidates
// whose offset points at a real `xref` keyword are kept, and the winner must
// own every other candidate through its /Prev chain, so forged startxref
// text pointing at an older revision is rejected instead of silently
// rolling the document back.
function findRescueStartXrefOffset(pdfText: string, budget: PdfExtractionBudget): number | undefined {
  const candidatePositions = new Map<number, number>();
  const registerCandidate = (offset: number, position: number) => {
    candidatePositions.set(offset, Math.max(candidatePositions.get(offset) ?? -1, position));
  };

  let markerSearchFrom = 0;
  while (markerSearchFrom < pdfText.length) {
    assertWithinProcessingTime(budget);
    const markerStart = pdfText.indexOf(PDF_EOF_MARKER, markerSearchFrom);
    if (markerStart < 0) {
      break;
    }
    markerSearchFrom = markerStart + PDF_EOF_MARKER.length;

    const anchoredOffset = findLastStartXrefOffset(pdfText, markerStart + PDF_EOF_MARKER.length);
    if (anchoredOffset !== undefined && isKeywordAt(pdfText, anchoredOffset, 'xref')) {
      registerCandidate(anchoredOffset, markerStart);
    }
  }

  const tailStart = Math.max(0, pdfText.length - MAX_PDF_STARTXREF_TAIL_SEARCH_BYTES);
  const startxrefKeyword = 'startxref';
  let searchFrom = pdfText.length - 1;
  while (searchFrom >= tailStart) {
    assertWithinProcessingTime(budget);
    const keywordIndex = pdfText.lastIndexOf(startxrefKeyword, searchFrom);
    if (keywordIndex < tailStart) {
      break;
    }
    searchFrom = keywordIndex - 1;

    if (keywordIndex > 0 && !isPdfWhitespace(pdfText[keywordIndex - 1])) {
      continue;
    }

    let cursor = keywordIndex + startxrefKeyword.length;
    if (cursor >= pdfText.length || !isPdfWhitespace(pdfText[cursor])) {
      continue;
    }
    while (cursor < pdfText.length && isPdfWhitespace(pdfText[cursor])) {
      cursor += 1;
    }
    const digitsStart = cursor;
    while (cursor < pdfText.length && pdfText[cursor] >= '0' && pdfText[cursor] <= '9') {
      cursor += 1;
    }
    if (cursor === digitsStart || cursor - digitsStart > 15) {
      continue;
    }

    const offset = Number.parseInt(pdfText.slice(digitsStart, cursor), 10);
    if (!Number.isSafeInteger(offset) || offset < 0 || !isKeywordAt(pdfText, offset, 'xref')) {
      continue;
    }
    registerCandidate(offset, keywordIndex);
  }

  if (candidatePositions.size === 0) {
    return undefined;
  }

  const candidates = [...candidatePositions.entries()]
    .map(([offset, position]) => ({ offset, position }))
    .sort((left, right) => right.position - left.position);
  if (candidates.length === 1) {
    return candidates[0]?.offset;
  }

  // Multiple surviving startxref sources: the newest revision's /Prev chain
  // contains every older xref section, so only a candidate owning all the
  // others can be the head. Ambiguous tails fail closed instead of guessing.
  const chainCache = new Map<number, Set<number> | undefined>();
  for (const candidate of candidates) {
    let chain = chainCache.get(candidate.offset);
    if (chain === undefined && !chainCache.has(candidate.offset)) {
      chain = collectXrefChainOffsets(pdfText, candidate.offset, budget);
      chainCache.set(candidate.offset, chain);
    }
    if (!chain) {
      continue;
    }
    const ownsEveryOtherCandidate = candidates.every(
      (other) => other.offset === candidate.offset || chain!.has(other.offset),
    );
    if (ownsEveryOtherCandidate) {
      return candidate.offset;
    }
  }

  throw createPdfExtractionError('unsupported_structure', 'PDF cross-reference tail is ambiguous.');
}

function throwIfDictionaryIsEncrypted(dictionary: string, budget: PdfExtractionBudget): void {
  if (findDictionaryEntry(dictionary, 'Encrypt', budget) !== undefined) {
    throw new PdfTextExtractionError('encrypted', 'Encrypted PDF documents cannot be processed locally.');
  }
}

function throwIfStartXrefObjectIsEncrypted(
  pdfText: string,
  xrefOffset: number,
  budget: PdfExtractionBudget,
): void {
  const headerMatch = matchObjectHeaderAt(pdfText, xrefOffset);
  if (!headerMatch) {
    return;
  }
  const dictionaryStart = skipPdfWhitespaceAndComments(pdfText, headerMatch.contentStart);
  if (!pdfText.startsWith('<<', dictionaryStart)) {
    return;
  }
  const dictionaryEnd = findDictionaryEnd(pdfText, dictionaryStart, budget);
  const dictionary = pdfText.slice(dictionaryStart, dictionaryEnd);
  if (readDictionaryNameValue(dictionary, 'Type', budget) !== 'XRef') {
    return;
  }
  throwIfDictionaryIsEncrypted(dictionary, budget);
}

function parseClassicXrefOffsets(
  pdfText: string,
  budget: PdfExtractionBudget,
): ClassicXrefParseResult {
  const offsets = new Map<string, number>();
  let xrefOffset = findLastStartXrefOffset(pdfText, pdfText.length);
  if (xrefOffset === undefined) {
    xrefOffset = findRescueStartXrefOffset(pdfText, budget);
  }
  if (xrefOffset === undefined) {
    return { offsets, trailers: [], hasStartXref: false };
  }

  const trailers: string[] = [];
  const seenObjectNumbers = new Set<number>();
  const visited = new Set<number>();
  for (let depth = 0; xrefOffset !== undefined; depth += 1) {
    assertWithinProcessingTime(budget);
    if (depth >= MAX_PDF_XREF_CHAIN_DEPTH || visited.has(xrefOffset)) {
      throw createPdfExtractionError('unsupported_structure', 'PDF cross-reference chain is invalid or too deep.');
    }
    visited.add(xrefOffset);

    if (!isKeywordAt(pdfText, xrefOffset, 'xref')) {
      throwIfStartXrefObjectIsEncrypted(pdfText, xrefOffset, budget);
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

        const objectNumber = firstObjectNumber + entryIndex;
        // The chain is traversed newest-to-oldest, so the first entry for an
        // object number decides that object. Shadowing by object number (not
        // by number+generation) is what lets a newer free entry such as
        // `5 1 f` retire the older in-use entry `5 0 n`; otherwise a freed
        // object would be resurrected from the previous revision.
        if (seenObjectNumbers.has(objectNumber)) {
          continue;
        }
        seenObjectNumbers.add(objectNumber);
        if (entryMatch[3] === 'n') {
          const generationNumber = Number.parseInt(entryMatch[2] ?? '', 10);
          const objectOffset = Number.parseInt(entryMatch[1] ?? '', 10);
          offsets.set(`${objectNumber} ${generationNumber}`, objectOffset);
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
    // The /Prev chain is traversed newest-to-oldest, so unshift keeps the
    // trailers in physical order (oldest first, newest last).
    trailers.unshift(trailerDictionary);
    xrefOffset = readDictionaryNonNegativeInteger(trailerDictionary, 'Prev', budget);
  }

  return { offsets, trailers, hasStartXref: true };
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

  const headerMatch = matchObjectHeaderAt(pdfText, offset);
  if (!headerMatch
    || headerMatch.objectNumber !== objectNumber
    || headerMatch.generationNumber !== generationNumber) {
    throw createPdfExtractionError('unsupported_structure', 'PDF indirect length object is invalid.');
  }

  const valueStart = skipPdfWhitespaceAndComments(pdfText, headerMatch.contentStart);
  const valueMatch = matchIntegerTokenAt(pdfText, valueStart);
  if (!valueMatch) {
    throw createPdfExtractionError('unsupported_structure', 'PDF indirect stream length is not an integer.');
  }
  const value = Number.parseInt(valueMatch.value, 10);
  const valueEnd = skipPdfWhitespaceAndComments(pdfText, valueMatch.next);
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

function hasEndStreamKeywordAt(pdfText: string, start: number): boolean {
  // The byte before `endstream` is arbitrary stream data when the declared
  // /Length ends exactly at the keyword, so only the trailing delimiter is
  // validated here.
  return pdfText.startsWith('endstream', start)
    && isPdfDelimiter(pdfText[start + 'endstream'.length]);
}

function parseIndirectObjectAt(
  bytes: Uint8Array,
  pdfText: string,
  header: NonNullable<ReturnType<typeof readIndirectObjectHeaderAt>>,
  xrefOffsets: Map<string, number>,
  budget: PdfExtractionBudget,
): { objectEnd: number; dictionaryObject?: PdfDictionaryObject; isStream: boolean } {
  const contentStart = header.contentStart;
  const objectKey = header.key;

  if (pdfText.startsWith('<<', contentStart)) {
    const dictionaryEnd = findDictionaryEnd(pdfText, contentStart, budget);
    const dictionary = pdfText.slice(contentStart, dictionaryEnd);
    if (readDictionaryNameValue(dictionary, 'Type', budget) === 'XRef') {
      throwIfDictionaryIsEncrypted(dictionary, budget);
      throw createPdfExtractionError('unsupported_structure', 'PDF cross-reference streams are not supported.');
    }

    const afterDictionary = skipPdfWhitespaceAndComments(pdfText, dictionaryEnd);
    if (!isKeywordAt(pdfText, afterDictionary, 'stream')) {
      if (!isKeywordAt(pdfText, afterDictionary, 'endobj')) {
        throw createPdfExtractionError('unsupported_structure', 'PDF dictionary object is missing endobj.');
      }
      return {
        objectEnd: afterDictionary + 'endobj'.length,
        dictionaryObject: {
          objectNumber: header.objectNumber,
          generationNumber: header.generationNumber,
          key: objectKey,
          dictionary,
        },
        isStream: false,
      };
    }

    const dataStart = resolveStreamDataStart(pdfText, afterDictionary + 'stream'.length);
    const streamLength = resolveStreamLength(dictionary, pdfText, xrefOffsets, budget);
    const dataEnd = dataStart + streamLength;
    if (!Number.isSafeInteger(dataEnd) || dataEnd > bytes.length) {
      throw createPdfExtractionError('unsupported_structure', 'PDF stream extends past the document boundary.');
    }
    const endStreamStart = resolveEndStreamTokenStart(pdfText, dataEnd);
    if (!hasEndStreamKeywordAt(pdfText, endStreamStart)) {
      throw createPdfExtractionError('unsupported_structure', 'PDF stream length does not match its endstream boundary.');
    }
    const endObjectStart = skipPdfWhitespaceAndComments(
      pdfText,
      endStreamStart + 'endstream'.length,
    );
    if (!isKeywordAt(pdfText, endObjectStart, 'endobj')) {
      throw createPdfExtractionError('unsupported_structure', 'PDF stream object is missing endobj.');
    }
    return {
      objectEnd: endObjectStart + 'endobj'.length,
      dictionaryObject: {
        objectNumber: header.objectNumber,
        generationNumber: header.generationNumber,
        key: objectKey,
        dictionary,
        stream: {
          objectKey,
          dictionary,
          bytes: bytes.subarray(dataStart, dataEnd),
        },
      },
      isStream: true,
    };
  }

  const endObjectStart = findTopLevelEndObjectStart(pdfText, contentStart, budget);
  if (endObjectStart < 0) {
    throw createPdfExtractionError('unsupported_structure', 'PDF object is missing endobj.');
  }
  return {
    objectEnd: endObjectStart + 'endobj'.length,
    isStream: false,
  };
}

function collectPdfStructure(
  bytes: Uint8Array,
  pdfText: string,
  budget: PdfExtractionBudget,
): CollectedPdfStructure {
  const classicXref = parseClassicXrefOffsets(pdfText, budget);
  const objects = new Map<string, PdfDictionaryObject>();
  const objectOrder: PdfDictionaryObject[] = [];
  let objectCount = 0;
  let streamCount = 0;

  const registerObject = (header: NonNullable<ReturnType<typeof readIndirectObjectHeaderAt>>): number => {
    objectCount += 1;
    if (objectCount > MAX_PDF_OBJECT_COUNT) {
      throw createPdfExtractionError('resource_limit', 'PDF contains too many objects.');
    }

    const parsedObject = parseIndirectObjectAt(bytes, pdfText, header, classicXref.offsets, budget);
    if (parsedObject.isStream) {
      streamCount += 1;
      if (streamCount > MAX_PDF_STREAM_COUNT) {
        throw createPdfExtractionError('resource_limit', 'PDF contains too many streams.');
      }
    }

    if (parsedObject.dictionaryObject) {
      objects.set(header.key, parsedObject.dictionaryObject);
      objectOrder.push(parsedObject.dictionaryObject);
    }
    return parsedObject.objectEnd;
  };

  const trailers: string[] = [];
  if (classicXref.hasStartXref) {
    trailers.push(...classicXref.trailers);

    const offsetEntries: [string, number][] = [];
    classicXref.offsets.forEach((offset, key) => {
      offsetEntries.push([key, offset]);
    });
    offsetEntries.sort((left, right) => (left[1] - right[1]));

    for (const [key, offset] of offsetEntries) {
      assertWithinProcessingTime(budget);
      const header = Number.isSafeInteger(offset) && offset >= 0 && offset < pdfText.length
        ? readIndirectObjectHeaderAt(pdfText, offset)
        : undefined;
      if (!header || header.key !== key) {
        throw createPdfExtractionError(
          'unsupported_structure',
          'PDF cross-reference entry points to an invalid object.',
        );
      }
      registerObject(header);
    }
  } else {
    let cursor = 0;
    while (cursor < pdfText.length) {
      assertWithinProcessingTime(budget);
      const topLevelStructure = findNextTopLevelStructure(pdfText, cursor, budget);
      if (!topLevelStructure) {
        break;
      }

      if (topLevelStructure.type === 'trailer') {
        if (topLevelStructure.next <= cursor) {
          throw createPdfExtractionError('unsupported_structure', 'PDF top-level structure is malformed.');
        }
        trailers.push(topLevelStructure.dictionary);
        cursor = topLevelStructure.next;
        continue;
      }

      const objectEnd = registerObject(topLevelStructure.header);
      if (objectEnd <= cursor) {
        throw createPdfExtractionError('unsupported_structure', 'PDF top-level structure is malformed.');
      }
      cursor = objectEnd;
    }
  }

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

function resolveDictionaryEntryAsDictionary(
  structure: CollectedPdfStructure,
  ownerDictionary: string,
  key: string,
  budget: PdfExtractionBudget,
): string | undefined {
  const entry = findDictionaryEntry(ownerDictionary, key, budget);
  if (!entry) {
    return undefined;
  }

  if (ownerDictionary.startsWith('<<', entry.valueStart)) {
    const dictionaryEnd = findDictionaryEnd(ownerDictionary, entry.valueStart, budget);
    if (dictionaryEnd !== entry.valueEnd) {
      throw createPdfExtractionError(
        'unsupported_structure',
        `PDF /${key} entry does not resolve to a dictionary.`,
      );
    }
    return ownerDictionary.slice(entry.valueStart, dictionaryEnd);
  }

  const reference = readIndirectReferenceAt(ownerDictionary, entry.valueStart);
  if (!reference || reference.next !== entry.valueEnd) {
    throw createPdfExtractionError(
      'unsupported_structure',
      `PDF /${key} entry does not resolve to a dictionary.`,
    );
  }

  const object = structure.objects.get(reference.reference.key);
  if (!object || object.stream) {
    throw createPdfExtractionError(
      'unsupported_structure',
      `PDF /${key} entry does not resolve to a dictionary.`,
    );
  }

  return object.dictionary;
}

function readNamedReferenceDictionary(
  dictionary: string,
  budget: PdfExtractionBudget,
): { name: string; reference: PdfObjectReference }[] {
  if (!dictionary.startsWith('<<')) {
    throw createPdfExtractionError('unsupported_structure', 'PDF resource dictionary is malformed.');
  }

  const entries: { name: string; reference: PdfObjectReference }[] = [];
  let cursor = 2;
  while (cursor < dictionary.length) {
    assertWithinProcessingTime(budget);
    cursor = skipPdfWhitespaceAndComments(dictionary, cursor);
    if (dictionary.startsWith('>>', cursor)) {
      if (cursor + 2 !== dictionary.length) {
        throw createPdfExtractionError('unsupported_structure', 'PDF resource dictionary is malformed.');
      }
      return entries;
    }
    if (dictionary[cursor] !== '/') {
      throw createPdfExtractionError('unsupported_structure', 'PDF resource dictionary is malformed.');
    }

    const entryStart = cursor;
    const name = readPdfNameToken(dictionary, cursor);
    const valueStart = skipPdfWhitespaceAndComments(dictionary, name.next);
    const valueEnd = readPdfObjectEnd(dictionary, valueStart, budget);
    if (valueEnd <= entryStart) {
      throw createPdfExtractionError('unsupported_structure', 'PDF resource dictionary is malformed.');
    }
    const reference = readIndirectReferenceAt(dictionary, valueStart);
    if (!reference || reference.next !== valueEnd) {
      throw createPdfExtractionError(
        'unsupported_structure',
        'PDF resource dictionary contains an unsupported direct object.',
      );
    }

    entries.push({ name: name.value, reference: reference.reference });
    if (entries.length > MAX_PDF_PAGE_CONTENT_REFERENCES) {
      throw createPdfExtractionError('resource_limit', 'PDF page content references exceed local limits.');
    }
    cursor = valueEnd;
  }

  throw createPdfExtractionError('unsupported_structure', 'PDF resource dictionary is malformed.');
}

function resolveFormXObjectNames(
  structure: CollectedPdfStructure,
  resourcesDictionary: string,
  budget: PdfExtractionBudget,
): Set<string> {
  const xObjectDictionary = resolveDictionaryEntryAsDictionary(structure, resourcesDictionary, 'XObject', budget);
  if (!xObjectDictionary) {
    return new Set();
  }

  const names = new Set<string>();
  for (const entry of readNamedReferenceDictionary(xObjectDictionary, budget)) {
    assertWithinProcessingTime(budget);
    const object = structure.objects.get(entry.reference.key);
    if (!object || !object.stream) {
      throw createPdfExtractionError(
        'unsupported_structure',
        'PDF /XObject entry references a missing or non-stream object.',
      );
    }
    if (readDictionaryNameValue(object.dictionary, 'Subtype', budget) !== 'Form') {
      continue;
    }
    names.add(entry.name);
  }

  return names;
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

  const pages: PdfPageContent[] = [];
  const visited = new Set<string>();
  const formXObjectNamesCache = new Map<string, Set<string>>();
  const pending: { depth: number; reference: PdfObjectReference; resourcesDictionary?: string }[] = [{
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
      const ownResourcesDictionary = resolveDictionaryEntryAsDictionary(
        structure,
        object.dictionary,
        'Resources',
        budget,
      );
      // An object's own Resources entry overrides inherited resources whenever
      // it is present, even as an explicit empty dictionary.
      const effectiveResourcesDictionary = ownResourcesDictionary ?? current.resourcesDictionary;
      const kidsEntry = findDictionaryEntry(object.dictionary, 'Kids', budget);
      if (!kidsEntry) {
        throw createPdfExtractionError('unsupported_structure', 'PDF page tree node is missing /Kids.');
      }
      const kids = readReferenceArray(object.dictionary, kidsEntry, 'Kids', budget);
      for (let index = kids.length - 1; index >= 0; index -= 1) {
        pending.push({
          depth: current.depth + 1,
          reference: kids[index],
          resourcesDictionary: effectiveResourcesDictionary,
        });
      }
      continue;
    }
    if (type !== 'Page') {
      throw createPdfExtractionError('unsupported_structure', 'PDF page tree contains a non-page object.');
    }

    const ownResourcesDictionary = resolveDictionaryEntryAsDictionary(
      structure,
      object.dictionary,
      'Resources',
      budget,
    );
    const effectiveResourcesDictionary = ownResourcesDictionary ?? current.resourcesDictionary;

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
    let formXObjectNames: Set<string>;
    if (effectiveResourcesDictionary === undefined) {
      formXObjectNames = new Set<string>();
    } else {
      // Pages inheriting the same resources dictionary share one resolution;
      // re-parsing it per page competes with content extraction for the budget.
      const cachedFormXObjectNames = formXObjectNamesCache.get(effectiveResourcesDictionary);
      if (cachedFormXObjectNames) {
        formXObjectNames = cachedFormXObjectNames;
      } else {
        formXObjectNames = resolveFormXObjectNames(structure, effectiveResourcesDictionary, budget);
        formXObjectNamesCache.set(effectiveResourcesDictionary, formXObjectNames);
      }
    }
    pages.push({ streams: pageStreams, formXObjectNames });
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
    const name = readPdfNameToken(input, cursor);
    return { next: name.next, token: { type: 'name', value: name.value } };
  }

  PDF_CONTENT_NUMBER_PATTERN.lastIndex = cursor;
  const numberMatch = PDF_CONTENT_NUMBER_PATTERN.exec(input);
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

function readTrailingNumberOperands(
  operands: PdfContentToken[],
  count: number,
): number[] | undefined {
  if (operands.length < count) {
    return undefined;
  }
  const values: number[] = [];
  for (let index = operands.length - count; index < operands.length; index += 1) {
    const operand = operands[index];
    if (operand.type !== 'number' || !Number.isFinite(operand.value)) {
      return undefined;
    }
    values.push(operand.value);
  }
  return values;
}

type PdfInlineImageDictionary = {
  entries: ReadonlyMap<string, PdfContentToken>;
  dataStart: number;
};

type PakoInflateInputState = {
  ended?: boolean;
  strm?: {
    total_in?: number;
  };
};

const INLINE_IMAGE_KEY_ALIASES: Readonly<Record<string, string>> = {
  BPC: 'BitsPerComponent',
  CS: 'ColorSpace',
  F: 'Filter',
  H: 'Height',
  IM: 'ImageMask',
  W: 'Width',
};

const INLINE_IMAGE_FILTER_ALIASES: Readonly<Record<string, string>> = {
  A85: 'ASCII85Decode',
  AHx: 'ASCIIHexDecode',
  DCT: 'DCTDecode',
  Fl: 'FlateDecode',
  RL: 'RunLengthDecode',
};

const INLINE_IMAGE_BOUNDARY_KEYS = new Set([
  'BitsPerComponent',
  'ColorSpace',
  'Filter',
  'Height',
  'ImageMask',
  'Width',
]);

function normalizeInlineImageKey(value: string): string {
  return INLINE_IMAGE_KEY_ALIASES[value] ?? value;
}

function normalizeInlineImageFilter(value: string): string {
  return INLINE_IMAGE_FILTER_ALIASES[value] ?? value;
}

function readInlineImageDictionaryValue(
  content: string,
  start: number,
  end: number,
  budget: PdfExtractionBudget,
): PdfContentToken {
  const result = readContentToken(content, start, budget);
  if (!result.token || result.next !== end) {
    throw createPdfExtractionError(
      'unsupported_structure',
      'PDF inline image dictionary contains an unsupported value.',
    );
  }
  return result.token;
}

function readInlineImageDictionary(
  content: string,
  dictionaryStart: number,
  budget: PdfExtractionBudget,
): PdfInlineImageDictionary {
  const entries = new Map<string, PdfContentToken>();
  const seenKeys = new Set<string>();
  let cursor = dictionaryStart;
  let entryCount = 0;

  while (cursor < content.length) {
    assertWithinProcessingTime(budget);
    cursor = skipPdfWhitespaceAndComments(content, cursor);
    if (isKeywordAt(content, cursor, 'ID')) {
      const separatorStart = cursor + 'ID'.length;
      const separator = content[separatorStart];
      if (!isPdfWhitespace(separator)) {
        throw createPdfExtractionError(
          'unsupported_structure',
          'PDF inline image ID keyword is missing its data separator.',
        );
      }

      // PDF treats CRLF as one end-of-line marker. Consume exactly one
      // separator unit rather than all whitespace so leading pixel bytes are
      // retained when an unfiltered image starts with a whitespace byte.
      const dataStart = separator === '\r' && content[separatorStart + 1] === '\n'
        ? separatorStart + 2
        : separatorStart + 1;
      return { entries, dataStart };
    }

    if (content[cursor] !== '/') {
      throw createPdfExtractionError(
        'unsupported_structure',
        'PDF inline image dictionary is malformed.',
      );
    }

    const key = readPdfNameToken(content, cursor);
    const normalizedKey = normalizeInlineImageKey(key.value);
    const valueStart = skipPdfWhitespaceAndComments(content, key.next);
    if (valueStart >= content.length || isKeywordAt(content, valueStart, 'ID')) {
      throw createPdfExtractionError(
        'unsupported_structure',
        'PDF inline image dictionary entry is missing its value.',
      );
    }
    const valueEnd = readPdfObjectEnd(content, valueStart, budget);
    if (valueEnd <= valueStart) {
      throw createPdfExtractionError(
        'unsupported_structure',
        'PDF inline image dictionary is malformed.',
      );
    }

    entryCount += 1;
    if (entryCount > MAX_PDF_INLINE_IMAGE_DICTIONARY_ENTRIES) {
      throw createPdfExtractionError(
        'resource_limit',
        'PDF inline image dictionary exceeds local limits.',
      );
    }
    if (seenKeys.has(normalizedKey)) {
      throw createPdfExtractionError(
        'unsupported_structure',
        'PDF inline image dictionary contains duplicate entries.',
      );
    }
    seenKeys.add(normalizedKey);
    if (INLINE_IMAGE_BOUNDARY_KEYS.has(normalizedKey)) {
      entries.set(
        normalizedKey,
        readInlineImageDictionaryValue(content, valueStart, valueEnd, budget),
      );
    }
    cursor = valueEnd;
  }

  throw createPdfExtractionError(
    'unsupported_structure',
    'PDF inline image is missing its ID keyword.',
  );
}

function readInlineImageFilters(entries: ReadonlyMap<string, PdfContentToken>): string[] {
  const filter = entries.get('Filter');
  if (!filter) {
    return [];
  }
  if (filter.type === 'name') {
    return [normalizeInlineImageFilter(filter.value)];
  }
  if (filter.type === 'array' && filter.value.every((entry) => entry.type === 'name')) {
    return filter.value.map((entry) => normalizeInlineImageFilter(
      (entry as Extract<PdfContentToken, { type: 'name' }>).value,
    ));
  }
  throw new PdfTextExtractionError(
    'unsupported_filter',
    'PDF inline image uses an unsupported filter declaration.',
  );
}

function readInlineImagePositiveInteger(
  entries: ReadonlyMap<string, PdfContentToken>,
  key: string,
): number {
  const entry = entries.get(key);
  if (
    entry?.type !== 'number'
    || !Number.isSafeInteger(entry.value)
    || entry.value <= 0
  ) {
    throw createPdfExtractionError(
      'unsupported_structure',
      `PDF inline image /${key} entry is missing or invalid.`,
    );
  }
  return entry.value;
}

function readInlineImageBoolean(
  entries: ReadonlyMap<string, PdfContentToken>,
  key: string,
  fallback: boolean,
): boolean {
  const entry = entries.get(key);
  if (!entry) {
    return fallback;
  }
  if (entry.type === 'word' && (entry.value === 'true' || entry.value === 'false')) {
    return entry.value === 'true';
  }
  throw createPdfExtractionError(
    'unsupported_structure',
    `PDF inline image /${key} entry is invalid.`,
  );
}

function resolveInlineImageColorComponents(
  entries: ReadonlyMap<string, PdfContentToken>,
  imageMask: boolean,
): number {
  if (imageMask) {
    return 1;
  }

  const colorSpace = entries.get('ColorSpace');
  const name = colorSpace?.type === 'name'
    ? colorSpace.value
    : colorSpace?.type === 'array' && colorSpace.value[0]?.type === 'name'
      ? colorSpace.value[0].value
      : undefined;
  switch (name) {
    case 'G':
    case 'DeviceGray':
    case 'I':
    case 'Indexed':
      return 1;
    case 'RGB':
    case 'DeviceRGB':
      return 3;
    case 'CMYK':
    case 'DeviceCMYK':
      return 4;
    default:
      throw createPdfExtractionError(
        'unsupported_structure',
        'PDF unfiltered inline image uses an unsupported color space.',
      );
  }
}

function resolveUnfilteredInlineImageByteLength(
  entries: ReadonlyMap<string, PdfContentToken>,
): number {
  const width = readInlineImagePositiveInteger(entries, 'Width');
  const height = readInlineImagePositiveInteger(entries, 'Height');
  const imageMask = readInlineImageBoolean(entries, 'ImageMask', false);
  const bitsPerComponent = imageMask
    ? 1
    : readInlineImagePositiveInteger(entries, 'BitsPerComponent');
  if (![1, 2, 4, 8, 16].includes(bitsPerComponent)) {
    throw createPdfExtractionError(
      'unsupported_structure',
      'PDF inline image uses an unsupported bits-per-component value.',
    );
  }
  const components = resolveInlineImageColorComponents(entries, imageMask);
  const bitsPerRow = width * components * bitsPerComponent;
  if (!Number.isSafeInteger(bitsPerRow)) {
    throw createPdfExtractionError('resource_limit', 'PDF inline image dimensions exceed local limits.');
  }
  const byteLength = Math.ceil(bitsPerRow / 8) * height;
  if (!Number.isSafeInteger(byteLength) || byteLength > MAX_PDF_DECODED_STREAM_BYTES) {
    throw createPdfExtractionError('resource_limit', 'PDF inline image data exceeds local limits.');
  }
  return byteLength;
}

function findAsciiHexInlineImageEnd(
  content: string,
  dataStart: number,
  budget: PdfExtractionBudget,
): number {
  for (let cursor = dataStart; cursor < content.length; cursor += 1) {
    if ((cursor & 0xfff) === 0) {
      assertWithinProcessingTime(budget);
    }
    const char = content[cursor];
    if (char === '>') {
      return cursor + 1;
    }
    if (!isPdfWhitespace(char) && !/[0-9A-Fa-f]/u.test(char)) {
      throw createPdfExtractionError(
        'unsupported_structure',
        'PDF ASCIIHex inline image data is malformed.',
      );
    }
  }
  throw createPdfExtractionError(
    'unsupported_structure',
    'PDF ASCIIHex inline image is missing its end marker.',
  );
}

function findAscii85InlineImageEnd(
  content: string,
  dataStart: number,
  budget: PdfExtractionBudget,
): number {
  let tupleLength = 0;
  for (let cursor = dataStart; cursor < content.length; cursor += 1) {
    if ((cursor & 0xfff) === 0) {
      assertWithinProcessingTime(budget);
    }
    const char = content[cursor];
    if (isPdfWhitespace(char)) {
      continue;
    }
    if (char === '~') {
      if (content[cursor + 1] !== '>' || tupleLength === 1) {
        throw createPdfExtractionError(
          'unsupported_structure',
          'PDF ASCII85 inline image data is malformed.',
        );
      }
      return cursor + 2;
    }
    if (char === 'z') {
      if (tupleLength !== 0) {
        throw createPdfExtractionError(
          'unsupported_structure',
          'PDF ASCII85 inline image data is malformed.',
        );
      }
      continue;
    }
    const code = char.charCodeAt(0);
    if (code < 33 || code > 117) {
      throw createPdfExtractionError(
        'unsupported_structure',
        'PDF ASCII85 inline image data is malformed.',
      );
    }
    tupleLength = (tupleLength + 1) % 5;
  }
  throw createPdfExtractionError(
    'unsupported_structure',
    'PDF ASCII85 inline image is missing its end marker.',
  );
}

function findRunLengthInlineImageEnd(
  content: string,
  dataStart: number,
  budget: PdfExtractionBudget,
): number {
  let cursor = dataStart;
  while (cursor < content.length) {
    assertWithinProcessingTime(budget);
    const runLength = content.charCodeAt(cursor) & 0xff;
    cursor += 1;
    if (runLength === 128) {
      return cursor;
    }
    const encodedByteCount = runLength <= 127 ? runLength + 1 : 1;
    if (cursor + encodedByteCount > content.length) {
      break;
    }
    cursor += encodedByteCount;
  }
  throw createPdfExtractionError(
    'unsupported_structure',
    'PDF RunLength inline image is missing its end marker.',
  );
}

function binaryStringSliceToBytes(content: string, start: number, end: number): Uint8Array {
  const bytes = new Uint8Array(end - start);
  for (let index = start; index < end; index += 1) {
    bytes[index - start] = content.charCodeAt(index) & 0xff;
  }
  return bytes;
}

function findFlateInlineImageEnd(
  content: string,
  dataStart: number,
  budget: PdfExtractionBudget,
): number {
  const inflater = new Inflate({ chunkSize: INFLATE_OUTPUT_CHUNK_BYTES });
  let decodedBytes = 0;
  inflater.onData = (chunk) => {
    decodedBytes += chunk.length;
    if (decodedBytes > MAX_PDF_INLINE_IMAGE_DECODED_BYTES) {
      throw createPdfExtractionError(
        'resource_limit',
        'PDF inline image decoded data exceeds local limits.',
      );
    }
    assertWithinProcessingTime(budget);
  };

  for (let offset = dataStart; offset < content.length; offset += INFLATE_INPUT_CHUNK_BYTES) {
    assertWithinProcessingTime(budget);
    const end = Math.min(content.length, offset + INFLATE_INPUT_CHUNK_BYTES);
    const accepted = inflater.push(binaryStringSliceToBytes(content, offset, end), false);
    if (!accepted || inflater.err) {
      throw createPdfExtractionError(
        'unsupported_structure',
        'PDF Flate inline image data is malformed.',
      );
    }
    const inputState = inflater as unknown as PakoInflateInputState;
    if (inputState.ended) {
      const consumedBytes = inputState.strm?.total_in;
      if (
        typeof consumedBytes !== 'number'
        || !Number.isSafeInteger(consumedBytes)
        || consumedBytes <= 0
        || dataStart + consumedBytes > content.length
      ) {
        throw createPdfExtractionError(
          'unsupported_structure',
          'PDF Flate inline image boundary is invalid.',
        );
      }
      return dataStart + consumedBytes;
    }
  }

  throw createPdfExtractionError(
    'unsupported_structure',
    'PDF Flate inline image is missing its end marker.',
  );
}

function findDctInlineImageEnd(
  content: string,
  dataStart: number,
  budget: PdfExtractionBudget,
): number {
  if (content.charCodeAt(dataStart) !== 0xff || content.charCodeAt(dataStart + 1) !== 0xd8) {
    throw createPdfExtractionError(
      'unsupported_structure',
      'PDF DCT inline image is missing its JPEG start marker.',
    );
  }

  let cursor = dataStart + 2;
  let insideEntropyData = false;
  while (cursor < content.length) {
    assertWithinProcessingTime(budget);
    if (insideEntropyData) {
      while (cursor < content.length && content.charCodeAt(cursor) !== 0xff) {
        cursor += 1;
        if ((cursor & 0xfff) === 0) {
          assertWithinProcessingTime(budget);
        }
      }
    } else if (content.charCodeAt(cursor) !== 0xff) {
      throw createPdfExtractionError(
        'unsupported_structure',
        'PDF DCT inline image contains malformed JPEG markers.',
      );
    }

    if (cursor >= content.length) {
      break;
    }
    while (content.charCodeAt(cursor) === 0xff) {
      cursor += 1;
    }
    const marker = content.charCodeAt(cursor) & 0xff;
    cursor += 1;

    if (insideEntropyData && marker === 0x00) {
      continue;
    }
    if (marker === 0xd9) {
      return cursor;
    }
    if (marker === 0xd8 || marker === 0x00) {
      throw createPdfExtractionError(
        'unsupported_structure',
        'PDF DCT inline image contains malformed JPEG markers.',
      );
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (cursor + 1 >= content.length) {
      break;
    }
    const segmentLength = (content.charCodeAt(cursor) << 8) | content.charCodeAt(cursor + 1);
    if (segmentLength < 2 || cursor + segmentLength > content.length) {
      throw createPdfExtractionError(
        'unsupported_structure',
        'PDF DCT inline image contains an invalid JPEG segment.',
      );
    }
    cursor += segmentLength;
    insideEntropyData = marker === 0xda;
  }
  throw createPdfExtractionError(
    'unsupported_structure',
    'PDF DCT inline image is missing its JPEG end marker.',
  );
}

function requireInlineImageEndOperator(
  content: string,
  dataEnd: number,
  budget: PdfExtractionBudget,
): number {
  if (!isPdfWhitespace(content[dataEnd])) {
    throw createPdfExtractionError(
      'unsupported_structure',
      'PDF inline image data is not followed by a valid EI separator.',
    );
  }
  const operatorStart = skipPdfWhitespaceAndComments(content, dataEnd);
  assertWithinProcessingTime(budget);
  if (!isKeywordAt(content, operatorStart, 'EI')) {
    throw createPdfExtractionError(
      'unsupported_structure',
      'PDF inline image is missing its EI operator.',
    );
  }
  return operatorStart + 'EI'.length;
}

// Inline images (`BI <dictionary> ID <data> EI`) embed arbitrary binary data
// in a content stream. Never locate their end by searching for the first
// whitespace-delimited `EI`: pixel bytes may contain that sequence and then
// attacker-shaped text operators. Instead, derive an exact boundary from the
// outer encoding's end marker (or from dimensions for unfiltered samples),
// discard the opaque bytes, and require the real EI operator immediately
// afterwards. Unknown encodings remain fail-closed.
function skipInlineImage(
  content: string,
  dictionaryStart: number,
  budget: PdfExtractionBudget,
): number {
  const dictionary = readInlineImageDictionary(content, dictionaryStart, budget);
  const filters = readInlineImageFilters(dictionary.entries);
  let dataEnd: number;

  switch (filters[0]) {
    case undefined:
      dataEnd = dictionary.dataStart + resolveUnfilteredInlineImageByteLength(dictionary.entries);
      if (dataEnd > content.length) {
        throw createPdfExtractionError(
          'unsupported_structure',
          'PDF unfiltered inline image data is truncated.',
        );
      }
      break;
    case 'ASCIIHexDecode':
      dataEnd = findAsciiHexInlineImageEnd(content, dictionary.dataStart, budget);
      break;
    case 'ASCII85Decode':
      dataEnd = findAscii85InlineImageEnd(content, dictionary.dataStart, budget);
      break;
    case 'RunLengthDecode':
      dataEnd = findRunLengthInlineImageEnd(content, dictionary.dataStart, budget);
      break;
    case 'FlateDecode':
      dataEnd = findFlateInlineImageEnd(content, dictionary.dataStart, budget);
      break;
    case 'DCTDecode':
      dataEnd = findDctInlineImageEnd(content, dictionary.dataStart, budget);
      break;
    default:
      throw new PdfTextExtractionError(
        'unsupported_filter',
        'PDF inline image uses an unsupported compression filter.',
      );
  }

  return requireInlineImageEndOperator(content, dataEnd, budget);
}

function extractTextFromContentStream(
  content: string,
  budget: PdfExtractionBudget,
  formXObjectNames: ReadonlySet<string>,
): string {
  const output: string[] = [];
  const operands: PdfContentToken[] = [];
  let cursor = 0;
  let insideTextObject = false;
  let hasShownText = false;
  let pendingSeparator: 'line' | undefined;
  let textLineY: number | undefined;

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
    if (hasShownText && pendingSeparator === 'line') {
      output.push('\n');
    }
    output.push(text);
    hasShownText = true;
    pendingSeparator = undefined;
  };

  while (cursor < content.length) {
    const result = readContentToken(content, cursor, budget);
    cursor = result.next;
    const token = result.token;
    if (!token) {
      break;
    }

    if (token.type !== 'word') {
      rememberOperand(token);
      continue;
    }

    const operator = token.value;
    if (operator === 'BT') {
      if (insideTextObject) {
        throw createPdfExtractionError('unsupported_structure', 'PDF contains nested text objects.');
      }
      insideTextObject = true;
      requestLineBreak();
      textLineY = undefined;
      operands.length = 0;
      continue;
    }
    if (operator === 'ET') {
      insideTextObject = false;
      requestLineBreak();
      operands.length = 0;
      continue;
    }
    if (operator === 'Do') {
      const nameOperand = findLastOperand(operands, 'name');
      if (nameOperand && formXObjectNames.has(nameOperand.value)) {
        throw createPdfExtractionError(
          'unsupported_structure',
          'PDF Form XObjects are not supported for local text extraction.',
        );
      }
    }
    if (operator === 'BI') {
      if (insideTextObject) {
        throw createPdfExtractionError(
          'unsupported_structure',
          'PDF inline images are not valid inside text objects.',
        );
      }
      cursor = skipInlineImage(content, cursor, budget);
      operands.length = 0;
      continue;
    }
    if (!insideTextObject) {
      operands.length = 0;
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
      textLineY = undefined;
      appendShownText(findLastOperand(operands, 'string')?.value ?? '');
    } else if (operator === 'T*') {
      requestLineBreak();
      textLineY = undefined;
    } else if (operator === 'Td' || operator === 'TD') {
      const movement = readTrailingNumberOperands(operands, 2);
      if (movement) {
        const ty = movement[1];
        if (ty !== 0) {
          requestLineBreak();
        }
        if (textLineY !== undefined) {
          textLineY += ty;
        }
      } else {
        textLineY = undefined;
      }
    } else if (operator === 'Tm') {
      const matrix = readTrailingNumberOperands(operands, 6);
      if (matrix) {
        const nextLineY = matrix[5];
        if (textLineY !== undefined && nextLineY !== textLineY) {
          requestLineBreak();
        }
        textLineY = nextLineY;
      }
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

// Receives streams already selected as page /Contents. Readers execute those
// as operators regardless of stray dictionary keys, so /Subtype is ignored
// here: honoring it would let a content stream hide its visible text by
// claiming to be an image.
function decodeStream(
  candidate: PdfStreamCandidate,
  budget: PdfExtractionBudget,
): string {
  const filterMode = resolvePdfStreamFilterMode(candidate.dictionary, budget);
  if (filterMode === 'unsupported') {
    throw new PdfTextExtractionError('unsupported_filter', 'PDF uses unsupported compression or content filters.');
  }

  try {
    if (filterMode === 'flate') {
      return inflateStream(candidate, budget);
    }

    reserveDecodedBytes(candidate.bytes.length, 0, undefined, budget);
    assertWithinProcessingTime(budget);
    return bytesToBinaryString(candidate.bytes);
  } catch (error) {
    if (error instanceof PdfTextExtractionError) {
      throw error;
    }
    throw new PdfTextExtractionError('invalid_pdf', 'PDF stream data could not be decoded.');
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

  let processedPageContentBytes = 0;
  const decodedStreamCache = new Map<string, string>();
  const extractedPages: string[] = [];
  for (const page of structure.pages) {
    const decodedPageStreams: string[] = [];
    for (const stream of page.streams) {
      let decodedText = decodedStreamCache.get(stream.objectKey);
      if (decodedText === undefined) {
        decodedText = decodeStream(stream, budget);
        decodedStreamCache.set(stream.objectKey, decodedText);
      }
      processedPageContentBytes += decodedText.length;
      if (processedPageContentBytes > MAX_PDF_DECODED_DOCUMENT_BYTES) {
        throw createPdfExtractionError(
          'resource_limit',
          'PDF page content exceeds the local decoded-size limit.',
        );
      }
      if (decodedText.length > 0) {
        decodedPageStreams.push(decodedText);
      }
    }

    const pageText = decodedPageStreams.length > 0
      ? extractTextFromContentStream(decodedPageStreams.join('\n'), budget, page.formXObjectNames)
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

  throw new PdfTextExtractionError('no_extractable_text', 'PDF has no extractable text.');
}
