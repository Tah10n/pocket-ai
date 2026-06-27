import { toByteArray } from 'base64-js';
import { inflate } from 'pako';

export type PdfTextExtractionFailureReason =
  | 'encrypted'
  | 'invalid_pdf'
  | 'no_extractable_text'
  | 'unsupported_filter';

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
  dictionary: string;
  bytes: Uint8Array;
};

const PDF_BINARY_HEADER_PATTERN = /^%PDF-\d+\.\d/u;
const PDF_ENCRYPT_PATTERN = /\/Encrypt(?:\s|<|\/|\d)/u;
const PDF_PAGE_PATTERN = /\/Type\s*\/Page(?!s)\b/gu;
const PDF_IMAGE_STREAM_PATTERN = /\/Subtype\s*\/Image\b/u;
const PDF_FILTER_PATTERN = /\/Filter\s*(?:\/([A-Za-z0-9]+)|\[(.*?)\])/su;
const PDF_TEXT_OBJECT_PATTERN = /BT\b([\s\S]*?)\bET/g;
const PDF_LITERAL_TEXT_SHOW_PATTERN = /((?:\((?:\\.|[^\\()])*\)\s*)+)(?:Tj|'|")\b/g;
const PDF_ARRAY_TEXT_SHOW_PATTERN = /\[([\s\S]*?)\]\s*TJ\b/g;
const PDF_HEX_STRING_PATTERN = /<([0-9A-Fa-f\s]+)>/g;
const PDF_SPACING_OPERATOR_PATTERN = /\b(?:T\*|Td|TD)\b/g;

function bytesToBinaryString(bytes: Uint8Array): string {
  let text = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    text += String.fromCharCode(...chunk);
  }

  return text;
}

function binaryStringToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index) & 0xff;
  }

  return bytes;
}

function normalizeExtractedWhitespace(text: string): string {
  return text
    .replace(/[ \t\f\v]+/gu, ' ')
    .replace(/[ \t]*\n[ \t]*/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function countPages(pdfText: string): number | undefined {
  const matches = pdfText.match(PDF_PAGE_PATTERN);
  return matches && matches.length > 0 ? matches.length : undefined;
}

function hasUnsupportedFilter(dictionary: string): boolean {
  const match = PDF_FILTER_PATTERN.exec(dictionary);
  if (!match) {
    return false;
  }

  const singleFilter = match[1]?.trim();
  if (singleFilter) {
    return singleFilter !== 'FlateDecode';
  }

  const filterList = match[2] ?? '';
  const filters = Array.from(filterList.matchAll(/\/([A-Za-z0-9]+)/gu), (entry) => entry[1]);
  return filters.some((filter) => filter !== 'FlateDecode');
}

function isFlateEncoded(dictionary: string): boolean {
  return /\/FlateDecode\b/u.test(dictionary);
}

function findStreamDictionary(pdfText: string, streamTokenStart: number): string {
  const dictionaryStart = pdfText.lastIndexOf('<<', streamTokenStart);
  const dictionaryEnd = pdfText.lastIndexOf('>>', streamTokenStart);
  if (dictionaryStart < 0 || dictionaryEnd < dictionaryStart) {
    return '';
  }

  return pdfText.slice(dictionaryStart, dictionaryEnd + 2);
}

function resolveStreamDataStart(pdfText: string, streamTokenEnd: number): number {
  if (pdfText.startsWith('\r\n', streamTokenEnd)) {
    return streamTokenEnd + 2;
  }

  if (pdfText.startsWith('\n', streamTokenEnd) || pdfText.startsWith('\r', streamTokenEnd)) {
    return streamTokenEnd + 1;
  }

  return streamTokenEnd;
}

function resolveStreamDataEnd(pdfText: string, endStreamStart: number): number {
  if (endStreamStart > 0 && pdfText[endStreamStart - 1] === '\n') {
    return endStreamStart > 1 && pdfText[endStreamStart - 2] === '\r'
      ? endStreamStart - 2
      : endStreamStart - 1;
  }

  if (endStreamStart > 0 && pdfText[endStreamStart - 1] === '\r') {
    return endStreamStart - 1;
  }

  return endStreamStart;
}

function collectStreams(pdfText: string): PdfStreamCandidate[] {
  const streams: PdfStreamCandidate[] = [];
  let searchStart = 0;

  while (searchStart < pdfText.length) {
    const streamTokenStart = pdfText.indexOf('stream', searchStart);
    if (streamTokenStart < 0) {
      break;
    }

    const streamTokenEnd = streamTokenStart + 'stream'.length;
    const endStreamStart = pdfText.indexOf('endstream', streamTokenEnd);
    if (endStreamStart < 0) {
      break;
    }

    const dataStart = resolveStreamDataStart(pdfText, streamTokenEnd);
    const dataEnd = resolveStreamDataEnd(pdfText, endStreamStart);
    if (dataEnd >= dataStart) {
      streams.push({
        dictionary: findStreamDictionary(pdfText, streamTokenStart),
        bytes: binaryStringToBytes(pdfText.slice(dataStart, dataEnd)),
      });
    }

    searchStart = endStreamStart + 'endstream'.length;
  }

  return streams;
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

function extractLiteralStrings(input: string): string[] {
  const strings: string[] = [];
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] !== '(') {
      continue;
    }

    let depth = 1;
    let content = '';
    index += 1;
    for (; index < input.length; index += 1) {
      const char = input[index];
      if (char === '\\') {
        content += char;
        index += 1;
        if (index < input.length) {
          content += input[index];
        }
        continue;
      }

      if (char === '(') {
        depth += 1;
        content += char;
        continue;
      }

      if (char === ')') {
        depth -= 1;
        if (depth === 0) {
          break;
        }
        content += char;
        continue;
      }

      content += char;
    }

    if (depth === 0) {
      strings.push(decodePdfLiteralString(content));
    }
  }

  return strings;
}

function extractTextFromTextObject(textObject: string): string {
  const segments: string[] = [];
  const showLiteralText = (match: RegExpExecArray) => {
    const literals = extractLiteralStrings(match[1] ?? '');
    if (literals.length > 0) {
      segments.push(literals.join(''));
    }
  };

  let literalMatch: RegExpExecArray | null;
  PDF_LITERAL_TEXT_SHOW_PATTERN.lastIndex = 0;
  while ((literalMatch = PDF_LITERAL_TEXT_SHOW_PATTERN.exec(textObject)) !== null) {
    showLiteralText(literalMatch);
  }

  let arrayMatch: RegExpExecArray | null;
  PDF_ARRAY_TEXT_SHOW_PATTERN.lastIndex = 0;
  while ((arrayMatch = PDF_ARRAY_TEXT_SHOW_PATTERN.exec(textObject)) !== null) {
    const arrayBody = arrayMatch[1] ?? '';
    const literalText = extractLiteralStrings(arrayBody).join('');
    const hexText = Array.from(arrayBody.matchAll(PDF_HEX_STRING_PATTERN), (match) => decodePdfHexString(match[1] ?? '')).join('');
    const text = `${literalText}${hexText}`.trim();
    if (text.length > 0) {
      segments.push(text);
    }
  }

  PDF_HEX_STRING_PATTERN.lastIndex = 0;
  const standaloneHexText = Array.from(textObject.matchAll(PDF_HEX_STRING_PATTERN), (match) => decodePdfHexString(match[1] ?? ''))
    .filter((text) => text.trim().length > 0);
  if (segments.length === 0 && standaloneHexText.length > 0) {
    segments.push(...standaloneHexText);
  }

  const lineBreaks = textObject.match(PDF_SPACING_OPERATOR_PATTERN)?.length ?? 0;
  return segments.join(lineBreaks > 0 ? '\n' : ' ');
}

function extractTextFromContentStream(content: string): string {
  const textObjects: string[] = [];
  let match: RegExpExecArray | null;
  PDF_TEXT_OBJECT_PATTERN.lastIndex = 0;

  while ((match = PDF_TEXT_OBJECT_PATTERN.exec(content)) !== null) {
    const extracted = extractTextFromTextObject(match[1] ?? '');
    if (extracted.trim().length > 0) {
      textObjects.push(extracted);
    }
  }

  return normalizeExtractedWhitespace(textObjects.join('\n'));
}

function decodeStream(candidate: PdfStreamCandidate): { text?: string; unsupportedFilter: boolean } {
  if (PDF_IMAGE_STREAM_PATTERN.test(candidate.dictionary)) {
    return { unsupportedFilter: false };
  }

  if (hasUnsupportedFilter(candidate.dictionary)) {
    return { unsupportedFilter: true };
  }

  try {
    const bytes = isFlateEncoded(candidate.dictionary)
      ? inflate(candidate.bytes)
      : candidate.bytes;
    return {
      text: bytesToBinaryString(bytes),
      unsupportedFilter: false,
    };
  } catch {
    return { unsupportedFilter: true };
  }
}

export function extractTextFromPdfBase64(base64: string): PdfTextExtractionResult {
  let bytes: Uint8Array;
  try {
    bytes = toByteArray(base64.trim());
  } catch {
    throw new PdfTextExtractionError('invalid_pdf', 'PDF attachment could not be decoded.');
  }

  const pdfText = bytesToBinaryString(bytes);
  if (!PDF_BINARY_HEADER_PATTERN.test(pdfText.slice(0, 32))) {
    throw new PdfTextExtractionError('invalid_pdf', 'Document is not a valid PDF file.');
  }

  if (PDF_ENCRYPT_PATTERN.test(pdfText)) {
    throw new PdfTextExtractionError('encrypted', 'Encrypted PDF documents cannot be processed locally.');
  }

  const pageCount = countPages(pdfText);
  const streams = collectStreams(pdfText);
  let unsupportedFilterCount = 0;
  const extractedStreams = streams.flatMap((stream) => {
    const decoded = decodeStream(stream);
    if (decoded.unsupportedFilter) {
      unsupportedFilterCount += 1;
      return [];
    }

    const text = decoded.text ? extractTextFromContentStream(decoded.text) : '';
    return text.trim().length > 0 ? [text] : [];
  });
  const text = normalizeExtractedWhitespace(extractedStreams.join('\n\n'));

  if (text.length > 0) {
    return {
      text,
      isScanned: false,
      ...(pageCount !== undefined ? { pageCount } : null),
    };
  }

  if (unsupportedFilterCount > 0 && unsupportedFilterCount === streams.length) {
    throw new PdfTextExtractionError('unsupported_filter', 'PDF uses unsupported compression or content filters.');
  }

  throw new PdfTextExtractionError('no_extractable_text', 'PDF has no extractable text.');
}
