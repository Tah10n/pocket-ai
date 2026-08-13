use std::collections::{BTreeMap, HashMap};
use std::io::{Cursor, Read};
use std::sync::atomic::AtomicBool;

use chrono::{Duration, NaiveDate};
use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};
use zip::ZipArchive;

use crate::error::CoreError;
use crate::limits::MAX_SPREADSHEET_CELLS;
use crate::preflight::checkpoint;

const MAX_XML_BYTES: u64 = 8 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 4_096;
const MAX_XML_DEPTH: usize = 128;
const MAX_XML_NODES: usize = 100_000;
const MAX_SHEETS: usize = 128;
const MAX_ROWS: usize = 50_000;
const MAX_COLUMNS: usize = 512;
const MAX_CELLS: usize = MAX_SPREADSHEET_CELLS;

type ResolvedSheetParts = (Vec<(String, String)>, bool, bool);

#[derive(Debug)]
pub(crate) struct XlsxProjection {
    pub sheets: Vec<ProjectedSheet>,
    pub hidden_content_skipped: bool,
    pub lossy_fallback_used: bool,
    pub unsupported_assets: bool,
}

#[derive(Debug)]
pub(crate) struct ProjectedSheet {
    pub name: String,
    pub rows: Vec<Vec<String>>,
    pub header_rows: usize,
}

#[derive(Clone, Debug)]
enum NumberFormat {
    General,
    Number {
        decimals: usize,
        grouped: bool,
    },
    Percent {
        decimals: usize,
    },
    Currency {
        decimals: usize,
        grouped: bool,
        symbol: String,
        accounting: bool,
    },
    Date {
        date: bool,
        time: bool,
    },
    Unsupported,
}

#[derive(Default)]
struct CellState {
    reference: String,
    kind: String,
    style: usize,
    value: String,
    inline_text: String,
}

#[derive(Clone, Copy)]
enum Capture {
    Value,
    Text,
}

struct ProjectionBudget<'a> {
    cancelled: &'a AtomicBool,
    work: usize,
    maximum_work: usize,
    decompressed: u64,
    xml_nodes: usize,
    xml_depth: usize,
}

impl<'a> ProjectionBudget<'a> {
    fn new(cancelled: &'a AtomicBool, maximum_work: usize) -> Self {
        Self {
            cancelled,
            work: 0,
            maximum_work: maximum_work.max(1),
            decompressed: 0,
            xml_nodes: 0,
            xml_depth: 0,
        }
    }

    fn charge(&mut self, units: usize) -> Result<(), CoreError> {
        checkpoint(self.cancelled)?;
        self.work = self.work.saturating_add(units);
        if self.work > self.maximum_work {
            Err(CoreError::ResourceLimit("max_work_units"))
        } else {
            Ok(())
        }
    }

    fn decompressed(&mut self, bytes: usize) -> Result<(), CoreError> {
        self.decompressed = self.decompressed.saturating_add(bytes as u64);
        if self.decompressed > MAX_ARCHIVE_BYTES {
            return Err(CoreError::ResourceLimit("max_archive_total_bytes"));
        }
        self.charge(bytes.div_ceil(4_096).max(1))
    }

    fn xml_event(&mut self, event: &Event<'_>) -> Result<(), CoreError> {
        self.charge(1)?;
        match event {
            Event::Start(_) => {
                self.xml_nodes = self.xml_nodes.saturating_add(1);
                self.xml_depth = self.xml_depth.saturating_add(1);
            }
            Event::Empty(_) => self.xml_nodes = self.xml_nodes.saturating_add(1),
            Event::End(_) => {
                self.xml_depth = self.xml_depth.checked_sub(1).ok_or(CoreError::Malformed)?;
            }
            _ => {}
        }
        if self.xml_nodes > MAX_XML_NODES {
            return Err(CoreError::ResourceLimit("max_xml_nodes"));
        }
        if self.xml_depth > MAX_XML_DEPTH {
            return Err(CoreError::ResourceLimit("max_xml_depth"));
        }
        Ok(())
    }

    fn finish_xml(&self) -> Result<(), CoreError> {
        if self.xml_depth == 0 {
            Ok(())
        } else {
            Err(CoreError::Malformed)
        }
    }
}

pub(crate) fn project(
    bytes: &[u8],
    allow_lossy: bool,
    cancelled: &AtomicBool,
    max_work_units: usize,
) -> Result<XlsxProjection, CoreError> {
    let mut budget = ProjectionBudget::new(cancelled, max_work_units);
    budget.charge(1)?;
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|_| CoreError::Malformed)?;
    validate_archive(&mut archive, &mut budget)?;
    let styles_xml = read_entry(&mut archive, "xl/styles.xml", &mut budget)?;
    let styles = styles_xml
        .as_deref()
        .map(|xml| parse_styles(xml, &mut budget))
        .transpose()?
        .unwrap_or_else(|| vec![NumberFormat::General]);
    let shared_xml = read_entry(&mut archive, "xl/sharedStrings.xml", &mut budget)?;
    let shared_strings = shared_xml
        .as_deref()
        .map(|xml| parse_shared_strings(xml, &mut budget))
        .transpose()?
        .unwrap_or_default();
    let workbook = read_entry(&mut archive, "xl/workbook.xml", &mut budget)?;
    let relationships = read_entry(&mut archive, "xl/_rels/workbook.xml.rels", &mut budget)?;
    let (parts, date_1904, hidden_sheets) = resolve_sheet_parts(
        &archive,
        workbook.as_deref(),
        relationships.as_deref(),
        &mut budget,
    )?;
    if parts.len() > MAX_SHEETS {
        return Err(CoreError::ResourceLimit("max_sheets"));
    }
    let unsupported_assets = archive
        .file_names()
        .any(|name| name.to_ascii_lowercase().starts_with("xl/media/"));
    let mut sheets = Vec::new();
    let mut hidden_content_skipped = hidden_sheets;
    let mut lossy_fallback_used = false;
    for (name, path) in parts {
        budget.charge(1)?;
        let Some(xml) = read_entry(&mut archive, &path, &mut budget)? else {
            return Err(CoreError::Malformed);
        };
        let (rows, hidden, lossy) = parse_worksheet(
            &xml,
            &styles,
            &shared_strings,
            allow_lossy,
            date_1904,
            &mut budget,
        )?;
        hidden_content_skipped |= hidden;
        lossy_fallback_used |= lossy;
        if !rows.is_empty() {
            let header_rows =
                usize::from(rows.len() > 1 && rows[0].iter().any(|cell| !cell.trim().is_empty()));
            sheets.push(ProjectedSheet {
                name: bounded_name(&name),
                rows,
                header_rows,
            });
        }
    }
    Ok(XlsxProjection {
        sheets,
        hidden_content_skipped,
        lossy_fallback_used,
        unsupported_assets,
    })
}

fn validate_archive(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    budget: &mut ProjectionBudget<'_>,
) -> Result<(), CoreError> {
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(CoreError::ResourceLimit("max_archive_entries"));
    }
    let mut declared_total = 0_u64;
    for index in 0..archive.len() {
        budget.charge(1)?;
        let entry = archive.by_index(index).map_err(|_| CoreError::Malformed)?;
        if entry.size() > MAX_XML_BYTES {
            return Err(CoreError::ResourceLimit("max_archive_entry_bytes"));
        }
        declared_total = declared_total.saturating_add(entry.size());
        if declared_total > MAX_ARCHIVE_BYTES {
            return Err(CoreError::ResourceLimit("max_archive_total_bytes"));
        }
    }
    Ok(())
}

fn read_entry(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    name: &str,
    budget: &mut ProjectionBudget<'_>,
) -> Result<Option<Vec<u8>>, CoreError> {
    let Ok(mut entry) = archive.by_name(name) else {
        return Ok(None);
    };
    if entry.size() > MAX_XML_BYTES {
        return Err(CoreError::ResourceLimit("max_spreadsheet_xml_bytes"));
    }
    let mut output = Vec::with_capacity(entry.size() as usize);
    let mut block = [0_u8; 64 * 1024];
    loop {
        budget.charge(1)?;
        let read = entry.read(&mut block).map_err(|_| CoreError::Malformed)?;
        if read == 0 {
            break;
        }
        if output.len().saturating_add(read) as u64 > MAX_XML_BYTES {
            return Err(CoreError::ResourceLimit("max_archive_entry_bytes"));
        }
        budget.decompressed(read)?;
        output.extend_from_slice(&block[..read]);
    }
    Ok(Some(output))
}

fn resolve_sheet_parts(
    archive: &ZipArchive<Cursor<&[u8]>>,
    workbook: Option<&[u8]>,
    relationships: Option<&[u8]>,
    budget: &mut ProjectionBudget<'_>,
) -> Result<ResolvedSheetParts, CoreError> {
    let relations = relationships
        .map(|xml| parse_relationships(xml, budget))
        .transpose()?
        .unwrap_or_default();
    if let Some(workbook) = workbook {
        let metadata = parse_workbook(workbook, budget)?;
        let mut output = Vec::new();
        let mut hidden = false;
        let mut visible = 0_usize;
        for sheet in metadata.sheets {
            if sheet.hidden {
                hidden = true;
                continue;
            }
            visible += 1;
            if let Some(target) = relations
                .get(&sheet.relation)
                .and_then(|value| normalize_sheet_target(value))
            {
                output.push((sheet.name, target));
            }
        }
        if visible == 0 {
            return Ok((Vec::new(), metadata.date_1904, hidden));
        }
        if output.len() != visible {
            return Err(CoreError::Malformed);
        }
        return Ok((output, metadata.date_1904, hidden));
    }
    let mut names = archive
        .file_names()
        .filter(|name| {
            let lower = name.to_ascii_lowercase();
            lower.starts_with("xl/worksheets/") && lower.ends_with(".xml")
        })
        .map(str::to_string)
        .collect::<Vec<_>>();
    names.sort();
    Ok((
        names
            .into_iter()
            .enumerate()
            .map(|(index, path)| (format!("Sheet {}", index + 1), path))
            .collect(),
        false,
        false,
    ))
}

struct WorkbookSheet {
    name: String,
    relation: String,
    hidden: bool,
}

struct WorkbookMetadata {
    sheets: Vec<WorkbookSheet>,
    date_1904: bool,
}

fn parse_workbook(
    xml: &[u8],
    budget: &mut ProjectionBudget<'_>,
) -> Result<WorkbookMetadata, CoreError> {
    let mut reader = Reader::from_reader(Cursor::new(xml));
    let mut buffer = Vec::new();
    let mut sheets = Vec::new();
    let mut date_1904 = false;
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|_| CoreError::Malformed)?;
        budget.xml_event(&event)?;
        match event {
            Event::Start(event) | Event::Empty(event)
                if local_name(event.name().as_ref()) == b"workbookPr" =>
            {
                date_1904 = attr_bool(&event, b"date1904");
            }
            Event::Start(event) | Event::Empty(event)
                if local_name(event.name().as_ref()) == b"sheet" =>
            {
                let name = attr_string(&event, b"name").ok_or(CoreError::Malformed)?;
                let relation = attr_string(&event, b"id").ok_or(CoreError::Malformed)?;
                let hidden = matches!(
                    attr_string(&event, b"state").as_deref(),
                    Some("hidden" | "veryHidden")
                );
                sheets.push(WorkbookSheet {
                    name,
                    relation,
                    hidden,
                });
            }
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
    budget.finish_xml()?;
    Ok(WorkbookMetadata { sheets, date_1904 })
}

fn parse_relationships(
    xml: &[u8],
    budget: &mut ProjectionBudget<'_>,
) -> Result<HashMap<String, String>, CoreError> {
    let mut reader = Reader::from_reader(Cursor::new(xml));
    let mut buffer = Vec::new();
    let mut relationships = HashMap::new();
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|_| CoreError::Malformed)?;
        budget.xml_event(&event)?;
        match event {
            Event::Start(event) | Event::Empty(event)
                if local_name(event.name().as_ref()) == b"Relationship" =>
            {
                if attr_string(&event, b"TargetMode").as_deref() == Some("External") {
                    buffer.clear();
                    continue;
                }
                if let (Some(id), Some(target)) =
                    (attr_string(&event, b"Id"), attr_string(&event, b"Target"))
                {
                    relationships.insert(id, target);
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
    budget.finish_xml()?;
    Ok(relationships)
}

fn normalize_sheet_target(target: &str) -> Option<String> {
    let target = target.replace('\\', "/");
    if target.split('/').any(|segment| segment == "..") {
        return None;
    }
    let target = target.trim_start_matches('/');
    Some(if target.starts_with("xl/") {
        target.to_string()
    } else {
        format!("xl/{target}")
    })
}

fn parse_styles(
    xml: &[u8],
    budget: &mut ProjectionBudget<'_>,
) -> Result<Vec<NumberFormat>, CoreError> {
    let mut reader = Reader::from_reader(Cursor::new(xml));
    let mut buffer = Vec::new();
    let mut custom = HashMap::<u32, String>::new();
    let mut formats = Vec::new();
    let mut in_cell_xfs = false;
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|_| CoreError::Malformed)?;
        budget.xml_event(&event)?;
        match event {
            Event::Start(event) | Event::Empty(event) => {
                let qualified = event.name();
                match local_name(qualified.as_ref()) {
                    b"cellXfs" => in_cell_xfs = true,
                    b"numFmt" => {
                        if let (Some(id), Some(code)) = (
                            attr_u32(&event, b"numFmtId"),
                            attr_string(&event, b"formatCode"),
                        ) {
                            custom.insert(id, code);
                        }
                    }
                    b"xf" if in_cell_xfs => {
                        let id = attr_u32(&event, b"numFmtId").unwrap_or(0);
                        formats.push(classify_format(id, custom.get(&id).map(String::as_str)));
                    }
                    _ => {}
                }
            }
            Event::End(event) if local_name(event.name().as_ref()) == b"cellXfs" => {
                in_cell_xfs = false
            }
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
    budget.finish_xml()?;
    if formats.is_empty() {
        formats.push(NumberFormat::General);
    }
    Ok(formats)
}

fn classify_format(id: u32, custom: Option<&str>) -> NumberFormat {
    if let Some(code) = custom {
        return classify_custom(code);
    }
    match id {
        0 | 49 => NumberFormat::General,
        1 => NumberFormat::Number {
            decimals: 0,
            grouped: false,
        },
        2 => NumberFormat::Number {
            decimals: 2,
            grouped: false,
        },
        3 => NumberFormat::Number {
            decimals: 0,
            grouped: true,
        },
        4 | 37..=40 => NumberFormat::Number {
            decimals: usize::from(matches!(id, 4 | 39 | 40)) * 2,
            grouped: true,
        },
        5..=8 | 41..=44 => NumberFormat::Currency {
            decimals: usize::from(matches!(id, 7 | 8 | 43 | 44)) * 2,
            grouped: true,
            symbol: "$".to_string(),
            accounting: matches!(id, 5 | 6 | 41..=44),
        },
        9 => NumberFormat::Percent { decimals: 0 },
        10 => NumberFormat::Percent { decimals: 2 },
        14..=22 => NumberFormat::Date {
            date: !matches!(id, 18..=21),
            time: matches!(id, 18..=22),
        },
        _ => NumberFormat::Unsupported,
    }
}

fn classify_custom(code: &str) -> NumberFormat {
    if code.trim().eq_ignore_ascii_case("general") {
        return NumberFormat::General;
    }
    if is_biff_escaped_date_mask(code) {
        return NumberFormat::Date {
            date: true,
            time: false,
        };
    }
    let scan = scan_custom_format(code);
    if scan.unsupported_literal {
        return NumberFormat::Unsupported;
    }
    let primary = scan.tokens.split(';').next().unwrap_or_default();
    let decimals = decimal_places(primary);
    let has_percent = primary.contains('%');
    let has_date = primary
        .chars()
        .any(|character| matches!(character, 'y' | 'd'));
    let has_time = primary
        .chars()
        .any(|character| matches!(character, 'h' | 's'));
    let has_ambiguous_month = primary.contains('m') && !has_date && !has_time;
    if [has_percent, has_date || has_time, scan.currency.is_some()]
        .into_iter()
        .filter(|value| *value)
        .count()
        > 1
        || has_ambiguous_month
    {
        return NumberFormat::Unsupported;
    }
    if has_percent {
        return NumberFormat::Percent { decimals };
    }
    if has_date || has_time {
        return NumberFormat::Date {
            date: has_date,
            time: has_time,
        };
    }
    if let Some(symbol) = scan.currency {
        return NumberFormat::Currency {
            decimals,
            grouped: primary.contains(','),
            symbol,
            accounting: scan.accounting,
        };
    }
    let structural = primary
        .chars()
        .filter(|character| {
            !matches!(
                character,
                '0' | '#' | '?' | '.' | ',' | '-' | '+' | ' ' | '(' | ')'
            )
        })
        .collect::<String>();
    if structural.is_empty() {
        NumberFormat::Number {
            decimals,
            grouped: primary.contains(','),
        }
    } else {
        NumberFormat::Unsupported
    }
}

struct FormatScan {
    tokens: String,
    currency: Option<String>,
    accounting: bool,
    unsupported_literal: bool,
}

fn scan_custom_format(code: &str) -> FormatScan {
    let mut characters = code.chars().peekable();
    let mut tokens = String::new();
    let mut currency = None;
    let mut accounting = false;
    let mut unsupported_literal = false;
    while let Some(character) = characters.next() {
        match character {
            '"' => {
                let mut literal = String::new();
                let mut closed = false;
                for next in characters.by_ref() {
                    if next == '"' {
                        closed = true;
                        break;
                    }
                    literal.push(next);
                }
                if !closed {
                    unsupported_literal = true;
                    break;
                }
                record_literal(&literal, &mut currency, &mut unsupported_literal);
            }
            '\\' => {
                let Some(literal) = characters.next() else {
                    unsupported_literal = true;
                    break;
                };
                record_literal(
                    &literal.to_string(),
                    &mut currency,
                    &mut unsupported_literal,
                );
            }
            '_' | '*' => {
                accounting |= character == '_';
                if characters.next().is_none() {
                    unsupported_literal = true;
                    break;
                }
            }
            '[' => {
                let mut bracket = String::new();
                let mut closed = false;
                for next in characters.by_ref() {
                    if next == ']' {
                        closed = true;
                        break;
                    }
                    bracket.push(next);
                }
                if !closed {
                    unsupported_literal = true;
                    break;
                }
                let lower = bracket.to_ascii_lowercase();
                if let Some(value) = lower.strip_prefix('$') {
                    let symbol = value.split('-').next().unwrap_or_default();
                    if !symbol.is_empty() {
                        currency = Some(symbol.to_string());
                    }
                } else if matches!(lower.as_str(), "h" | "hh" | "m" | "mm" | "s" | "ss") {
                    tokens.push(lower.chars().next().unwrap_or_default());
                } else if !is_ignorable_bracket(&lower) {
                    unsupported_literal = true;
                }
            }
            '$' | '€' | '£' | '¥' => currency = Some(character.to_string()),
            'Y' | 'y' => tokens.push('y'),
            'D' | 'd' => tokens.push('d'),
            'H' | 'h' => tokens.push('h'),
            'S' | 's' => tokens.push('s'),
            'M' | 'm' => tokens.push('m'),
            '0' | '#' | '?' | '.' | ',' | '-' | '+' | ' ' | '%' | ';' | '(' | ')' => {
                accounting |= character == '(';
                tokens.push(character);
            }
            '@' => {}
            ':' => tokens.push(character),
            character if character.is_ascii_alphabetic() => unsupported_literal = true,
            _ => unsupported_literal = true,
        }
    }
    FormatScan {
        tokens,
        currency,
        accounting,
        unsupported_literal,
    }
}

fn record_literal(literal: &str, currency: &mut Option<String>, unsupported: &mut bool) {
    let trimmed = literal.trim();
    if trimmed.is_empty() || matches!(trimmed, "-" | "+" | "(" | ")") {
        return;
    }
    if matches!(trimmed, "$" | "€" | "£" | "¥") {
        *currency = Some(trimmed.to_string());
    } else {
        *unsupported = true;
    }
}

fn is_biff_escaped_date_mask(code: &str) -> bool {
    let primary = code.split(';').next().unwrap_or_default().trim();
    if primary.is_empty() || !primary.starts_with('\\') {
        return false;
    }
    let mut decoded = String::new();
    let mut characters = primary.chars();
    while let Some(character) = characters.next() {
        if character != '\\' {
            return false;
        }
        let Some(literal) = characters.next() else {
            return false;
        };
        decoded.push(literal.to_ascii_lowercase());
    }
    matches!(
        decoded.as_str(),
        "yyyy-mm-dd"
            | "yyyy/mm/dd"
            | "yyyy.mm.dd"
            | "yy-mm-dd"
            | "yy/mm/dd"
            | "dd-mm-yyyy"
            | "dd/mm/yyyy"
            | "dd.mm.yyyy"
            | "mm-dd-yyyy"
            | "mm/dd/yyyy"
    )
}

fn is_ignorable_bracket(value: &str) -> bool {
    matches!(
        value,
        "black" | "blue" | "cyan" | "green" | "magenta" | "red" | "white" | "yellow"
    ) || value.starts_with(['<', '>', '='])
        || value.chars().all(|character| character.is_ascii_digit())
        || value.starts_with("$-")
}

fn decimal_places(code: &str) -> usize {
    let Some(dot) = code.find('.') else {
        return 0;
    };
    code[dot + 1..]
        .chars()
        .take_while(|character| matches!(character, '0' | '#'))
        .count()
        .min(8)
}

fn parse_shared_strings(
    xml: &[u8],
    budget: &mut ProjectionBudget<'_>,
) -> Result<Vec<String>, CoreError> {
    let mut reader = Reader::from_reader(Cursor::new(xml));
    let mut buffer = Vec::new();
    let mut strings = Vec::new();
    let mut current = String::new();
    let mut in_item = false;
    let mut in_text = false;
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|_| CoreError::Malformed)?;
        budget.xml_event(&event)?;
        match event {
            Event::Start(event) if local_name(event.name().as_ref()) == b"si" => {
                in_item = true;
                current.clear();
            }
            Event::Start(event) if in_item && local_name(event.name().as_ref()) == b"t" => {
                in_text = true
            }
            Event::Text(text) if in_item && in_text => current.push_str(&decode_text(&text)?),
            Event::End(event) if local_name(event.name().as_ref()) == b"t" => in_text = false,
            Event::End(event) if local_name(event.name().as_ref()) == b"si" => {
                strings.push(current.clone());
                in_item = false;
            }
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
    budget.finish_xml()?;
    Ok(strings)
}

fn parse_worksheet(
    xml: &[u8],
    styles: &[NumberFormat],
    shared: &[String],
    allow_lossy: bool,
    date_1904: bool,
    budget: &mut ProjectionBudget<'_>,
) -> Result<(Vec<Vec<String>>, bool, bool), CoreError> {
    let mut reader = Reader::from_reader(Cursor::new(xml));
    let mut buffer = Vec::new();
    let mut hidden_columns = Vec::<(usize, usize)>::new();
    let mut current_row_hidden = false;
    let mut current_cell: Option<CellState> = None;
    let mut capture: Option<Capture> = None;
    let mut cells = BTreeMap::<usize, BTreeMap<usize, String>>::new();
    let mut cell_count = 0_usize;
    let mut hidden_skipped = false;
    let mut lossy = false;
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|_| CoreError::Malformed)?;
        budget.xml_event(&event)?;
        match event {
            Event::Start(event) | Event::Empty(event)
                if local_name(event.name().as_ref()) == b"col" =>
            {
                if attr_bool(&event, b"hidden") {
                    let minimum = attr_u32(&event, b"min").unwrap_or(1) as usize;
                    let maximum = attr_u32(&event, b"max").unwrap_or(minimum as u32) as usize;
                    hidden_columns.push((minimum, maximum));
                    hidden_skipped = true;
                }
            }
            Event::Start(event) if local_name(event.name().as_ref()) == b"row" => {
                current_row_hidden = attr_bool(&event, b"hidden");
                hidden_skipped |= current_row_hidden;
            }
            Event::End(event) if local_name(event.name().as_ref()) == b"row" => {
                current_row_hidden = false
            }
            Event::Start(event) if local_name(event.name().as_ref()) == b"c" => {
                current_cell = Some(CellState {
                    reference: attr_string(&event, b"r").unwrap_or_default(),
                    kind: attr_string(&event, b"t").unwrap_or_default(),
                    style: attr_u32(&event, b"s").unwrap_or(0) as usize,
                    ..CellState::default()
                });
            }
            Event::Start(event)
                if current_cell.is_some() && local_name(event.name().as_ref()) == b"v" =>
            {
                capture = Some(Capture::Value)
            }
            Event::Start(event)
                if current_cell.is_some() && local_name(event.name().as_ref()) == b"t" =>
            {
                capture = Some(Capture::Text)
            }
            Event::Text(text) => {
                if let (Some(cell), Some(target)) = (current_cell.as_mut(), capture) {
                    match target {
                        Capture::Value => cell.value.push_str(&decode_text(&text)?),
                        Capture::Text => cell.inline_text.push_str(&decode_text(&text)?),
                    }
                }
            }
            Event::End(event) if matches!(local_name(event.name().as_ref()), b"v" | b"t") => {
                capture = None
            }
            Event::End(event) if local_name(event.name().as_ref()) == b"c" => {
                if let Some(cell) = current_cell.take() {
                    if current_row_hidden {
                        buffer.clear();
                        continue;
                    }
                    let (row, column) =
                        cell_reference(&cell.reference).ok_or(CoreError::Malformed)?;
                    if hidden_columns
                        .iter()
                        .any(|(minimum, maximum)| column >= *minimum && column <= *maximum)
                    {
                        hidden_skipped = true;
                        buffer.clear();
                        continue;
                    }
                    if row > MAX_ROWS || column > MAX_COLUMNS {
                        return Err(CoreError::ResourceLimit("max_spreadsheet_dimensions"));
                    }
                    cell_count += 1;
                    budget.charge(1)?;
                    if cell_count > MAX_CELLS {
                        return Err(CoreError::ResourceLimit("max_spreadsheet_cells"));
                    }
                    let (display, used_lossy) =
                        display_cell(&cell, styles, shared, allow_lossy, date_1904)?;
                    lossy |= used_lossy;
                    if !display.is_empty() {
                        cells.entry(row).or_default().insert(column, display);
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
    budget.finish_xml()?;
    let minimum_column = cells
        .values()
        .filter_map(|row| row.keys().next().copied())
        .min()
        .unwrap_or(1);
    let maximum_column = cells
        .values()
        .filter_map(|row| row.keys().next_back().copied())
        .max()
        .unwrap_or(0);
    let visible_columns = (minimum_column..=maximum_column)
        .filter(|column| {
            !hidden_columns
                .iter()
                .any(|(minimum, maximum)| column >= minimum && column <= maximum)
        })
        .collect::<Vec<_>>();
    let rows = cells
        .into_values()
        .map(|row| {
            visible_columns
                .iter()
                .map(|column| row.get(column).cloned().unwrap_or_default())
                .collect()
        })
        .collect();
    Ok((rows, hidden_skipped, lossy))
}

fn display_cell(
    cell: &CellState,
    styles: &[NumberFormat],
    shared: &[String],
    allow_lossy: bool,
    date_1904: bool,
) -> Result<(String, bool), CoreError> {
    match cell.kind.as_str() {
        "s" => {
            let index = cell
                .value
                .parse::<usize>()
                .map_err(|_| CoreError::Malformed)?;
            Ok((
                shared.get(index).cloned().ok_or(CoreError::Malformed)?,
                false,
            ))
        }
        "inlineStr" => Ok((cell.inline_text.clone(), false)),
        "str" => Ok((cell.value.clone(), false)),
        "b" => Ok((
            if cell.value == "1" { "TRUE" } else { "FALSE" }.to_string(),
            false,
        )),
        "e" => Ok((format!("#{}", cell.value.trim_start_matches('#')), false)),
        _ if cell.value.trim().is_empty() => Ok((String::new(), false)),
        _ => {
            let value = cell
                .value
                .parse::<f64>()
                .map_err(|_| CoreError::Malformed)?;
            let format = styles.get(cell.style).ok_or(CoreError::Malformed)?;
            match format_numeric(value, format, date_1904) {
                Some(display) => Ok((display, false)),
                None if allow_lossy => Ok((cell.value.clone(), true)),
                None => Err(CoreError::SpreadsheetSemantics),
            }
        }
    }
}

fn format_numeric(value: f64, format: &NumberFormat, date_1904: bool) -> Option<String> {
    if !value.is_finite() {
        return None;
    }
    match format {
        NumberFormat::General => Some(trim_number(value, 15)),
        NumberFormat::Number { decimals, grouped } => Some(number(value, *decimals, *grouped)),
        NumberFormat::Percent { decimals } => {
            Some(format!("{}%", number(value * 100.0, *decimals, false)))
        }
        NumberFormat::Currency {
            decimals,
            grouped,
            symbol,
            accounting,
        } => {
            let absolute = number(value.abs(), *decimals, *grouped);
            Some(if value < 0.0 && *accounting {
                format!("({symbol}{absolute})")
            } else if value < 0.0 {
                format!("-{symbol}{absolute}")
            } else {
                format!("{symbol}{absolute}")
            })
        }
        NumberFormat::Date { date, time } => excel_date(value, *date, *time, date_1904),
        NumberFormat::Unsupported => None,
    }
}

fn number(value: f64, decimals: usize, grouped: bool) -> String {
    let raw = format!("{value:.decimals$}");
    if !grouped {
        return raw;
    }
    let (sign, unsigned) = raw
        .strip_prefix('-')
        .map_or(("", raw.as_str()), |rest| ("-", rest));
    let (integer, fraction) = unsigned
        .split_once('.')
        .map_or((unsigned, None), |(left, right)| (left, Some(right)));
    let mut output = String::new();
    for (index, character) in integer.chars().enumerate() {
        if index > 0 && (integer.len() - index) % 3 == 0 {
            output.push(',');
        }
        output.push(character);
    }
    match fraction {
        Some(fraction) => format!("{sign}{output}.{fraction}"),
        None => format!("{sign}{output}"),
    }
}

fn trim_number(value: f64, precision: usize) -> String {
    let raw = format!("{value:.precision$}");
    raw.trim_end_matches('0').trim_end_matches('.').to_string()
}

fn excel_date(
    value: f64,
    include_date: bool,
    include_time: bool,
    date_1904: bool,
) -> Option<String> {
    if value < 0.0 {
        return None;
    }
    let base = if date_1904 {
        NaiveDate::from_ymd_opt(1904, 1, 1)?
    } else {
        NaiveDate::from_ymd_opt(1899, 12, 30)?
    }
    .and_hms_opt(0, 0, 0)?;
    let milliseconds = (value * 86_400_000.0).round() as i64;
    let timestamp = base.checked_add_signed(Duration::milliseconds(milliseconds))?;
    Some(match (include_date, include_time) {
        (true, true) => timestamp.format("%Y-%m-%d %H:%M:%S").to_string(),
        (true, false) => timestamp.format("%Y-%m-%d").to_string(),
        (false, true) => timestamp.format("%H:%M:%S").to_string(),
        (false, false) => return None,
    })
}

fn cell_reference(reference: &str) -> Option<(usize, usize)> {
    let mut column = 0_usize;
    let mut split = 0_usize;
    for (index, character) in reference.char_indices() {
        if character.is_ascii_alphabetic() {
            column = column
                .checked_mul(26)?
                .checked_add((character.to_ascii_uppercase() as u8 - b'A' + 1) as usize)?;
            split = index + character.len_utf8();
        } else {
            break;
        }
    }
    let row = reference.get(split..)?.parse().ok()?;
    (row > 0 && column > 0).then_some((row, column))
}

fn attr_string(event: &BytesStart<'_>, key: &[u8]) -> Option<String> {
    event
        .attributes()
        .with_checks(false)
        .filter_map(Result::ok)
        .find(|attribute| local_name(attribute.key.as_ref()) == key)
        .map(|attribute| String::from_utf8_lossy(attribute.value.as_ref()).into_owned())
}

fn attr_u32(event: &BytesStart<'_>, key: &[u8]) -> Option<u32> {
    attr_string(event, key)?.parse().ok()
}

fn attr_bool(event: &BytesStart<'_>, key: &[u8]) -> bool {
    matches!(attr_string(event, key).as_deref(), Some("1" | "true"))
}

fn decode_text(text: &quick_xml::events::BytesText<'_>) -> Result<String, CoreError> {
    let decoded = text.decode().map_err(|_| CoreError::Malformed)?;
    quick_xml::escape::unescape(&decoded)
        .map(|value| value.into_owned())
        .map_err(|_| CoreError::Malformed)
}

fn local_name(name: &[u8]) -> &[u8] {
    name.rsplit(|byte| *byte == b':').next().unwrap_or(name)
}

fn bounded_name(name: &str) -> String {
    name.chars()
        .filter(|character| !character.is_control())
        .take(256)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn common_display_formats_are_reconstructed() {
        assert_eq!(
            format_numeric(0.075, &NumberFormat::Percent { decimals: 1 }, false).unwrap(),
            "7.5%"
        );
        assert_eq!(
            format_numeric(
                -1234.5,
                &NumberFormat::Currency {
                    decimals: 2,
                    grouped: true,
                    symbol: "$".to_string(),
                    accounting: true,
                },
                false,
            )
            .unwrap(),
            "($1,234.50)"
        );
        assert_eq!(
            format_numeric(
                45_292.0,
                &NumberFormat::Date {
                    date: true,
                    time: false
                },
                false,
            )
            .unwrap(),
            "2024-01-01"
        );
    }

    #[test]
    fn hidden_rows_and_columns_are_excluded() {
        let xml = br#"<worksheet><cols><col min="2" max="2" hidden="1"/></cols><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>visible</t></is></c><c r="B1" t="inlineStr"><is><t>hidden col</t></is></c></row><row r="2" hidden="1"><c r="A2" t="inlineStr"><is><t>hidden row</t></is></c></row></sheetData></worksheet>"#;
        let cancelled = AtomicBool::new(false);
        let mut budget = ProjectionBudget::new(&cancelled, usize::MAX);
        let (rows, hidden, _) = parse_worksheet(
            xml,
            &[NumberFormat::General],
            &[],
            false,
            false,
            &mut budget,
        )
        .unwrap();
        assert!(hidden);
        assert_eq!(rows, vec![vec!["visible"]]);
    }

    #[test]
    fn used_unsupported_custom_format_fails_closed() {
        let xml = br#"<worksheet><sheetData><row r="1"><c r="A1" s="1"><v>1.5</v></c></row></sheetData></worksheet>"#;
        let formats = vec![NumberFormat::General, NumberFormat::Unsupported];
        let cancelled = AtomicBool::new(false);
        let mut budget = ProjectionBudget::new(&cancelled, usize::MAX);
        assert!(matches!(
            parse_worksheet(xml, &formats, &[], false, false, &mut budget),
            Err(CoreError::SpreadsheetSemantics)
        ));
    }

    #[test]
    fn projection_reads_percent_style_end_to_end() {
        let mut output = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut output);
            let options = zip::write::SimpleFileOptions::default();
            for (name, body) in [
                (
                    "xl/styles.xml",
                    r#"<styleSheet><numFmts><numFmt numFmtId="164" formatCode="0.0%"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>"#,
                ),
                (
                    "xl/workbook.xml",
                    r#"<workbook xmlns:r="r"><sheets><sheet name="Metrics" r:id="rId1"/></sheets></workbook>"#,
                ),
                (
                    "xl/_rels/workbook.xml.rels",
                    r#"<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>"#,
                ),
                (
                    "xl/worksheets/sheet1.xml",
                    r#"<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Rate</t></is></c></row><row r="2"><c r="A2" s="1"><v>0.075</v></c></row></sheetData></worksheet>"#,
                ),
            ] {
                writer.start_file(name, options).unwrap();
                writer.write_all(body.as_bytes()).unwrap();
            }
            writer.finish().unwrap();
        }
        let projection = project(
            &output.into_inner(),
            false,
            &AtomicBool::new(false),
            usize::MAX,
        )
        .unwrap();
        assert_eq!(projection.sheets[0].name, "Metrics");
        assert_eq!(projection.sheets[0].rows[1][0], "7.5%");
    }

    #[test]
    fn quoted_custom_literal_is_not_misclassified_as_date() {
        assert!(matches!(
            classify_custom(r#"0.0 "days""#),
            NumberFormat::Unsupported
        ));
        assert!(matches!(
            classify_custom(r#"0.00%"#),
            NumberFormat::Percent { decimals: 2 }
        ));
        assert!(matches!(
            classify_custom(r#"\y\y\y\y\-\m\m\-\d\d"#),
            NumberFormat::Date {
                date: true,
                time: false
            }
        ));
    }

    #[test]
    fn date_1904_epoch_is_honoured() {
        let format = NumberFormat::Date {
            date: true,
            time: false,
        };
        assert_eq!(format_numeric(0.0, &format, true).unwrap(), "1904-01-01");
        assert_eq!(
            format_numeric(1_462.0, &format, false).unwrap(),
            "1904-01-01"
        );
    }

    #[test]
    fn compressed_worksheet_over_entry_limit_fails_before_parse() {
        let mut output = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut output);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            writer
                .start_file("xl/worksheets/sheet1.xml", options)
                .unwrap();
            writer
                .write_all(&vec![b'x'; MAX_XML_BYTES as usize + 1])
                .unwrap();
            writer.finish().unwrap();
        }
        assert!(matches!(
            project(
                &output.into_inner(),
                false,
                &AtomicBool::new(false),
                usize::MAX,
            ),
            Err(CoreError::ResourceLimit("max_archive_entry_bytes"))
        ));
    }

    #[test]
    fn all_hidden_workbook_sheets_are_not_reintroduced_by_archive_fallback() {
        let mut output = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut output);
            let options = zip::write::SimpleFileOptions::default();
            for (name, body) in [
                (
                    "xl/workbook.xml",
                    r#"<workbook xmlns:r="r"><sheets><sheet name="Secret" state="veryHidden" r:id="rId1"/></sheets></workbook>"#,
                ),
                (
                    "xl/_rels/workbook.xml.rels",
                    r#"<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>"#,
                ),
                (
                    "xl/worksheets/sheet1.xml",
                    r#"<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>must stay hidden</t></is></c></row></sheetData></worksheet>"#,
                ),
            ] {
                writer.start_file(name, options).unwrap();
                writer.write_all(body.as_bytes()).unwrap();
            }
            writer.finish().unwrap();
        }
        let projection = project(
            &output.into_inner(),
            false,
            &AtomicBool::new(false),
            usize::MAX,
        )
        .unwrap();
        assert!(projection.sheets.is_empty());
        assert!(projection.hidden_content_skipped);
    }
}
