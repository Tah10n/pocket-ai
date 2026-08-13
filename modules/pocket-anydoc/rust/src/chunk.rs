use std::collections::HashSet;
use std::sync::atomic::AtomicBool;

use anydoc::Format;
use anydoc::model::{self, Block, CellSlot};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::CoreError;
use crate::limits::{
    EffectiveLimits, MAX_ASSET_BYTES, MAX_ASSET_DESCRIPTORS, MAX_CHUNK_CHARS, MAX_OUTLINE_ENTRIES,
    PROSE_CHUNK_OVERLAP_CHARS,
};
use crate::preflight::{PreparedSource, checkpoint};
use crate::{ANYDOC_COMMIT, ANYDOC_VERSION};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContentChunk {
    pub index: usize,
    pub text: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub asset_ids: Vec<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heading: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_number: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slide_number: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sheet_name: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OutlineEntry {
    pub level: u8,
    pub title: String,
    pub chunk_index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slide_number: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sheet_name: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AssetDescriptor {
    pub id: usize,
    pub media_type: String,
    pub byte_length: usize,
    pub sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

/// Validated payload retained only in the bounded native cache. It is never
/// serialized; the materialization export writes at most one selected raster
/// to a native-provided private destination without reparsing.
#[derive(Clone, Debug)]
#[allow(dead_code)]
pub(crate) struct CachedAssetPayload {
    pub id: usize,
    pub media_type: String,
    pub bytes: Vec<u8>,
    pub sha256: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug)]
pub(crate) struct CachedDocument {
    pub canonical_format: String,
    pub source_byte_count: usize,
    pub source_char_count: usize,
    pub content_sha256: String,
    pub chunks: Vec<ContentChunk>,
    pub outline: Vec<OutlineEntry>,
    pub assets: Vec<AssetDescriptor>,
    pub asset_payloads: Vec<CachedAssetPayload>,
    pub warnings: Vec<String>,
    pub slide_count: Option<usize>,
    pub sheet_count: Option<usize>,
    pub page_count: Option<usize>,
    pub approximate_bytes: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrepareData<'a> {
    pub handle: &'a str,
    pub canonical_format: &'a str,
    pub parser_id: &'static str,
    pub parser_version: &'static str,
    pub exact_any_doc_commit: &'static str,
    pub source_byte_count: usize,
    pub source_char_count: usize,
    pub content_sha256: &'a str,
    pub chunk_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slide_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sheet_count: Option<usize>,
    pub asset_count: usize,
    pub warnings: &'a [String],
    pub outline: &'a [OutlineEntry],
    pub assets: &'a [AssetDescriptor],
}

impl CachedDocument {
    pub(crate) fn prepare_data<'a>(&'a self, handle: &'a str) -> PrepareData<'a> {
        PrepareData {
            handle,
            canonical_format: &self.canonical_format,
            parser_id: "anydoc",
            parser_version: ANYDOC_VERSION,
            exact_any_doc_commit: ANYDOC_COMMIT,
            source_byte_count: self.source_byte_count,
            source_char_count: self.source_char_count,
            content_sha256: &self.content_sha256,
            chunk_count: self.chunks.len(),
            page_count: self.page_count,
            slide_count: self.slide_count,
            sheet_count: self.sheet_count,
            asset_count: self.assets.len(),
            warnings: &self.warnings,
            outline: &self.outline,
            assets: &self.assets,
        }
    }
}

pub(crate) fn convert(
    source: PreparedSource,
    limits: EffectiveLimits,
    cancelled: &AtomicBool,
) -> Result<CachedDocument, CoreError> {
    checkpoint(cancelled)?;
    let PreparedSource {
        bytes,
        sha256,
        format,
        canonical_format,
        semantic_warning,
        format_hint_mismatch,
        xlsx_projection,
    } = source;
    let presentation = matches!(format, Format::Ppt | Format::Pptx | Format::Odp);
    let spreadsheet = matches!(format, Format::Excel | Format::Ods | Format::Csv);
    let mut builder = ChunkBuilder::new(limits, presentation, spreadsheet, cancelled);

    if let Some(projection) = xlsx_projection {
        builder.push_xlsx_projection(&projection)?;
    } else if format == Format::Pdf {
        let extracted =
            pdf_inspector::extract_pages_markdown_mem(&bytes, None).map_err(map_pdf_error)?;
        checkpoint(cancelled)?;
        for page in &extracted.pages {
            checkpoint(cancelled)?;
            builder.page = Some(page.page as usize + 1);
            if page.needs_ocr {
                builder.warn("partial_content");
            }
            if !page.markdown.trim().is_empty() {
                builder.push_markdown(&page.markdown)?;
            }
        }
        builder.page_count = Some(extracted.pages.len());
    } else {
        let document = anydoc::to_document(&bytes, format)?;
        checkpoint(cancelled)?;
        builder.push_document(document)?;
    }
    checkpoint(cancelled)?;

    if builder.chunks.is_empty() {
        return Err(CoreError::NoExtractableText);
    }
    if semantic_warning {
        builder.warn("partial_content");
    }
    if format_hint_mismatch {
        builder.warn("format_hint_mismatch");
    }
    if matches!(canonical_format.as_str(), "xls" | "xlsb" | "ods") {
        builder.warn("hidden_content_unverified");
    }
    let source_byte_count = bytes.len();
    let approximate_bytes = builder
        .chunks
        .iter()
        .map(|chunk| chunk.text.len() + chunk.heading.as_ref().map_or(0, String::len))
        .sum::<usize>()
        .saturating_add(builder.assets.len() * 160)
        .saturating_add(
            builder
                .asset_payloads
                .iter()
                .map(|asset| asset.bytes.len())
                .sum::<usize>(),
        )
        .saturating_add(builder.outline.len() * 96);
    Ok(CachedDocument {
        canonical_format,
        source_byte_count,
        source_char_count: builder.text_units,
        content_sha256: sha256,
        chunks: builder.chunks,
        outline: builder.outline,
        assets: builder.assets,
        asset_payloads: builder.asset_payloads,
        warnings: builder.warnings,
        slide_count: presentation.then_some(builder.slide.max(1)),
        sheet_count: spreadsheet.then_some(builder.sheet_count.max(1)),
        page_count: builder.page_count,
        approximate_bytes,
    })
}

fn map_pdf_error(error: pdf_inspector::PdfError) -> CoreError {
    match error {
        pdf_inspector::PdfError::Encrypted => CoreError::Encrypted,
        pdf_inspector::PdfError::NotAPdf(_)
        | pdf_inspector::PdfError::InvalidStructure
        | pdf_inspector::PdfError::Parse(_) => CoreError::Malformed,
        pdf_inspector::PdfError::Io(_) => CoreError::ConversionFailed,
        pdf_inspector::PdfError::ResourceLimit("cancelled") => CoreError::Cancelled,
        pdf_inspector::PdfError::ResourceLimit(limit) => CoreError::ResourceLimit(limit),
    }
}

struct ChunkBuilder<'a> {
    limits: EffectiveLimits,
    presentation: bool,
    spreadsheet: bool,
    cancelled: &'a AtomicBool,
    chunks: Vec<ContentChunk>,
    outline: Vec<OutlineEntry>,
    assets: Vec<AssetDescriptor>,
    asset_payloads: Vec<CachedAssetPayload>,
    warnings: Vec<String>,
    valid_assets: HashSet<usize>,
    heading: Option<String>,
    sheet: Option<String>,
    sheet_count: usize,
    slide: usize,
    page: Option<usize>,
    page_count: Option<usize>,
    text_units: usize,
    work_units: usize,
}

impl<'a> ChunkBuilder<'a> {
    fn new(
        limits: EffectiveLimits,
        presentation: bool,
        spreadsheet: bool,
        cancelled: &'a AtomicBool,
    ) -> Self {
        Self {
            limits,
            presentation,
            spreadsheet,
            cancelled,
            chunks: Vec::new(),
            outline: Vec::new(),
            assets: Vec::new(),
            asset_payloads: Vec::new(),
            warnings: Vec::new(),
            valid_assets: HashSet::new(),
            heading: None,
            sheet: None,
            sheet_count: 0,
            slide: 1,
            page: None,
            page_count: None,
            text_units: 0,
            work_units: 0,
        }
    }

    fn push_document(&mut self, document: model::Document) -> Result<(), CoreError> {
        let asset_total = document
            .assets
            .iter()
            .map(|asset| asset.bytes.len())
            .sum::<usize>();
        if asset_total > MAX_ASSET_BYTES {
            return Err(CoreError::ResourceLimit("max_asset_total_bytes"));
        }
        if document.assets.len() > MAX_ASSET_DESCRIPTORS {
            self.warn("assets_skipped");
        }
        for asset in document.assets.iter().take(MAX_ASSET_DESCRIPTORS) {
            checkpoint(self.cancelled)?;
            self.charge(asset.bytes.len().min(4_096))?;
            let media_type = asset.media_type.trim().to_ascii_lowercase();
            match validate_asset(&media_type, &asset.bytes) {
                Some((width, height)) => {
                    let sha256 = format!("{:x}", Sha256::digest(&asset.bytes));
                    if let Some(existing) = self
                        .assets
                        .iter()
                        .find(|existing| existing.id == asset.id.0)
                    {
                        if existing.media_type == media_type && existing.sha256 == sha256 {
                            continue;
                        }
                        return Err(CoreError::Malformed);
                    }
                    self.valid_assets.insert(asset.id.0);
                    self.assets.push(AssetDescriptor {
                        id: asset.id.0,
                        media_type: media_type.clone(),
                        byte_length: asset.bytes.len(),
                        sha256: sha256.clone(),
                        width: Some(width),
                        height: Some(height),
                    });
                    self.asset_payloads.push(CachedAssetPayload {
                        id: asset.id.0,
                        media_type,
                        bytes: asset.bytes.clone(),
                        sha256,
                        width,
                        height,
                    });
                }
                None => self.warn("assets_skipped"),
            }
        }
        self.push_blocks(&document.blocks)?;
        for note in &document.notes {
            checkpoint(self.cancelled)?;
            let old = self.heading.replace(format!("Note {}", note.id));
            self.push_blocks(&note.blocks)?;
            self.heading = old;
        }
        Ok(())
    }

    fn push_xlsx_projection(
        &mut self,
        projection: &crate::xlsx::XlsxProjection,
    ) -> Result<(), CoreError> {
        if projection.hidden_content_skipped {
            self.warn("hidden_rows_skipped");
        }
        if projection.lossy_fallback_used {
            self.warn("partial_content");
        }
        if projection.unsupported_assets {
            self.warn("unsupported_assets");
        }
        for sheet in &projection.sheets {
            checkpoint(self.cancelled)?;
            self.sheet_count += 1;
            self.sheet = Some(bounded_text(&sheet.name, 256));
            self.heading = Some(bounded_text(&sheet.name, 512));
            let heading_index = self.push_atomic("heading", &sheet.name, &[])?;
            if self.outline.len() < MAX_OUTLINE_ENTRIES {
                self.outline.push(OutlineEntry {
                    level: 2,
                    title: bounded_text(&sheet.name, 512),
                    chunk_index: heading_index,
                    slide_number: None,
                    sheet_name: self.sheet.clone(),
                });
            }
            let rows = sheet
                .rows
                .iter()
                .map(|row| {
                    row.iter()
                        .map(|value| model::Cell::from_inlines(vec![model::Inline::plain(value)]))
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>();
            let table = model::Table::from_rows(rows, sheet.header_rows, model::TableKind::Data);
            self.push_table(&table)?;
        }
        Ok(())
    }

    fn push_blocks(&mut self, blocks: &[Block]) -> Result<(), CoreError> {
        for block in blocks {
            checkpoint(self.cancelled)?;
            self.charge(1)?;
            match block {
                Block::Heading { level, content, .. } => {
                    let fragment = collect_inlines(content, &self.valid_assets);
                    self.apply_fragment_warnings(&fragment);
                    let text = fragment.text;
                    if text.trim().is_empty() {
                        continue;
                    }
                    let text = text.trim();
                    if self.spreadsheet && *level == 2 {
                        self.sheet_count += 1;
                        self.sheet = Some(bounded_text(text, 256));
                    }
                    self.heading = Some(bounded_text(text, 512));
                    let index =
                        self.push_text(self.kind("heading"), text, &fragment.asset_ids, false)?;
                    if self.outline.len() < MAX_OUTLINE_ENTRIES {
                        self.outline.push(OutlineEntry {
                            level: *level,
                            title: bounded_text(text, 512),
                            chunk_index: index,
                            slide_number: self.presentation.then_some(self.slide),
                            sheet_name: self.sheet.clone(),
                        });
                    }
                }
                Block::Paragraph(inlines) => {
                    let fragment = collect_inlines(inlines, &self.valid_assets);
                    self.apply_fragment_warnings(&fragment);
                    self.push_text(
                        self.kind("paragraph"),
                        &fragment.text,
                        &fragment.asset_ids,
                        true,
                    )?;
                }
                Block::List(list) => self.push_list(list)?,
                Block::Table(table) => self.push_table(table)?,
                Block::BlockQuote(nested) => {
                    let fragment = collect_blocks_fragment(nested, &self.valid_assets);
                    self.apply_fragment_warnings(&fragment);
                    self.push_text(
                        self.kind("paragraph"),
                        &fragment.text,
                        &fragment.asset_ids,
                        true,
                    )?;
                }
                Block::CodeBlock { text, .. } => {
                    if utf16_len(text) > MAX_CHUNK_CHARS {
                        return Err(CoreError::ResourceLimit("max_code_block_chars"));
                    }
                    self.push_atomic(self.kind("code"), text, &[])?;
                }
                Block::Rule if self.presentation => {
                    self.slide = self.slide.saturating_add(1);
                    self.heading = None;
                }
                Block::Rule => {}
            }
        }
        Ok(())
    }

    fn push_table(&mut self, table: &model::Table) -> Result<(), CoreError> {
        let mut rows = Vec::<TextFragment>::new();
        for row in &table.grid {
            checkpoint(self.cancelled)?;
            let mut fragment = TextFragment::default();
            let mut first = true;
            for slot in row {
                if !first {
                    fragment.text.push('\t');
                }
                first = false;
                if let CellSlot::Origin(cell) = slot {
                    fragment.merge(collect_blocks_fragment(&cell.blocks, &self.valid_assets));
                }
            }
            fragment.text = fragment.text.trim_end().to_string();
            if utf16_len(&fragment.text) > MAX_CHUNK_CHARS {
                return Err(CoreError::ResourceLimit("max_table_row_chars"));
            }
            self.apply_fragment_warnings(&fragment);
            rows.push(fragment);
        }
        let header_count = table.header_rows.min(rows.len());
        let header = pack_rows(&rows[..header_count]);
        if utf16_len(&header.text) > MAX_CHUNK_CHARS {
            return Err(CoreError::ResourceLimit("max_table_header_chars"));
        }
        let logical_units = utf16_len(pack_rows(&rows).text.trim());
        if self.text_units.saturating_add(logical_units) > self.limits.text_chars {
            return Err(CoreError::ResourceLimit("max_text_chars"));
        }
        // Count logical source rows exactly once. Repeated headers remain in
        // every stored chunk and are therefore still charged to work/cache,
        // but must not inflate sourceCharCount or the logical text ceiling.
        self.text_units += logical_units;
        let mut packed = header.clone();
        let mut has_data = false;
        for row in rows.iter().skip(header_count) {
            if utf16_len(&header.text)
                .saturating_add(usize::from(!header.text.is_empty()))
                .saturating_add(utf16_len(&row.text))
                > MAX_CHUNK_CHARS
            {
                return Err(CoreError::ResourceLimit("max_table_row_with_header_chars"));
            }
            let separator = usize::from(!packed.text.is_empty());
            if utf16_len(&packed.text)
                .saturating_add(separator)
                .saturating_add(utf16_len(&row.text))
                > MAX_CHUNK_CHARS
            {
                self.push_stored_atomic(self.kind("table"), &packed.text, &packed.asset_ids)?;
                packed = header.clone();
            }
            if !packed.text.is_empty() {
                packed.text.push('\n');
            }
            packed.merge(row.clone());
            has_data = true;
        }
        if has_data || (rows.len() == header_count && !packed.text.is_empty()) {
            self.push_stored_atomic(self.kind("table"), &packed.text, &packed.asset_ids)?;
        }
        Ok(())
    }

    fn push_list(&mut self, list: &model::List) -> Result<(), CoreError> {
        let mut packed = TextFragment::default();
        for (offset, item) in list.items.iter().enumerate() {
            checkpoint(self.cancelled)?;
            let mut item_fragment = TextFragment::default();
            let label = item
                .marker_label
                .clone()
                .unwrap_or_else(|| list.marker.label(list.start.saturating_add(offset as u64)));
            item_fragment.text.push_str(&label);
            item_fragment.text.push(' ');
            item_fragment.merge(collect_blocks_fragment(&item.blocks, &self.valid_assets));
            item_fragment.text = item_fragment.text.trim().to_string();
            self.apply_fragment_warnings(&item_fragment);
            if utf16_len(&item_fragment.text) > MAX_CHUNK_CHARS {
                return Err(CoreError::ResourceLimit("max_list_item_chars"));
            }
            let separator = usize::from(!packed.text.is_empty());
            if utf16_len(&packed.text)
                .saturating_add(separator)
                .saturating_add(utf16_len(&item_fragment.text))
                > MAX_CHUNK_CHARS
            {
                self.push_atomic(self.kind("list"), &packed.text, &packed.asset_ids)?;
                packed = TextFragment::default();
            }
            if !packed.text.is_empty() {
                packed.text.push('\n');
            }
            packed.merge(item_fragment);
        }
        if !packed.text.is_empty() {
            self.push_atomic(self.kind("list"), &packed.text, &packed.asset_ids)?;
        }
        Ok(())
    }

    fn push_markdown(&mut self, markdown: &str) -> Result<(), CoreError> {
        let mut paragraph = String::new();
        for line in markdown.lines() {
            checkpoint(self.cancelled)?;
            self.charge(1)?;
            if let Some(title) = line.strip_prefix('#') {
                if !paragraph.trim().is_empty() {
                    self.push_text("paragraph", &paragraph, &[], true)?;
                    paragraph.clear();
                }
                let title = title.trim_start_matches('#').trim();
                if !title.is_empty() {
                    self.heading = Some(bounded_text(title, 512));
                    let index = self.push_text("heading", title, &[], false)?;
                    if self.outline.len() < MAX_OUTLINE_ENTRIES {
                        self.outline.push(OutlineEntry {
                            level: line
                                .bytes()
                                .take_while(|byte| *byte == b'#')
                                .count()
                                .min(255) as u8,
                            title: bounded_text(title, 512),
                            chunk_index: index,
                            slide_number: None,
                            sheet_name: None,
                        });
                    }
                }
            } else if line.trim().is_empty() {
                if !paragraph.trim().is_empty() {
                    self.push_text("paragraph", &paragraph, &[], true)?;
                    paragraph.clear();
                }
            } else {
                if !paragraph.is_empty() {
                    paragraph.push('\n');
                }
                paragraph.push_str(line);
            }
        }
        if !paragraph.trim().is_empty() {
            self.push_text("paragraph", &paragraph, &[], true)?;
        }
        Ok(())
    }

    fn kind(&self, base: &'static str) -> &'static str {
        if self.presentation {
            "slide"
        } else if self.spreadsheet && base == "table" {
            "sheet"
        } else {
            base
        }
    }

    fn push_text(
        &mut self,
        kind: &str,
        text: &str,
        asset_ids: &[usize],
        overlap_prose: bool,
    ) -> Result<usize, CoreError> {
        let text = text.trim();
        if text.is_empty() {
            return Ok(self.chunks.len());
        }
        let source_units = utf16_len(text);
        if self.text_units.saturating_add(source_units) > self.limits.text_chars {
            return Err(CoreError::ResourceLimit("max_text_chars"));
        }
        // Count the logical source exactly once. Stored overlap is accounted
        // by the work and cache budgets, but must not inflate sourceCharCount.
        self.text_units += source_units;
        let first_index = self.chunks.len();
        let mut remaining = text;
        while !remaining.is_empty() {
            checkpoint(self.cancelled)?;
            if self.chunks.len() >= self.limits.chunks {
                return Err(CoreError::ResourceLimit("max_chunks"));
            }
            let (part, rest) = split_utf16(remaining, MAX_CHUNK_CHARS);
            let part = part.trim();
            if !part.is_empty() {
                let units = utf16_len(part);
                self.charge(units)?;
                let index = self.chunks.len();
                let chunk_asset_ids = asset_ids_for_text(part, asset_ids);
                self.chunks.push(ContentChunk {
                    index,
                    text: part.to_string(),
                    kind: kind.to_string(),
                    asset_ids: chunk_asset_ids,
                    heading: self.heading.clone(),
                    page_number: self.page,
                    slide_number: self.presentation.then_some(self.slide),
                    sheet_name: if self.spreadsheet {
                        Some(self.sheet.clone().unwrap_or_else(|| "Sheet 1".to_string()))
                    } else {
                        None
                    },
                });
            }
            if rest.is_empty() {
                break;
            }
            remaining = if overlap_prose {
                let overlap_start = overlap_start_utf16(part, PROSE_CHUNK_OVERLAP_CHARS);
                // `part` is a prefix of `remaining`; start the next chunk in
                // that suffix so it naturally continues into `rest` without
                // copying or invalid UTF-8/UTF-16 boundaries.
                remaining.get(overlap_start..).unwrap_or(rest).trim_start()
            } else {
                rest.trim_start()
            };
        }
        Ok(first_index)
    }

    fn push_atomic(
        &mut self,
        kind: &str,
        text: &str,
        asset_ids: &[usize],
    ) -> Result<usize, CoreError> {
        self.push_atomic_inner(kind, text, asset_ids, true)
    }

    fn push_stored_atomic(
        &mut self,
        kind: &str,
        text: &str,
        asset_ids: &[usize],
    ) -> Result<usize, CoreError> {
        self.push_atomic_inner(kind, text, asset_ids, false)
    }

    fn push_atomic_inner(
        &mut self,
        kind: &str,
        text: &str,
        asset_ids: &[usize],
        count_logical_source: bool,
    ) -> Result<usize, CoreError> {
        let text = text.trim();
        if text.is_empty() {
            return Ok(self.chunks.len());
        }
        let units = utf16_len(text);
        if units > MAX_CHUNK_CHARS {
            return Err(CoreError::ResourceLimit("max_structural_chunk_chars"));
        }
        if self.chunks.len() >= self.limits.chunks {
            return Err(CoreError::ResourceLimit("max_chunks"));
        }
        if count_logical_source && self.text_units.saturating_add(units) > self.limits.text_chars {
            return Err(CoreError::ResourceLimit("max_text_chars"));
        }
        self.charge(units)?;
        let index = self.chunks.len();
        if count_logical_source {
            self.text_units += units;
        }
        self.chunks.push(ContentChunk {
            index,
            text: text.to_string(),
            kind: kind.to_string(),
            asset_ids: asset_ids.to_vec(),
            heading: self.heading.clone(),
            page_number: self.page,
            slide_number: self.presentation.then_some(self.slide),
            sheet_name: if self.spreadsheet {
                Some(self.sheet.clone().unwrap_or_else(|| "Sheet 1".to_string()))
            } else {
                None
            },
        });
        Ok(index)
    }

    fn apply_fragment_warnings(&mut self, fragment: &TextFragment) {
        if fragment.unsupported_asset {
            self.warn("unsupported_assets");
        }
        if fragment.missing_asset {
            self.warn("assets_skipped");
        }
    }

    fn charge(&mut self, units: usize) -> Result<(), CoreError> {
        self.work_units = self.work_units.saturating_add(units);
        if self.work_units > self.limits.work_units {
            Err(CoreError::ResourceLimit("max_work_units"))
        } else {
            Ok(())
        }
    }

    fn warn(&mut self, code: &str) {
        if !self.warnings.iter().any(|warning| warning == code) {
            self.warnings.push(code.to_string());
        }
    }
}

#[derive(Clone, Default)]
struct TextFragment {
    text: String,
    asset_ids: Vec<usize>,
    unsupported_asset: bool,
    missing_asset: bool,
}

impl TextFragment {
    fn merge(&mut self, other: TextFragment) {
        self.text.push_str(&other.text);
        self.asset_ids.extend(other.asset_ids);
        self.asset_ids.sort_unstable();
        self.asset_ids.dedup();
        self.unsupported_asset |= other.unsupported_asset;
        self.missing_asset |= other.missing_asset;
    }
}

fn collect_inlines(inlines: &[model::Inline], valid_assets: &HashSet<usize>) -> TextFragment {
    let mut fragment = TextFragment::default();
    for inline in inlines {
        match inline {
            model::Inline::Text { text, .. } => fragment.text.push_str(text),
            model::Inline::Link { content, .. } => {
                fragment.merge(collect_inlines(content, valid_assets))
            }
            model::Inline::Image { alt, source } => {
                let alt = placeholder_text(alt);
                match source {
                    model::ImageSource::Asset(id) if valid_assets.contains(&id.0) => {
                        fragment
                            .text
                            .push_str(&format!("[asset:{} alt=\"{}\"]", id.0, alt));
                        fragment.asset_ids.push(id.0);
                    }
                    model::ImageSource::External(_) => {
                        fragment
                            .text
                            .push_str(&format!("[external image omitted alt=\"{}\"]", alt));
                        fragment.unsupported_asset = true;
                    }
                    model::ImageSource::Asset(_) | model::ImageSource::Unavailable => {
                        fragment
                            .text
                            .push_str(&format!("[image unavailable alt=\"{}\"]", alt));
                        fragment.missing_asset = true;
                    }
                }
            }
            model::Inline::Anchor(_) | model::Inline::NoteRef(_) => {}
            model::Inline::LineBreak => fragment.text.push('\n'),
        }
    }
    fragment.asset_ids.sort_unstable();
    fragment.asset_ids.dedup();
    fragment
}

fn collect_blocks_fragment(blocks: &[Block], valid_assets: &HashSet<usize>) -> TextFragment {
    let mut output = TextFragment::default();
    for block in blocks {
        let mut next = TextFragment::default();
        match block {
            Block::Heading { content, .. } | Block::Paragraph(content) => {
                next = collect_inlines(content, valid_assets);
            }
            Block::List(list) => {
                for (offset, item) in list.items.iter().enumerate() {
                    if !next.text.is_empty() {
                        next.text.push('\n');
                    }
                    next.text
                        .push_str(&item.marker_label.clone().unwrap_or_else(|| {
                            list.marker.label(list.start.saturating_add(offset as u64))
                        }));
                    next.text.push(' ');
                    next.merge(collect_blocks_fragment(&item.blocks, valid_assets));
                }
            }
            Block::Table(table) => {
                for row in &table.grid {
                    for (column, slot) in row.iter().enumerate() {
                        if column > 0 {
                            next.text.push('\t');
                        }
                        if let CellSlot::Origin(cell) = slot {
                            next.merge(collect_blocks_fragment(&cell.blocks, valid_assets));
                        }
                    }
                    next.text.push('\n');
                }
            }
            Block::BlockQuote(nested) => next = collect_blocks_fragment(nested, valid_assets),
            Block::CodeBlock { text, .. } => next.text.push_str(text),
            Block::Rule => next.text.push('\n'),
        }
        if !output.text.is_empty()
            && !output
                .text
                .chars()
                .last()
                .is_some_and(|value| matches!(value, '\n' | ' ' | '\t'))
        {
            output.text.push(' ');
        }
        output.merge(next);
    }
    output
}

fn pack_rows(rows: &[TextFragment]) -> TextFragment {
    let mut output = TextFragment::default();
    for row in rows {
        if !output.text.is_empty() {
            output.text.push('\n');
        }
        output.merge(row.clone());
    }
    output
}

fn placeholder_text(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| match character {
            '"' | ']' | '[' => ' ',
            value if value.is_control() => ' ',
            value => value,
        })
        .collect::<String>();
    bounded_text(&sanitized, 256)
}

pub(crate) fn validate_asset(media_type: &str, bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.is_empty() || bytes.len() > MAX_ASSET_BYTES {
        return None;
    }
    let dimensions = match media_type.to_ascii_lowercase().as_str() {
        "image/png" => png_dimensions(bytes),
        "image/gif"
            if (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"))
                && bytes.len() >= 10 =>
        {
            Some((
                u16::from_le_bytes(bytes[6..8].try_into().ok()?) as u32,
                u16::from_le_bytes(bytes[8..10].try_into().ok()?) as u32,
            ))
        }
        "image/jpeg" if bytes.starts_with(&[0xff, 0xd8, 0xff]) => jpeg_dimensions(bytes),
        "image/webp" => webp_dimensions(bytes),
        _ => None,
    }?;
    let (width, height) = dimensions;
    if width == 0
        || height == 0
        || width > 16_384
        || height > 16_384
        || (width as u64).saturating_mul(height as u64) > 40_000_000
    {
        return None;
    }
    Some((width, height))
}

fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    // PNG requires IHDR to be the first chunk and its data length is exactly
    // 13 bytes. Require the complete chunk including CRC before trusting its
    // width/height fields; full image decode is intentionally out of scope.
    if bytes.len() < 33
        || !bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || u32::from_be_bytes(bytes[8..12].try_into().ok()?) != 13
        || &bytes[12..16] != b"IHDR"
    {
        return None;
    }
    Some((
        u32::from_be_bytes(bytes[16..20].try_into().ok()?),
        u32::from_be_bytes(bytes[20..24].try_into().ok()?),
    ))
}

fn webp_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 20 || !bytes.starts_with(b"RIFF") || &bytes[8..12] != b"WEBP" {
        return None;
    }
    let riff_size = u32::from_le_bytes(bytes[4..8].try_into().ok()?) as usize;
    let riff_end = riff_size.checked_add(8)?;
    if riff_size < 12 || riff_end != bytes.len() {
        return None;
    }
    let chunk_size = u32::from_le_bytes(bytes[16..20].try_into().ok()?) as usize;
    let data_end = 20usize.checked_add(chunk_size)?;
    let padded_end = data_end.checked_add(chunk_size & 1)?;
    if data_end > riff_end || padded_end > riff_end {
        return None;
    }
    let data = &bytes[20..data_end];
    match &bytes[12..16] {
        b"VP8X" if chunk_size == 10 => Some((
            1 + u32::from_le_bytes([data[4], data[5], data[6], 0]),
            1 + u32::from_le_bytes([data[7], data[8], data[9], 0]),
        )),
        b"VP8 " if data.len() >= 10 && data[3..6] == [0x9d, 0x01, 0x2a] => Some((
            (u16::from_le_bytes(data[6..8].try_into().ok()?) & 0x3fff) as u32,
            (u16::from_le_bytes(data[8..10].try_into().ok()?) & 0x3fff) as u32,
        )),
        b"VP8L" if data.len() >= 5 && data[0] == 0x2f => {
            let bits = u32::from_le_bytes(data[1..5].try_into().ok()?);
            if bits >> 29 != 0 {
                return None;
            }
            Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
        }
        _ => None,
    }
}

fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut offset = 2_usize;
    while offset + 9 < bytes.len() {
        if bytes[offset] != 0xff {
            offset += 1;
            continue;
        }
        let marker = bytes[offset + 1];
        offset += 2;
        if matches!(marker, 0xd8 | 0xd9) {
            continue;
        }
        if offset + 2 > bytes.len() {
            return None;
        }
        let length = u16::from_be_bytes(bytes[offset..offset + 2].try_into().ok()?) as usize;
        if length < 2 || offset + length > bytes.len() {
            return None;
        }
        if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) && length >= 7 {
            let height = u16::from_be_bytes(bytes[offset + 3..offset + 5].try_into().ok()?) as u32;
            let width = u16::from_be_bytes(bytes[offset + 5..offset + 7].try_into().ok()?) as u32;
            return Some((width, height));
        }
        offset += length;
    }
    None
}

pub(crate) fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn bounded_text(value: &str, maximum: usize) -> String {
    split_utf16(value, maximum).0.trim().to_string()
}

fn split_utf16(value: &str, maximum: usize) -> (&str, &str) {
    if utf16_len(value) <= maximum {
        return (value, "");
    }
    let mut units = 0_usize;
    let mut hard_end = 0_usize;
    let mut soft_end = None;
    for (index, character) in value.char_indices() {
        let next = units + character.len_utf16();
        if next > maximum {
            break;
        }
        units = next;
        hard_end = index + character.len_utf8();
        if character.is_whitespace() && units >= maximum / 2 {
            soft_end = Some(hard_end);
        }
    }
    let end = soft_end.unwrap_or(hard_end).max(1);
    value.split_at(end)
}

fn overlap_start_utf16(value: &str, maximum: usize) -> usize {
    let mut units = 0_usize;
    let mut start = value.len();
    for (index, character) in value.char_indices().rev() {
        let next = units.saturating_add(character.len_utf16());
        if next > maximum {
            break;
        }
        units = next;
        start = index;
    }
    // A split part is normally far larger than the overlap. Keep a strict
    // forward-progress guard for reduced test/config limits as well.
    if start == 0 && !value.is_empty() {
        value
            .char_indices()
            .nth(1)
            .map_or(value.len(), |(index, _)| index)
    } else {
        start
    }
}

fn asset_ids_for_text(text: &str, candidates: &[usize]) -> Vec<usize> {
    candidates
        .iter()
        .copied()
        .filter(|id| text.contains(&format!("[asset:{id} alt=\"")))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use anydoc::model::{Document, Inline};
    use std::sync::atomic::AtomicBool;

    #[test]
    fn presentation_rule_advances_slide_locator() {
        let cancelled = AtomicBool::new(false);
        let mut builder = ChunkBuilder::new(EffectiveLimits::default(), true, false, &cancelled);
        builder
            .push_document(Document {
                blocks: vec![
                    Block::Paragraph(vec![Inline::plain("first")]),
                    Block::Rule,
                    Block::Paragraph(vec![Inline::plain("second")]),
                ],
                ..Document::default()
            })
            .unwrap();
        assert_eq!(builder.chunks[0].slide_number, Some(1));
        assert_eq!(builder.chunks[1].slide_number, Some(2));
    }

    #[test]
    fn chunk_bound_is_utf16_not_scalar_count() {
        let input = "😀".repeat(MAX_CHUNK_CHARS);
        let (first, rest) = split_utf16(&input, MAX_CHUNK_CHARS);
        assert_eq!(utf16_len(first), MAX_CHUNK_CHARS);
        assert_eq!(utf16_len(rest), MAX_CHUNK_CHARS);
    }

    #[test]
    fn prose_overlap_preserves_boundary_phrase_and_unique_source_count() {
        let cancelled = AtomicBool::new(false);
        let mut builder = ChunkBuilder::new(EffectiveLimits::default(), false, false, &cancelled);
        let input = format!("{}boundary phrase{}", "x".repeat(3_995), "z".repeat(128));
        builder.push_text("paragraph", &input, &[], true).unwrap();
        assert_eq!(builder.chunks.len(), 2);
        assert!(builder.chunks[1].text.contains("boundary phrase"));
        assert_eq!(builder.text_units, utf16_len(&input));
        assert!(
            builder
                .chunks
                .iter()
                .all(|chunk| utf16_len(&chunk.text) <= MAX_CHUNK_CHARS)
        );
    }

    #[test]
    fn prose_overlap_is_surrogate_safe_and_asset_ids_follow_placeholders() {
        let cancelled = AtomicBool::new(false);
        let mut builder = ChunkBuilder::new(EffectiveLimits::default(), false, false, &cancelled);
        let input = format!(
            "[asset:1 alt=\"first\"]{}[asset:2 alt=\"second\"]{}",
            "😀".repeat(2_100),
            "tail".repeat(64),
        );
        builder
            .push_text("paragraph", &input, &[1, 2], true)
            .unwrap();
        assert!(builder.chunks.len() >= 2);
        assert_eq!(builder.chunks[0].asset_ids, vec![1]);
        assert!(
            builder
                .chunks
                .iter()
                .skip(1)
                .any(|chunk| chunk.asset_ids == vec![2])
        );
        assert!(
            builder
                .chunks
                .iter()
                .all(|chunk| utf16_len(&chunk.text) <= MAX_CHUNK_CHARS)
        );
        assert_eq!(builder.text_units, utf16_len(&input));
    }

    #[test]
    fn repeated_table_headers_charge_storage_but_not_logical_source_units() {
        let header = "H".repeat(500);
        let first = "A".repeat(3_000);
        let second = "B".repeat(3_000);
        let logical_units = utf16_len(&header) + utf16_len(&first) + utf16_len(&second) + 2;
        let limits = EffectiveLimits {
            text_chars: logical_units,
            ..EffectiveLimits::default()
        };
        let cancelled = AtomicBool::new(false);
        let mut builder = ChunkBuilder::new(limits, false, false, &cancelled);
        let table = model::Table::from_rows(
            vec![
                vec![model::Cell::from_inlines(vec![Inline::plain(&header)])],
                vec![model::Cell::from_inlines(vec![Inline::plain(&first)])],
                vec![model::Cell::from_inlines(vec![Inline::plain(&second)])],
            ],
            1,
            model::TableKind::Data,
        );

        builder.push_table(&table).unwrap();

        assert_eq!(builder.chunks.len(), 2);
        assert!(
            builder
                .chunks
                .iter()
                .all(|chunk| chunk.text.starts_with(&header))
        );
        assert_eq!(builder.text_units, logical_units);
        assert!(
            builder
                .chunks
                .iter()
                .map(|chunk| utf16_len(&chunk.text))
                .sum::<usize>()
                > logical_units
        );
    }

    fn webp_chunk(kind: &[u8; 4], mut data: Vec<u8>) -> Vec<u8> {
        let data_len = data.len();
        if data_len & 1 == 1 {
            data.push(0);
        }
        let riff_size = 4 + 8 + data.len();
        let mut bytes = Vec::with_capacity(riff_size + 8);
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(riff_size as u32).to_le_bytes());
        bytes.extend_from_slice(b"WEBP");
        bytes.extend_from_slice(kind);
        bytes.extend_from_slice(&(data_len as u32).to_le_bytes());
        bytes.extend_from_slice(&data);
        bytes
    }

    #[test]
    fn png_requires_a_complete_first_ihdr_chunk() {
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&320u32.to_be_bytes());
        png.extend_from_slice(&240u32.to_be_bytes());
        png.extend_from_slice(&[8, 2, 0, 0, 0]);
        png.extend_from_slice(&[0; 4]);
        assert_eq!(validate_asset("image/png", &png), Some((320, 240)));

        let mut fabricated = b"\x89PNG\r\n\x1a\n".to_vec();
        fabricated.resize(24, 0);
        fabricated[16..20].copy_from_slice(&320u32.to_be_bytes());
        fabricated[20..24].copy_from_slice(&240u32.to_be_bytes());
        assert_eq!(validate_asset("image/png", &fabricated), None);
    }

    #[test]
    fn all_advertised_webp_bitstreams_have_bounded_dimensions() {
        let mut vp8x = vec![0; 10];
        vp8x[4..7].copy_from_slice(&[63, 1, 0]); // 320 - 1
        vp8x[7..10].copy_from_slice(&[239, 0, 0]); // 240 - 1
        assert_eq!(
            validate_asset("image/webp", &webp_chunk(b"VP8X", vp8x)),
            Some((320, 240))
        );

        let mut vp8 = vec![0; 10];
        vp8[3..6].copy_from_slice(&[0x9d, 0x01, 0x2a]);
        vp8[6..8].copy_from_slice(&320u16.to_le_bytes());
        vp8[8..10].copy_from_slice(&240u16.to_le_bytes());
        assert_eq!(
            validate_asset("image/webp", &webp_chunk(b"VP8 ", vp8)),
            Some((320, 240))
        );

        let packed = (319u32) | (239u32 << 14);
        let mut vp8l = vec![0x2f];
        vp8l.extend_from_slice(&packed.to_le_bytes());
        assert_eq!(
            validate_asset("image/webp", &webp_chunk(b"VP8L", vp8l)),
            Some((320, 240))
        );
    }

    #[test]
    fn webp_riff_and_first_chunk_bounds_are_exact() {
        let mut valid = webp_chunk(b"VP8L", vec![0x2f, 0, 0, 0, 0]);
        valid[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(validate_asset("image/webp", &valid), None);

        let mut truncated = webp_chunk(b"VP8X", vec![0; 10]);
        truncated.pop();
        assert_eq!(validate_asset("image/webp", &truncated), None);
    }
}
