//! Mobile PDF stream normalization.
//!
//! The vendored lopdf decoder enforces the per-stream ceiling, including
//! object streams decoded during `Document::load`. This pass runs immediately
//! after load, decodes every filter chain lopdf itself understands, removes
//! those filters, and enforces a document-wide retained-stream budget. All
//! later content/font/XObject/ToUnicode/detector reads therefore clone only
//! already-bounded bytes instead of decompressing attacker-controlled data.

use lopdf::{Document, Object};

use crate::{runtime, PdfError};

/// Maximum decoded or retained bytes in one PDF stream.
pub const MAX_PDF_STREAM_BYTES: usize = lopdf::MAX_DECOMPRESSED_STREAM_BYTES;

/// Maximum aggregate retained stream bytes after bounded normalization.
pub const MAX_PDF_TOTAL_STREAM_BYTES: usize = 8 * 1024 * 1024;

/// Maximum number of stream objects walked during normalization.
pub const MAX_PDF_STREAMS: usize = 4_096;

pub(crate) fn normalize_document_streams(doc: &mut Document) -> Result<(), PdfError> {
    let mut stream_count = 0usize;
    let mut retained_bytes = 0usize;

    for object in doc.objects.values_mut() {
        let Object::Stream(stream) = object else {
            continue;
        };
        stream_count = stream_count.saturating_add(1);
        if stream_count > MAX_PDF_STREAMS {
            return Err(PdfError::ResourceLimit("max_pdf_streams"));
        }
        runtime::checkpoint()?;

        // Lopdf supports these filters and therefore might otherwise decode
        // them later in content, font, form, CMap, or detector code. Terminal
        // image codecs (DCT/JPX/CCITT/JBIG2) stay compressed; their compressed
        // bytes are still charged and per-stream bounded.
        let can_normalize = match stream.filters() {
            Ok(filters) => filters
                .iter()
                .all(|filter| matches!(*filter, b"FlateDecode" | b"LZWDecode" | b"ASCII85Decode")),
            Err(_) => stream.dict.get(b"Filter").is_err(),
        };

        let retained = if can_normalize {
            let decoded = stream.decompressed_content().map_err(PdfError::from)?;
            let len = decoded.len();
            stream.set_plain_content(decoded);
            len
        } else {
            if stream.content.len() > MAX_PDF_STREAM_BYTES {
                return Err(PdfError::ResourceLimit("max_pdf_stream_bytes"));
            }
            stream.content.len()
        };

        retained_bytes = retained_bytes.saturating_add(retained);
        if retained_bytes > MAX_PDF_TOTAL_STREAM_BYTES {
            return Err(PdfError::ResourceLimit("max_pdf_total_stream_bytes"));
        }
        runtime::charge(retained.div_ceil(4_096).max(1))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Stream};

    #[test]
    fn aggregate_stream_budget_is_enforced_before_extraction() {
        let mut document = Document::with_version("1.7");
        for index in 0..5u32 {
            document.objects.insert(
                (index + 1, 0),
                Object::Stream(Stream::new(
                    dictionary! {},
                    vec![index as u8; MAX_PDF_STREAM_BYTES],
                )),
            );
        }
        assert!(matches!(
            normalize_document_streams(&mut document),
            Err(PdfError::ResourceLimit("max_pdf_total_stream_bytes"))
        ));
    }
}
