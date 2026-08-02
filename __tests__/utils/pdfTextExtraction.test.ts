import { fromByteArray } from 'base64-js';
import { deflate } from 'pako';
import {
  PdfTextExtractionError,
  extractTextFromPdfBase64,
} from '../../src/utils/pdfTextExtraction';

function bytesToBinaryString(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
}

function toBase64Pdf(content: string): string {
  return fromByteArray(Buffer.from(content, 'binary'));
}

function createDeflatedTextPdf(textStream: string): string {
  const compressed = deflate(Buffer.from(textStream, 'binary'));
  const compressedText = bytesToBinaryString(compressed);
  return toBase64Pdf([
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Contents 4 0 R >> endobj',
    `4 0 obj << /Length ${compressed.length} /Filter /FlateDecode >> stream`,
    compressedText,
    'endstream endobj',
    '%%EOF',
  ].join('\n'));
}

function createPlainTextPdf(textStream: string, options: { trailer?: string } = {}): string {
  const streamLength = Buffer.byteLength(textStream, 'binary');
  return toBase64Pdf([
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Contents 4 0 R >> endobj',
    `4 0 obj << /Length ${streamLength} >> stream`,
    textStream,
    'endstream endobj',
    ...(options.trailer ? [`trailer << ${options.trailer} >>`] : []),
    '%%EOF',
  ].join('\n'));
}

function createClassicXrefPdfWithIndirectLength(textStream: string): string {
  let pdf = '%PDF-1.4\n';
  const offsets = new Map<number, number>();
  const appendObject = (objectNumber: number, body: string) => {
    offsets.set(objectNumber, Buffer.byteLength(pdf, 'binary'));
    pdf += `${objectNumber} 0 obj\n${body}\nendobj\n`;
  };

  appendObject(1, '<< /Type /Catalog /Pages 2 0 R >>');
  appendObject(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  appendObject(3, '<< /Type /Page /Contents 4 0 R >>');
  offsets.set(4, Buffer.byteLength(pdf, 'binary'));
  pdf += `4 0 obj\n<< /Length 5 0 R >>\nstream\n${textStream}\nendstream\nendobj\n`;
  appendObject(5, String(Buffer.byteLength(textStream, 'binary')));

  const xrefOffset = Buffer.byteLength(pdf, 'binary');
  pdf += 'xref\n0 6\n';
  pdf += '0000000000 65535 f \n';
  for (let objectNumber = 1; objectNumber <= 5; objectNumber += 1) {
    pdf += `${String(offsets.get(objectNumber)).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return toBase64Pdf(pdf);
}

function createPdfWithStreamCount(streamCount: number): string {
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Contents 4 0 R >> endobj',
  ];
  for (let index = 0; index < streamCount; index += 1) {
    const objectNumber = index + 4;
    objects.push(`${objectNumber} 0 obj << /Length 12 >> stream\nBT (A) Tj ET\nendstream endobj`);
  }
  return toBase64Pdf(['%PDF-1.4', ...objects, '%%EOF'].join('\n'));
}

describe('pdfTextExtraction', () => {
  it('extracts text from deflated PDF content streams', () => {
    const pdf = createDeflatedTextPdf('BT /F1 12 Tf 72 720 Td (Hello PDF) Tj T* (Second line) Tj ET');

    expect(extractTextFromPdfBase64(pdf)).toEqual({
      text: 'Hello PDF\nSecond line',
      pageCount: 1,
      isScanned: false,
    });
  });

  it('rejects encrypted PDFs deterministically', () => {
    const pdf = toBase64Pdf([
      '%PDF-1.4',
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
      'trailer << /Root 1 0 R /Encrypt 6 0 R >>',
      '%%EOF',
    ].join('\n'));

    expect(() => extractTextFromPdfBase64(pdf)).toThrow(PdfTextExtractionError);
    try {
      extractTextFromPdfBase64(pdf);
    } catch (error) {
      expect(error).toMatchObject({ reason: 'encrypted' });
    }
  });

  it('classifies image-only PDFs as having no extractable text', () => {
    const pdf = toBase64Pdf([
      '%PDF-1.4',
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
      '3 0 obj << /Type /Page /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >> endobj',
      '4 0 obj << /Length 11 >> stream',
      'q /Im1 Do Q',
      'endstream endobj',
      '5 0 obj << /Subtype /Image /Width 10 /Height 10 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >> stream',
      'abc',
      'endstream endobj',
      '%%EOF',
    ].join('\n'));

    expect(() => extractTextFromPdfBase64(pdf)).toThrow(PdfTextExtractionError);
    try {
      extractTextFromPdfBase64(pdf);
    } catch (error) {
      expect(error).toMatchObject({ reason: 'no_extractable_text' });
    }
  });

  it('preserves mixed literal and hex text-show operators in source order', () => {
    const pdf = createPlainTextPdf('BT (Hello) Tj <20576F726C64> Tj ET');

    expect(extractTextFromPdfBase64(pdf).text).toBe('Hello World');
  });

  it('preserves literal and hex strings inside TJ arrays in source order', () => {
    const pdf = createPlainTextPdf('BT [<41> (B) -20 <43>] TJ ET');

    expect(extractTextFromPdfBase64(pdf).text).toBe('ABC');
  });

  it('preserves visible word spacing encoded as a large negative TJ adjustment', () => {
    const pdf = createPlainTextPdf('BT [(Hello) -1200 (world)] TJ ET');

    expect(extractTextFromPdfBase64(pdf).text).toBe('Hello world');
  });

  it('preserves the order of multiple text objects', () => {
    const pdf = createPlainTextPdf('BT (First) Tj ET BT (Second) Tj ET');

    expect(extractTextFromPdfBase64(pdf).text).toBe('First\nSecond');
  });

  it('does not treat literal stream text as a trailer encryption entry', () => {
    const pdf = createPlainTextPdf('BT (Use /Encrypt only in the trailer) Tj ET');

    expect(extractTextFromPdfBase64(pdf).text).toBe('Use /Encrypt only in the trailer');
  });

  it('does not treat /Encrypt text inside a trailer literal string as encryption', () => {
    const pdf = createPlainTextPdf('BT (Public trailer note) Tj ET', {
      trailer: '/Root 1 0 R /Note (Use /Encrypt here)',
    });

    expect(extractTextFromPdfBase64(pdf).text).toBe('Public trailer note');
  });

  it('does not treat a nested trailer dictionary key as the top-level encryption entry', () => {
    const pdf = createPlainTextPdf('BT (Nested dictionary) Tj ET', {
      trailer: '/Root 1 0 R /Info << /Encrypt 6 0 R >>',
    });

    expect(extractTextFromPdfBase64(pdf).text).toBe('Nested dictionary');
  });

  it('extracts only streams referenced by page contents', () => {
    const pageText = 'BT (Visible page text) Tj ET';
    const privateText = 'BT (Unreferenced private stream) Tj ET';
    const pdf = toBase64Pdf([
      '%PDF-1.4',
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
      '3 0 obj << /Type /Page /Contents 4 0 R >> endobj',
      `4 0 obj << /Length ${Buffer.byteLength(pageText, 'binary')} >> stream`,
      pageText,
      'endstream endobj',
      `5 0 obj << /Length ${Buffer.byteLength(privateText, 'binary')} >> stream`,
      privateText,
      'endstream endobj',
      '%%EOF',
    ].join('\n'));

    expect(extractTextFromPdfBase64(pdf)).toEqual({
      text: 'Visible page text',
      pageCount: 1,
      isScanned: false,
    });
  });

  it('follows page-tree and content-array reference order instead of object order', () => {
    const firstPage = 'BT (First page) Tj ET';
    const secondPageStart = 'BT (Second) Tj';
    const secondPageEnd = '(page) Tj ET';
    const pdf = toBase64Pdf([
      '%PDF-1.4',
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Kids [5 0 R 3 0 R] /Count 2 >> endobj',
      '3 0 obj << /Type /Page /Contents [6 0 R 4 0 R] >> endobj',
      `4 0 obj << /Length ${Buffer.byteLength(secondPageEnd, 'binary')} >> stream`,
      secondPageEnd,
      'endstream endobj',
      '5 0 obj << /Type /Page /Contents 7 0 R >> endobj',
      `6 0 obj << /Length ${Buffer.byteLength(secondPageStart, 'binary')} >> stream`,
      secondPageStart,
      'endstream endobj',
      `7 0 obj << /Length ${Buffer.byteLength(firstPage, 'binary')} >> stream`,
      firstPage,
      'endstream endobj',
      '%%EOF',
    ].join('\n'));

    expect(extractTextFromPdfBase64(pdf)).toEqual({
      text: 'First page\n\nSecond page',
      pageCount: 2,
      isScanned: false,
    });
  });

  it('fails closed when a page references a missing content stream', () => {
    const pdf = toBase64Pdf([
      '%PDF-1.4',
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
      '3 0 obj << /Type /Page /Contents 99 0 R >> endobj',
      '%%EOF',
    ].join('\n'));

    expect(() => extractTextFromPdfBase64(pdf)).toThrow(PdfTextExtractionError);
    try {
      extractTextFromPdfBase64(pdf);
    } catch (error) {
      expect(error).toMatchObject({ reason: 'unsupported_structure' });
    }
  });

  it('does not inflate unreferenced compressed streams', () => {
    const pageText = 'BT (Bounded page) Tj ET';
    const compressed = deflate(Buffer.from(`BT (${String('X').repeat(2 * 1024 * 1024)}) Tj ET`, 'binary'));
    const pdf = toBase64Pdf([
      '%PDF-1.4',
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
      '3 0 obj << /Type /Page /Contents 4 0 R >> endobj',
      `4 0 obj << /Length ${Buffer.byteLength(pageText, 'binary')} >> stream`,
      pageText,
      'endstream endobj',
      `5 0 obj << /Length ${compressed.length} /Filter /FlateDecode >> stream`,
      bytesToBinaryString(compressed),
      'endstream endobj',
      '%%EOF',
    ].join('\n'));

    expect(extractTextFromPdfBase64(pdf).text).toBe('Bounded page');
  });

  it('uses declared stream length when stream bytes contain the endstream token', () => {
    const pdf = createPlainTextPdf('BT (literal endstream marker) Tj ET');

    expect(extractTextFromPdfBase64(pdf).text).toBe('literal endstream marker');
  });

  it('uses only top-level stream dictionary keys for length and filter parsing', () => {
    const textStream = 'BT (Top-level dictionary values) Tj ET';
    const pdf = toBase64Pdf([
      '%PDF-1.4',
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
      '3 0 obj << /Type /Page /Contents 4 0 R >> endobj',
      `4 0 obj << /Note (/Length 999 /Filter /DCTDecode) /Length ${Buffer.byteLength(textStream, 'binary')} >> stream`,
      textStream,
      'endstream endobj',
      '%%EOF',
    ].join('\n'));

    expect(extractTextFromPdfBase64(pdf).text).toBe('Top-level dictionary values');
  });

  it('resolves indirect stream lengths through a classic cross-reference table', () => {
    const pdf = createClassicXrefPdfWithIndirectLength('BT (indirect endstream length) Tj ET');

    expect(extractTextFromPdfBase64(pdf)).toEqual({
      text: 'indirect endstream length',
      pageCount: 1,
      isScanned: false,
    });
  });

  it('does not count page markers embedded inside stream bytes', () => {
    const pdf = createPlainTextPdf('BT (literal /Type /Page marker) Tj ET');

    expect(extractTextFromPdfBase64(pdf).pageCount).toBe(1);
  });

  it('rejects a small deflate stream before a decompression bomb is materialized', () => {
    const expandedText = `BT (${String('A').repeat(10 * 1024 * 1024)}) Tj ET`;
    const pdf = createDeflatedTextPdf(expandedText);

    expect(() => extractTextFromPdfBase64(pdf)).toThrow(PdfTextExtractionError);
    try {
      extractTextFromPdfBase64(pdf);
    } catch (error) {
      expect(error).toMatchObject({ reason: 'resource_limit' });
    }
  });

  it('rejects documents with more than the bounded stream count', () => {
    const pdf = createPdfWithStreamCount(257);

    expect(() => extractTextFromPdfBase64(pdf)).toThrow(PdfTextExtractionError);
    try {
      extractTextFromPdfBase64(pdf);
    } catch (error) {
      expect(error).toMatchObject({ reason: 'resource_limit' });
    }
  });
});
