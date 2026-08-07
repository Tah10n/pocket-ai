// SPDX-License-Identifier: MIT
//
// Copyright 2016-2026, Johann Tuffe.

use crate::datatype::{Data, DataRef, ExcelDateTime, ExcelDateTimeType};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CellFormat {
    General,
    Other,
    DateTime,
    TimeDelta,
    Number {
        decimals: u8,
        grouped: bool,
    },
    Percent {
        decimals: u8,
    },
    Currency {
        decimals: u8,
        grouped: bool,
        symbol: CurrencySymbol,
        accounting: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CurrencySymbol {
    Dollar,
    Euro,
    Pound,
    Yen,
}

impl CurrencySymbol {
    fn text(self) -> &'static str {
        match self {
            Self::Dollar => "$",
            Self::Euro => "€",
            Self::Pound => "£",
            Self::Yen => "¥",
        }
    }
}

pub const UNSUPPORTED_FORMAT_SENTINEL: &str =
    "\u{e000}pocket-anydoc:unsupported-spreadsheet-format";

/// Check excel number format is datetime
pub fn detect_custom_number_format(format: &str) -> CellFormat {
    if format.trim().eq_ignore_ascii_case("general") {
        return CellFormat::General;
    }
    // LibreOffice emits common date masks in BIFF with every token escaped
    // (for example `\y\y\y\y\-\m\m\-\d\d`).  Excel-compatible readers
    // still render those cells as dates.  Recognize only a small allow-list of
    // complete date masks so arbitrary escaped literals remain fail-closed.
    if is_biff_escaped_date_mask(format) {
        return CellFormat::DateTime;
    }
    let scan = scan_format(format);
    if scan.unsupported {
        return CellFormat::Other;
    }
    let primary = scan.tokens.split(';').next().unwrap_or_default();
    let decimals = decimal_places(primary);
    let percent = primary.contains('%');
    let date = primary.chars().any(|value| matches!(value, 'y' | 'd'));
    let time = primary.chars().any(|value| matches!(value, 'h' | 's'));
    if (primary.contains('m') && !date && !time)
        || [percent, date || time, scan.currency.is_some()]
            .into_iter()
            .filter(|value| *value)
            .count()
            > 1
    {
        return CellFormat::Other;
    }
    if percent {
        return CellFormat::Percent { decimals };
    }
    if date || time {
        return if primary.contains("[h]") || primary.contains("[m]") || primary.contains("[s]") {
            CellFormat::TimeDelta
        } else {
            CellFormat::DateTime
        };
    }
    if let Some(symbol) = scan.currency {
        return CellFormat::Currency {
            decimals,
            grouped: primary.contains(','),
            symbol,
            accounting: scan.accounting,
        };
    }
    if primary.chars().all(|value| {
        matches!(
            value,
            '0' | '#' | '?' | '.' | ',' | '-' | '+' | ' ' | '(' | ')'
        )
    }) {
        CellFormat::Number {
            decimals,
            grouped: primary.contains(','),
        }
    } else {
        CellFormat::Other
    }
}

pub fn builtin_format_by_id(id: &[u8]) -> CellFormat {
    std::str::from_utf8(id)
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .map(builtin_format_by_code)
        .unwrap_or(CellFormat::Other)
}

/// Check if code corresponds to builtin date format
///
/// See `is_builtin_date_format_id`
pub fn builtin_format_by_code(code: u16) -> CellFormat {
    match code {
        0 | 49 => CellFormat::General,
        1 => CellFormat::Number {
            decimals: 0,
            grouped: false,
        },
        2 => CellFormat::Number {
            decimals: 2,
            grouped: false,
        },
        3 => CellFormat::Number {
            decimals: 0,
            grouped: true,
        },
        4 | 37 | 38 => CellFormat::Number {
            decimals: if code == 4 { 2 } else { 0 },
            grouped: true,
        },
        39 | 40 => CellFormat::Number {
            decimals: 2,
            grouped: true,
        },
        5 | 6 | 41 | 42 => CellFormat::Currency {
            decimals: 0,
            grouped: true,
            symbol: CurrencySymbol::Dollar,
            accounting: matches!(code, 41 | 42),
        },
        7 | 8 | 43 | 44 => CellFormat::Currency {
            decimals: 2,
            grouped: true,
            symbol: CurrencySymbol::Dollar,
            accounting: matches!(code, 43 | 44),
        },
        9 => CellFormat::Percent { decimals: 0 },
        10 => CellFormat::Percent { decimals: 2 },
        14..=22 | 45 | 47 => CellFormat::DateTime,
        46 => CellFormat::TimeDelta,
        _ => CellFormat::Other,
    }
}

// convert i64 to date, if format == Date
pub fn format_excel_i64(value: i64, format: Option<&CellFormat>, is_1904: bool) -> Data {
    match format {
        Some(CellFormat::DateTime) => Data::DateTime(ExcelDateTime::new(
            value as f64,
            ExcelDateTimeType::DateTime,
            is_1904,
        )),
        Some(CellFormat::TimeDelta) => Data::DateTime(ExcelDateTime::new(
            value as f64,
            ExcelDateTimeType::TimeDelta,
            is_1904,
        )),
        Some(
            format @ (CellFormat::Number { .. }
            | CellFormat::Percent { .. }
            | CellFormat::Currency { .. }),
        ) => Data::String(format_display(value as f64, *format)),
        Some(CellFormat::Other) => Data::String(UNSUPPORTED_FORMAT_SENTINEL.to_string()),
        _ => Data::Int(value),
    }
}

// convert f64 to date, if format == Date
#[inline]
pub fn format_excel_f64_ref(
    value: f64,
    format: Option<&CellFormat>,
    is_1904: bool,
) -> DataRef<'static> {
    match format {
        Some(CellFormat::DateTime) => DataRef::DateTime(ExcelDateTime::new(
            value,
            ExcelDateTimeType::DateTime,
            is_1904,
        )),
        Some(CellFormat::TimeDelta) => DataRef::DateTime(ExcelDateTime::new(
            value,
            ExcelDateTimeType::TimeDelta,
            is_1904,
        )),
        Some(
            format @ (CellFormat::Number { .. }
            | CellFormat::Percent { .. }
            | CellFormat::Currency { .. }),
        ) => DataRef::String(format_display(value, *format)),
        Some(CellFormat::Other) => DataRef::String(UNSUPPORTED_FORMAT_SENTINEL.to_string()),
        _ => DataRef::Float(value),
    }
}

// convert f64 to date, if format == Date
pub fn format_excel_f64(value: f64, format: Option<&CellFormat>, is_1904: bool) -> Data {
    format_excel_f64_ref(value, format, is_1904).into()
}

struct FormatScan {
    tokens: String,
    currency: Option<CurrencySymbol>,
    accounting: bool,
    unsupported: bool,
}

fn scan_format(format: &str) -> FormatScan {
    let mut characters = format.chars().peekable();
    let mut scan = FormatScan {
        tokens: String::new(),
        currency: None,
        accounting: false,
        unsupported: false,
    };
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
                    scan.unsupported = true;
                    break;
                }
                scan_literal(&literal, &mut scan);
            }
            '\\' => match characters.next() {
                Some(literal) => scan_literal(&literal.to_string(), &mut scan),
                None => scan.unsupported = true,
            },
            '_' | '*' => {
                scan.accounting |= character == '_';
                scan.unsupported |= characters.next().is_none();
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
                    scan.unsupported = true;
                    break;
                }
                let lower = bracket.to_ascii_lowercase();
                if let Some(value) = lower.strip_prefix('$') {
                    if let Some(symbol) =
                        currency_symbol(value.split('-').next().unwrap_or_default())
                    {
                        scan.currency = Some(symbol);
                    } else if !value.starts_with('-') {
                        scan.unsupported = true;
                    }
                } else if matches!(lower.as_str(), "h" | "hh" | "m" | "mm" | "s" | "ss") {
                    scan.tokens.push('[');
                    scan.tokens.push(lower.chars().next().unwrap_or_default());
                    scan.tokens.push(']');
                } else if !is_ignorable_bracket(&lower) {
                    scan.unsupported = true;
                }
            }
            '$' | '€' | '£' | '¥' => scan.currency = currency_symbol(&character.to_string()),
            'Y' | 'y' => scan.tokens.push('y'),
            'D' | 'd' => scan.tokens.push('d'),
            'H' | 'h' => scan.tokens.push('h'),
            'S' | 's' => scan.tokens.push('s'),
            'M' | 'm' => scan.tokens.push('m'),
            '0' | '#' | '?' | '.' | ',' | '-' | '+' | ' ' | '%' | ';' | '(' | ')' | ':' => {
                scan.accounting |= character == '(';
                scan.tokens.push(character);
            }
            '@' => {}
            _ => scan.unsupported = true,
        }
    }
    scan
}

fn scan_literal(literal: &str, scan: &mut FormatScan) {
    let value = literal.trim();
    if value.is_empty() || matches!(value, "-" | "+" | "(" | ")") {
        scan.accounting |= value == "(";
        return;
    }
    if let Some(symbol) = currency_symbol(value) {
        scan.currency = Some(symbol);
    } else {
        scan.unsupported = true;
    }
}

fn is_biff_escaped_date_mask(format: &str) -> bool {
    let primary = format.split(';').next().unwrap_or_default().trim();
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

fn currency_symbol(value: &str) -> Option<CurrencySymbol> {
    match value.to_ascii_uppercase().as_str() {
        "$" | "USD" => Some(CurrencySymbol::Dollar),
        "€" | "EUR" => Some(CurrencySymbol::Euro),
        "£" | "GBP" => Some(CurrencySymbol::Pound),
        "¥" | "JPY" | "CNY" => Some(CurrencySymbol::Yen),
        _ => None,
    }
}

fn is_ignorable_bracket(value: &str) -> bool {
    matches!(
        value,
        "black" | "blue" | "cyan" | "green" | "magenta" | "red" | "white" | "yellow"
    ) || value.starts_with(['<', '>', '='])
        || value.chars().all(|character| character.is_ascii_digit())
        || value.starts_with("$-")
}

fn decimal_places(format: &str) -> u8 {
    format
        .split_once('.')
        .map(|(_, tail)| {
            tail.chars()
                .take_while(|value| matches!(value, '0' | '#'))
                .count()
                .min(8) as u8
        })
        .unwrap_or(0)
}

fn format_display(value: f64, format: CellFormat) -> String {
    match format {
        CellFormat::Number { decimals, grouped } => format_number(value, decimals, grouped),
        CellFormat::Percent { decimals } => {
            format!("{}%", format_number(value * 100.0, decimals, false))
        }
        CellFormat::Currency {
            decimals,
            grouped,
            symbol,
            accounting,
        } => {
            let absolute = format_number(value.abs(), decimals, grouped);
            if value < 0.0 && accounting {
                format!("({}{absolute})", symbol.text())
            } else if value < 0.0 {
                format!("-{}{absolute}", symbol.text())
            } else {
                format!("{}{absolute}", symbol.text())
            }
        }
        _ => UNSUPPORTED_FORMAT_SENTINEL.to_string(),
    }
}

fn format_number(value: f64, decimals: u8, grouped: bool) -> String {
    let raw = format!("{value:.precision$}", precision = decimals as usize);
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

/// Ported from openpyxl, MIT License
/// https://foss.heptapod.net/openpyxl/openpyxl/-/blob/a5e197c530aaa49814fd1d993dd776edcec35105/openpyxl/styles/tests/test_number_style.py
#[test]
fn test_is_date_format() {
    assert_eq!(
        detect_custom_number_format("DD/MM/YY"),
        CellFormat::DateTime
    );
    assert_eq!(
        detect_custom_number_format("H:MM:SS;@"),
        CellFormat::DateTime
    );
    assert_eq!(
        detect_custom_number_format("#,##0\\ [$\\u20bd-46D]"),
        CellFormat::Other
    );
    assert_eq!(
        detect_custom_number_format("m\"M\"d\"D\";@"),
        CellFormat::DateTime
    );
    assert_eq!(
        detect_custom_number_format("[h]:mm:ss"),
        CellFormat::TimeDelta
    );
    assert_eq!(
        detect_custom_number_format("\"Y: \"0.00\"m\";\"Y: \"-0.00\"m\";\"Y: <num>m\";@"),
        CellFormat::Other
    );
    assert_eq!(
        detect_custom_number_format("#,##0\\ [$''u20bd-46D]"),
        CellFormat::Other
    );
    assert_eq!(
        detect_custom_number_format("\"$\"#,##0_);[Red](\"$\"#,##0)"),
        CellFormat::Other
    );
    assert_eq!(
        detect_custom_number_format("[$-404]e\"\\xfc\"m\"\\xfc\"d\"\\xfc\""),
        CellFormat::DateTime
    );
    assert_eq!(
        detect_custom_number_format("0_ ;[Red]\\-0\\ "),
        CellFormat::Other
    );
    assert_eq!(detect_custom_number_format("\\Y000000"), CellFormat::Other);
    assert_eq!(
        detect_custom_number_format("\\y\\y\\y\\y\\-\\m\\m\\-\\d\\d"),
        CellFormat::DateTime
    );
    assert_eq!(
        detect_custom_number_format("\\y\\y\\y\\y\\-\\m\\m\\-\\d\\d literal"),
        CellFormat::Other
    );
    assert_eq!(
        detect_custom_number_format("#,##0.0####\" YMD\""),
        CellFormat::Other
    );
    assert_eq!(detect_custom_number_format("[h]"), CellFormat::TimeDelta);
    assert_eq!(detect_custom_number_format("[ss]"), CellFormat::TimeDelta);
    assert_eq!(
        detect_custom_number_format("[s].000"),
        CellFormat::TimeDelta
    );
    assert_eq!(detect_custom_number_format("[m]"), CellFormat::TimeDelta);
    assert_eq!(detect_custom_number_format("[mm]"), CellFormat::TimeDelta);
    assert_eq!(
        detect_custom_number_format("[Blue]\\+[h]:mm;[Red]\\-[h]:mm;[Green][h]:mm"),
        CellFormat::TimeDelta
    );
    assert_eq!(
        detect_custom_number_format("[>=100][Magenta][s].00"),
        CellFormat::TimeDelta
    );
    assert_eq!(
        detect_custom_number_format("[h]:mm;[=0]\\-"),
        CellFormat::TimeDelta
    );
    assert_eq!(
        detect_custom_number_format("[>=100][Magenta].00"),
        CellFormat::Other
    );
    assert_eq!(
        detect_custom_number_format("[>=100][Magenta]General"),
        CellFormat::Other
    );
    assert_eq!(
        detect_custom_number_format("ha/p\\\\m"),
        CellFormat::DateTime
    );
    assert_eq!(
        detect_custom_number_format("#,##0.00\\ _M\"H\"_);[Red]#,##0.00\\ _M\"S\"_)"),
        CellFormat::Other
    );
    // The `*` fill operator repeats the next character to fill the cell, so
    // that character is a literal and must not be read as a date token even
    // when it happens to be one (here `y`, `d`, `m`).
    assert_eq!(detect_custom_number_format("#,##0*y"), CellFormat::Other);
    assert_eq!(detect_custom_number_format("0\"x\"*d"), CellFormat::Other);
    assert_eq!(detect_custom_number_format("*-#,##0"), CellFormat::Other);
    // A real date token after the single fill char is still detected.
    assert_eq!(
        detect_custom_number_format("*-yyyy-mm-dd"),
        CellFormat::DateTime
    );
}
