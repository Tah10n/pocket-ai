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
      '5 0 obj << /Encrypt 6 0 R >> endobj',
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
      '4 0 obj << /Length 8 >> stream',
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
});
