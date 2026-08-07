use std::cmp::Ordering as CmpOrdering;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::AtomicBool;

use serde::Serialize;
use unicode_normalization::UnicodeNormalization;
use unicode_segmentation::UnicodeSegmentation;

use crate::chunk::{CachedDocument, ContentChunk, utf16_len};
use crate::error::CoreError;
use crate::limits::{DEFAULT_SELECT_CHARS, DEFAULT_SELECT_CHUNKS};
use crate::preflight::checkpoint;
use crate::schema::SelectRequest;

const BM25_K1: f64 = 1.2;
const BM25_B: f64 = 0.75;
const MAX_UNIQUE_QUERY_TERMS: usize = 512;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SelectionData {
    pub chunks: Vec<ContentChunk>,
    pub selected_char_count: usize,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    pub warnings: Vec<String>,
}

pub(crate) fn select(
    document: &CachedDocument,
    request: &SelectRequest,
    cancelled: &AtomicBool,
) -> Result<SelectionData, CoreError> {
    checkpoint(cancelled)?;
    let max_chars = request.max_chars.unwrap_or(DEFAULT_SELECT_CHARS);
    let max_chunks = request.max_chunks.unwrap_or(DEFAULT_SELECT_CHUNKS);
    let offset = parse_cursor(request.cursor.as_deref())?;
    let ranked = rank(&document.chunks, &request.query, cancelled)?;
    let (ranking, omitted_atomic) =
        packed_order(&ranked, &document.chunks, max_chars, max_chunks, cancelled)?;
    if offset > ranking.len() {
        return Err(CoreError::InvalidRequest("cursor"));
    }

    let mut chunks = Vec::new();
    let mut selected_char_count = 0_usize;
    let mut consumed = offset;
    for &ranked_index in ranking.iter().skip(offset) {
        checkpoint(cancelled)?;
        if chunks.len() >= max_chunks || selected_char_count >= max_chars {
            break;
        }
        let source = &document.chunks[ranked_index];
        let source_units = utf16_len(&source.text);
        let remaining = max_chars - selected_char_count;
        if source_units > remaining {
            break;
        }
        selected_char_count += source_units;
        chunks.push(source.clone());
        consumed += 1;
    }
    checkpoint(cancelled)?;
    let truncated = consumed < ranking.len() || omitted_atomic;
    let mut warnings = document.warnings.clone();
    if truncated
        && !warnings
            .iter()
            .any(|warning| warning == "context_truncated")
    {
        warnings.push("context_truncated".to_string());
    }
    Ok(SelectionData {
        chunks,
        selected_char_count,
        truncated,
        next_cursor: (consumed < ranking.len()).then(|| format!("p:{consumed}")),
        warnings,
    })
}

fn rank(
    chunks: &[ContentChunk],
    query: &str,
    cancelled: &AtomicBool,
) -> Result<Vec<usize>, CoreError> {
    let query_terms = tokenize(query);
    if query_terms.is_empty() {
        return Ok(coverage_order(chunks));
    }
    let mut seen_query = HashSet::new();
    let unique_query = query_terms
        .into_iter()
        .filter(|term| seen_query.insert(term.clone()))
        .take(MAX_UNIQUE_QUERY_TERMS)
        .collect::<Vec<_>>();

    let mut documents = Vec::with_capacity(chunks.len());
    let mut frequencies = HashMap::<String, usize>::new();
    let mut total_length = 0_usize;
    for chunk in chunks {
        checkpoint(cancelled)?;
        let terms = tokenize(&chunk.text);
        total_length = total_length.saturating_add(terms.len());
        let counts = term_counts(terms);
        for term in &unique_query {
            if counts.contains_key(term) {
                *frequencies.entry(term.clone()).or_default() += 1;
            }
        }
        documents.push(counts);
    }
    let count = chunks.len().max(1) as f64;
    let average_length = (total_length as f64 / count).max(1.0);
    let mut scores = Vec::with_capacity(chunks.len());
    for (index, counts) in documents.iter().enumerate() {
        checkpoint(cancelled)?;
        let length = counts.values().sum::<usize>() as f64;
        let mut score = 0.0_f64;
        for term in &unique_query {
            let frequency = *counts.get(term).unwrap_or(&0) as f64;
            if frequency == 0.0 {
                continue;
            }
            let document_frequency = *frequencies.get(term).unwrap_or(&0) as f64;
            let inverse =
                ((count - document_frequency + 0.5) / (document_frequency + 0.5) + 1.0).ln();
            let denominator =
                frequency + BM25_K1 * (1.0 - BM25_B + BM25_B * length / average_length);
            score += inverse * (frequency * (BM25_K1 + 1.0)) / denominator;
        }
        // A heading match is valuable context, but the ordinal remains the
        // deterministic final tie breaker.
        if let Some(heading) = &chunks[index].heading {
            let heading_terms = tokenize(heading).into_iter().collect::<HashSet<_>>();
            score += unique_query
                .iter()
                .filter(|term| heading_terms.contains(*term))
                .count() as f64
                * 0.25;
        }
        scores.push((index, score));
    }
    if scores.iter().all(|(_, score)| *score <= f64::EPSILON) {
        return Ok(coverage_order(chunks));
    }
    scores.sort_by(|left, right| {
        right
            .1
            .partial_cmp(&left.1)
            .unwrap_or(CmpOrdering::Equal)
            .then_with(|| left.0.cmp(&right.0))
    });
    Ok(scores.into_iter().map(|(index, _)| index).collect())
}

fn coverage_order(chunks: &[ContentChunk]) -> Vec<usize> {
    let mut order = Vec::with_capacity(chunks.len());
    let mut seen = HashSet::new();
    let mut push = |index: usize| {
        if index < chunks.len() && seen.insert(index) {
            order.push(index);
        }
    };
    if !chunks.is_empty() {
        // Overview always reserves the smallest useful budget for document
        // anchors before adding outline detail.
        push(0);
        push(chunks.len() / 2);
        push(chunks.len() - 1);
    }
    let headings = chunks
        .iter()
        .enumerate()
        .filter(|(_, chunk)| chunk.kind == "heading" || chunk.heading.is_some())
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    for &index in &headings {
        push(index);
    }
    for index in 0..chunks.len() {
        push(index);
    }
    order
}

fn packed_order(
    ranked: &[usize],
    chunks: &[ContentChunk],
    max_chars: usize,
    max_chunks: usize,
    cancelled: &AtomicBool,
) -> Result<(Vec<usize>, bool), CoreError> {
    let mut pending = Vec::with_capacity(ranked.len());
    let mut omitted_atomic = false;
    for &index in ranked {
        checkpoint(cancelled)?;
        if utf16_len(&chunks[index].text) > max_chars {
            omitted_atomic = true;
        } else {
            pending.push(index);
        }
    }
    let mut output = Vec::with_capacity(pending.len());
    while !pending.is_empty() {
        checkpoint(cancelled)?;
        let mut page_chars = 0_usize;
        let mut page_chunks = 0_usize;
        let mut deferred = Vec::new();
        for index in pending {
            let units = utf16_len(&chunks[index].text);
            if page_chunks < max_chunks && page_chars.saturating_add(units) <= max_chars {
                output.push(index);
                page_chars += units;
                page_chunks += 1;
            } else {
                deferred.push(index);
            }
        }
        if page_chunks == 0 {
            return Err(CoreError::Internal);
        }
        pending = deferred;
    }
    Ok((output, omitted_atomic))
}

fn term_counts(terms: Vec<String>) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for term in terms {
        *counts.entry(term).or_default() += 1;
    }
    counts
}

fn tokenize(input: &str) -> Vec<String> {
    let normalized = input
        .nfkc()
        .flat_map(char::to_lowercase)
        .collect::<String>();
    let mut tokens = Vec::new();
    for word in normalized.unicode_words() {
        if word.is_empty() {
            continue;
        }
        tokens.push(word.to_string());
        let chars = word
            .chars()
            .filter(|character| !character.is_ascii())
            .collect::<Vec<_>>();
        if chars.len() > 1 {
            for pair in chars.windows(2) {
                tokens.push(pair.iter().collect());
            }
        }
    }
    tokens
}

fn parse_cursor(cursor: Option<&str>) -> Result<usize, CoreError> {
    match cursor {
        None => Ok(0),
        Some(value) => value
            .strip_prefix("p:")
            .and_then(|offset| offset.parse::<usize>().ok())
            .ok_or(CoreError::InvalidRequest("cursor")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunk::CachedDocument;
    use crate::schema::SelectRequest;
    use std::sync::atomic::AtomicBool;

    fn chunk(index: usize, text: &str) -> ContentChunk {
        ContentChunk {
            index,
            text: text.to_string(),
            kind: "paragraph".to_string(),
            asset_ids: Vec::new(),
            heading: None,
            page_number: None,
            slide_number: None,
            sheet_name: None,
        }
    }

    fn document(chunks: Vec<ContentChunk>) -> CachedDocument {
        CachedDocument {
            canonical_format: "csv".to_string(),
            source_byte_count: 1,
            source_char_count: chunks.iter().map(|chunk| utf16_len(&chunk.text)).sum(),
            content_sha256: "0".repeat(64),
            chunks,
            outline: Vec::new(),
            assets: Vec::new(),
            asset_payloads: Vec::new(),
            warnings: Vec::new(),
            slide_count: None,
            sheet_count: None,
            page_count: None,
            approximate_bytes: 1,
        }
    }

    #[test]
    fn unicode_nfkc_and_cjk_bigrams_rank_relevant_content() {
        let chunks = vec![
            chunk(0, "unrelated latin text"),
            chunk(1, "東京駅への道順"),
            chunk(2, "東北地方"),
        ];
        let ranked = rank(&chunks, "東京", &AtomicBool::new(false)).unwrap();
        assert_eq!(ranked[0], 1);
    }

    #[test]
    fn score_ties_preserve_source_order() {
        let chunks = vec![chunk(0, "same"), chunk(1, "same")];
        assert_eq!(
            rank(&chunks, "missing", &AtomicBool::new(false)).unwrap(),
            vec![0, 1]
        );
    }

    #[test]
    fn coverage_reaches_beginning_middle_and_end() {
        let chunks = (0..9).map(|index| chunk(index, "text")).collect::<Vec<_>>();
        let ranked = coverage_order(&chunks);
        assert_eq!(&ranked[..3], &[0, 4, 8]);
    }

    #[test]
    fn oversized_atomic_chunk_is_skipped_and_cursor_terminates() {
        let document = document(vec![chunk(0, "too large"), chunk(1, "x")]);
        let request = SelectRequest {
            schema_version: 1,
            request_id: "select".to_string(),
            handle: "handle".to_string(),
            query: String::new(),
            max_chars: Some(2),
            max_chunks: Some(2),
            cursor: None,
        };
        let result = select(&document, &request, &AtomicBool::new(false)).unwrap();
        assert_eq!(result.chunks.len(), 1);
        assert_eq!(result.chunks[0].index, 1);
        assert!(result.truncated);
        assert!(result.next_cursor.is_none());
    }

    #[test]
    fn overview_reserves_beginning_middle_end_even_with_headings() {
        let mut chunks = (0..9).map(|index| chunk(index, "text")).collect::<Vec<_>>();
        for chunk in &mut chunks[1..4] {
            chunk.kind = "heading".to_string();
            chunk.heading = Some(format!("Heading {}", chunk.index));
        }
        let document = document(chunks);
        let request = SelectRequest {
            schema_version: 1,
            request_id: "overview".to_string(),
            handle: "handle".to_string(),
            query: String::new(),
            max_chars: Some(100),
            max_chunks: Some(3),
            cursor: None,
        };
        let result = select(&document, &request, &AtomicBool::new(false)).unwrap();
        assert_eq!(
            result
                .chunks
                .iter()
                .map(|chunk| chunk.index)
                .collect::<Vec<_>>(),
            vec![0, 4, 8]
        );
    }

    #[test]
    fn later_small_chunk_fills_page_without_losing_deferred_chunk() {
        let document = document(vec![chunk(0, "aaaa"), chunk(1, "bbb"), chunk(2, "c")]);
        let mut request = SelectRequest {
            schema_version: 1,
            request_id: "pack-1".to_string(),
            handle: "handle".to_string(),
            query: String::new(),
            max_chars: Some(5),
            max_chunks: Some(3),
            cursor: None,
        };
        let first = select(&document, &request, &AtomicBool::new(false)).unwrap();
        assert_eq!(
            first
                .chunks
                .iter()
                .map(|chunk| chunk.index)
                .collect::<Vec<_>>(),
            vec![0, 2]
        );
        request.request_id = "pack-2".to_string();
        request.cursor = first.next_cursor;
        let second = select(&document, &request, &AtomicBool::new(false)).unwrap();
        assert_eq!(
            second
                .chunks
                .iter()
                .map(|chunk| chunk.index)
                .collect::<Vec<_>>(),
            vec![1]
        );
        assert!(!second.truncated);
    }

    #[test]
    fn query_term_cap_preserves_first_occurrence_order() {
        let chunks = vec![chunk(0, "t599"), chunk(1, "t0")];
        let query = (0..600)
            .map(|index| format!("t{index}"))
            .collect::<Vec<_>>()
            .join(" ");
        for _ in 0..16 {
            let ranked = rank(&chunks, &query, &AtomicBool::new(false)).unwrap();
            assert_eq!(ranked[0], 1);
        }
    }
}
