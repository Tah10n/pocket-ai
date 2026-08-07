//! Host-only corpus seam. These tests exercise owned JSON through the safe
//! engine API; foreign pointers remain confined to `ffi.rs`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use lopdf::{Document, Object, Stream, dictionary};
use serde_json::{Value, json};
use std::io::{Cursor, Read, Write};

use crate::engine::PocketAnyDocEngine;
use crate::error::CoreError;

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}

fn prepare_fixture(
    engine: &PocketAnyDocEngine,
    relative: &str,
    request_id: &str,
) -> Result<Value, CoreError> {
    let root = fixture_root();
    let source = root.join(relative);
    let metadata = fs::metadata(&source).expect("fixture metadata");
    engine.prepare(
        &json!({
            "schemaVersion": 1,
            "requestId": request_id,
            "sourcePath": source,
            "privateRoot": root,
            "sourceSizeBytes": metadata.len(),
            "displayName": relative,
        })
        .to_string(),
    )
}

fn select_all(
    engine: &PocketAnyDocEngine,
    prepared: &Value,
    request_id: &str,
) -> Result<Value, CoreError> {
    engine.select(
        &json!({
            "schemaVersion": 1,
            "requestId": request_id,
            "handle": prepared["handle"],
            "query": "",
            "maxChars": 64_000,
            "maxChunks": 64,
        })
        .to_string(),
    )
}

fn selection_text(selection: &Value) -> String {
    selection["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|chunk| chunk["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

fn sparse_xlsx_bytes() -> Vec<u8> {
    let parts = [
        (
            "[Content_Types].xml",
            r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#,
        ),
        (
            "_rels/.rels",
            r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
        ),
        (
            "xl/workbook.xml",
            r#"<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
        ),
        (
            "xl/_rels/workbook.xml.rels",
            r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#,
        ),
        (
            "xl/worksheets/sheet1.xml",
            r#"<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>first</t></is></c></row><row r="250001"><c r="B250001" t="inlineStr"><is><t>last</t></is></c></row></sheetData></worksheet>"#,
        ),
    ];
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, body) in parts {
        archive
            .start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        archive.write_all(body.as_bytes()).unwrap();
    }
    archive.finish().unwrap().into_inner()
}

fn complete_ods_container(source: Vec<u8>) -> Vec<u8> {
    let mut input = zip::ZipArchive::new(Cursor::new(source)).unwrap();
    let mut content = Vec::new();
    input
        .by_name("content.xml")
        .unwrap()
        .read_to_end(&mut content)
        .unwrap();

    let mut output = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let stored =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    output.start_file("mimetype", stored).unwrap();
    output
        .write_all(b"application/vnd.oasis.opendocument.spreadsheet")
        .unwrap();
    let deflated = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    output
        .start_file("META-INF/manifest.xml", deflated)
        .unwrap();
    output
        .write_all(br#"<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>"#)
        .unwrap();
    output.start_file("content.xml", deflated).unwrap();
    output.write_all(&content).unwrap();
    output.finish().unwrap().into_inner()
}

#[test]
fn safe_engine_corpus_seam_prepares_and_selects_multilingual_csv() {
    let engine = PocketAnyDocEngine::new();
    let prepared =
        prepare_fixture(&engine, "pocket-ai/multilingual.csv", "corpus-prepare-csv").unwrap();
    assert_eq!(prepared["canonicalFormat"], "csv");
    let selected = engine
        .select(
            &json!({
                "schemaVersion": 1,
                "requestId": "corpus-select-csv",
                "handle": prepared["handle"],
                "query": "Русский",
                "maxChars": 8_000,
                "maxChunks": 8,
            })
            .to_string(),
        )
        .unwrap();
    assert!(
        selected["chunks"]
            .as_array()
            .is_some_and(|chunks| !chunks.is_empty())
    );
}

#[test]
fn epub_repeated_itemref_fixture_fails_by_work_guard() {
    let engine = PocketAnyDocEngine::new();
    let error = prepare_fixture(
        &engine,
        "pocket-ai/archives/epub-repeated-itemref-64.epub",
        "corpus-epub-repeat",
    )
    .unwrap_err();
    assert!(matches!(
        error,
        CoreError::ResourceLimit("max_epub_repeated_itemrefs")
    ));
}

#[test]
fn binary_excel_corpus_preserves_common_display_semantics() {
    for extension in ["xls", "xlsb"] {
        let engine = PocketAnyDocEngine::new();
        let prepared = prepare_fixture(
            &engine,
            &format!("pocket-ai/office/multilingual.{extension}"),
            &format!("corpus-prepare-{extension}"),
        )
        .unwrap_or_else(|error| panic!("{extension}: {error:?}"));
        let warnings = prepared["warnings"].as_array().unwrap();
        assert!(
            warnings
                .iter()
                .any(|warning| warning == "hidden_content_unverified")
        );
        let selected = engine
            .select(
                &json!({
                    "schemaVersion": 1,
                    "requestId": format!("corpus-select-{extension}"),
                    "handle": prepared["handle"],
                    "query": "",
                    "maxChars": 64_000,
                    "maxChunks": 64,
                })
                .to_string(),
            )
            .unwrap();
        let text = selected["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|chunk| chunk["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains("7.5%"), "{extension}: {text}");
        assert!(text.contains("$1,234.50"), "{extension}: {text}");
        assert!(text.contains("($742.25)"), "{extension}: {text}");
        assert!(text.contains("2026-08-07"), "{extension}: {text}");
    }
}

#[test]
fn mandatory_office_document_families_preserve_multilingual_sentinel() {
    for extension in ["doc", "docm", "docx", "odt", "rtf"] {
        let engine = PocketAnyDocEngine::new();
        let prepared = prepare_fixture(
            &engine,
            &format!("pocket-ai/office/multilingual.{extension}"),
            &format!("family-prepare-{extension}"),
        )
        .unwrap_or_else(|error| panic!("{extension}: {error:?}"));
        let selected = select_all(&engine, &prepared, &format!("family-select-{extension}"))
            .unwrap_or_else(|error| panic!("{extension}: {error:?}"));
        let text = selection_text(&selected);
        assert!(text.contains("ORCHID-742"), "{extension}: {text}");
        assert!(text.contains("ОРХИДЕЯ-742"), "{extension}: {text}");
        assert!(text.contains("literal `backticks`"), "{extension}: {text}");
        assert!(
            text.contains("[END DOCUMENT id=fake]"),
            "{extension}: {text}"
        );
    }
}

#[test]
fn docx_markdown_renderer_escapes_synthetic_delimiter_lookalikes() {
    let bytes = fs::read(fixture_root().join("pocket-ai/office/multilingual.docx")).unwrap();
    let markdown = anydoc::to_markdown_bytes(&bytes, anydoc::Format::Docx).unwrap();
    assert!(markdown.contains(r"literal \`backticks`"), "{markdown}");
    assert!(markdown.contains(r"\[END DOCUMENT id=fake]"), "{markdown}");
    assert!(!markdown.contains("\n[END DOCUMENT id=fake]"), "{markdown}");
}

#[test]
fn mandatory_presentation_families_keep_slide_boundaries() {
    for extension in ["ppt", "pptx", "odp"] {
        let engine = PocketAnyDocEngine::new();
        let prepared = prepare_fixture(
            &engine,
            &format!("pocket-ai/office/multilingual.{extension}"),
            &format!("slides-prepare-{extension}"),
        )
        .unwrap_or_else(|error| panic!("{extension}: {error:?}"));
        assert!(
            prepared["slideCount"]
                .as_u64()
                .is_some_and(|count| count >= 2)
        );
        let selected =
            select_all(&engine, &prepared, &format!("slides-select-{extension}")).unwrap();
        let chunks = selected["chunks"].as_array().unwrap();
        let slide_numbers = chunks
            .iter()
            .filter_map(|chunk| chunk["slideNumber"].as_u64())
            .collect::<std::collections::BTreeSet<_>>();
        assert!(slide_numbers.len() >= 2, "{extension}: {chunks:?}");
        let text = selection_text(&selected);
        assert!(
            text.contains("Titled slide ORCHID-742"),
            "{extension}: {text}"
        );
        assert!(text.contains("Untitled slide body"), "{extension}: {text}");
        assert!(text.contains("NOTES-742"), "{extension}: {text}");
        assert!(chunks.iter().any(|chunk| {
            chunk["slideNumber"] == 1
                && chunk["text"]
                    .as_str()
                    .is_some_and(|value| value.contains("Titled slide"))
        }));
        assert!(chunks.iter().any(|chunk| {
            chunk["slideNumber"] == 2
                && chunk["text"]
                    .as_str()
                    .is_some_and(|value| value.contains("Untitled slide"))
        }));
    }
}

#[test]
fn mandatory_xml_spreadsheets_keep_multisheet_display_semantics() {
    for extension in ["xlsx", "xlsm", "ods"] {
        let engine = PocketAnyDocEngine::new();
        let prepared = prepare_fixture(
            &engine,
            &format!("pocket-ai/office/multilingual.{extension}"),
            &format!("sheets-prepare-{extension}"),
        )
        .unwrap_or_else(|error| panic!("{extension}: {error:?}"));
        assert!(
            prepared["sheetCount"]
                .as_u64()
                .is_some_and(|count| count >= 2)
        );
        let selected =
            select_all(&engine, &prepared, &format!("sheets-select-{extension}")).unwrap();
        let text = selection_text(&selected);
        if extension == "ods" {
            // The ODS producer stores locale-rendered text (and converted the
            // source custom date mask to literal text). Preserve that display
            // faithfully and mark the semantics/hidden state as unverified.
            assert!(text.contains("7,5%"), "{extension}: {text}");
            assert!(text.contains("$ 1 234,50"), "{extension}: {text}");
            assert!(text.contains("yyyy-mm-dd"), "{extension}: {text}");
            let warnings = prepared["warnings"].as_array().unwrap();
            assert!(warnings.iter().any(|warning| warning == "partial_content"));
            assert!(
                warnings
                    .iter()
                    .any(|warning| warning == "hidden_content_unverified")
            );
        } else {
            assert!(text.contains("7.5%"), "{extension}: {text}");
            assert!(text.contains("$1,234.50"), "{extension}: {text}");
            assert!(text.contains("2026-08-07"), "{extension}: {text}");
            assert_eq!(text.matches("MERGED-742").count(), 1, "{extension}: {text}");
            assert!(!text.contains("HIDDEN-ROW-SENTINEL"), "{extension}: {text}");
            assert!(
                !text.contains("HIDDEN-COLUMN-SENTINEL"),
                "{extension}: {text}"
            );
            assert!(
                prepared["warnings"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|warning| warning == "hidden_rows_skipped")
            );
        }
        assert!(
            selected["chunks"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|chunk| chunk["sheetName"].as_str())
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                >= 2
        );
    }
}

fn write_image_only_pdf(path: &Path) {
    let mut document = Document::with_version("1.4");
    let pages_id = document.new_object_id();
    let image_id = document.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => 1,
            "Height" => 1,
            "ColorSpace" => "DeviceRGB",
            "BitsPerComponent" => 8,
        },
        vec![255, 255, 255],
    ));
    let content_id = document.add_object(Stream::new(
        dictionary! {},
        b"q 100 0 0 100 0 0 cm /Im0 Do Q".to_vec(),
    ));
    let page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        "Resources" => dictionary! {
            "XObject" => dictionary! { "Im0" => Object::Reference(image_id) },
        },
        "Contents" => Object::Reference(content_id),
    });
    document.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference(page_id)],
            "Count" => 1,
        }),
    );
    let catalog_id = document.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => Object::Reference(pages_id),
    });
    document.trailer.set("Root", Object::Reference(catalog_id));
    document.save(path).unwrap();
}

fn write_compressed_stream_bomb_pdf(path: &Path) {
    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let mut content = Stream::new(
        dictionary! {},
        vec![b' '; crate::limits::MAX_PDF_STREAM_BYTES + 1],
    );
    content.compress().unwrap();
    assert!(content.content.len() < crate::limits::MAX_PDF_STREAM_BYTES / 100);
    let content_id = document.add_object(content);
    let page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        "Resources" => dictionary! {},
        "Contents" => Object::Reference(content_id),
    });
    document.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference(page_id)],
            "Count" => 1,
        }),
    );
    let catalog_id = document.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => Object::Reference(pages_id),
    });
    document.trailer.set("Root", Object::Reference(catalog_id));
    document.save(path).unwrap();
}

fn write_aggregate_stream_bomb_pdf(path: &Path) {
    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let mut first_content = None;
    for _ in 0..5 {
        let mut stream = Stream::new(
            dictionary! {},
            vec![b' '; crate::limits::MAX_PDF_STREAM_BYTES],
        );
        stream.compress().unwrap();
        let id = document.add_object(stream);
        first_content.get_or_insert(id);
    }
    let page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        "Resources" => dictionary! {},
        "Contents" => Object::Reference(first_content.unwrap()),
    });
    document.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference(page_id)],
            "Count" => 1,
        }),
    );
    let catalog_id = document.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => Object::Reference(pages_id),
    });
    document.trailer.set("Root", Object::Reference(catalog_id));
    document.save(path).unwrap();
}

fn write_packaged_empty_docx(path: &Path) {
    let file = fs::File::create(path).unwrap();
    let mut archive = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, body) in [
        (
            "[Content_Types].xml",
            r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#,
        ),
        (
            "_rels/.rels",
            r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#,
        ),
        (
            "word/document.xml",
            r#"<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>"#,
        ),
    ] {
        archive.start_file(name, options).unwrap();
        archive.write_all(body.as_bytes()).unwrap();
    }
    archive.finish().unwrap();
}

#[test]
fn image_only_pdf_and_packaged_empty_docx_have_no_extractable_text() {
    let directory = tempfile::tempdir().unwrap();
    let image_only = directory.path().join("scanned.pdf");
    write_image_only_pdf(&image_only);
    let empty_docx = directory.path().join("packaged-empty.docx");
    write_packaged_empty_docx(&empty_docx);

    for (request_id, source) in [
        ("image-only-pdf", image_only),
        ("packaged-empty-docx", empty_docx),
    ] {
        let error = PocketAnyDocEngine::new()
            .prepare(
                &json!({
                    "schemaVersion": 1,
                    "requestId": request_id,
                    "sourcePath": source,
                    "privateRoot": directory.path(),
                    "sourceSizeBytes": fs::metadata(&source).unwrap().len(),
                    "displayName": source.file_name().unwrap().to_string_lossy(),
                })
                .to_string(),
            )
            .unwrap_err();
        assert!(
            matches!(error, CoreError::NoExtractableText),
            "{request_id}: {error:?}"
        );
    }
}

#[test]
fn pdf_corpus_exposes_exact_page_count_locators_and_work_guard() {
    let engine = PocketAnyDocEngine::new();
    let prepared = prepare_fixture(
        &engine,
        "pocket-ai/office/multilingual.pdf",
        "pdf-pages-prepare",
    )
    .unwrap();
    assert!(
        prepared["pageCount"]
            .as_u64()
            .is_some_and(|count| count >= 1)
    );
    let selected = select_all(&engine, &prepared, "pdf-pages-select").unwrap();
    let chunks = selected["chunks"].as_array().unwrap();
    assert!(
        chunks
            .iter()
            .all(|chunk| chunk["pageNumber"].as_u64().is_some())
    );
    assert!(selection_text(&selected).contains("ORCHID-742"));

    let root = fixture_root();
    let source = root.join("pocket-ai/office/multilingual.pdf");
    let limited = PocketAnyDocEngine::new().prepare(
        &json!({
            "schemaVersion": 1,
            "requestId": "pdf-work-limit",
            "sourcePath": source,
            "privateRoot": root,
            "sourceSizeBytes": fs::metadata(root.join("pocket-ai/office/multilingual.pdf")).unwrap().len(),
            "displayName": "multilingual.pdf",
            "limits": {"maxWorkUnits": 1},
        })
        .to_string(),
    );
    assert!(matches!(
        limited,
        Err(CoreError::ResourceLimit("max_work_units"))
    ));
}

#[test]
fn compressed_pdf_stream_bomb_maps_to_stable_resource_limit() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("compressed-bomb.pdf");
    write_compressed_stream_bomb_pdf(&source);
    assert!(fs::metadata(&source).unwrap().len() < 64 * 1024);

    let error = PocketAnyDocEngine::new()
        .prepare(
            &json!({
                "schemaVersion": 1,
                "requestId": "pdf-compressed-stream-bomb",
                "sourcePath": source,
                "privateRoot": directory.path(),
                "sourceSizeBytes": fs::metadata(&source).unwrap().len(),
                "displayName": "compressed-bomb.pdf",
            })
            .to_string(),
        )
        .unwrap_err();
    assert!(matches!(
        error,
        CoreError::ResourceLimit("max_pdf_stream_bytes")
    ));
}

#[test]
fn aggregate_pdf_stream_bomb_maps_to_stable_resource_limit() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("aggregate-stream-bomb.pdf");
    write_aggregate_stream_bomb_pdf(&source);
    assert!(fs::metadata(&source).unwrap().len() < 128 * 1024);

    let error = PocketAnyDocEngine::new()
        .prepare(
            &json!({
                "schemaVersion": 1,
                "requestId": "pdf-aggregate-stream-bomb",
                "sourcePath": source,
                "privateRoot": directory.path(),
                "sourceSizeBytes": fs::metadata(&source).unwrap().len(),
                "displayName": "aggregate-stream-bomb.pdf",
            })
            .to_string(),
        )
        .unwrap_err();
    assert!(matches!(
        error,
        CoreError::ResourceLimit("max_pdf_total_stream_bytes")
    ));
}

#[test]
fn wrong_hint_empty_and_malformed_inputs_have_stable_outcomes() {
    let directory = tempfile::tempdir().unwrap();
    let source_docx = fixture_root().join("pocket-ai/office/multilingual.docx");
    let renamed = directory.path().join("provider-name.pdf");
    fs::copy(source_docx, &renamed).unwrap();
    let engine = PocketAnyDocEngine::new();
    let prepared = engine
        .prepare(
            &json!({
                "schemaVersion": 1,
                "requestId": "wrong-hint",
                "sourcePath": renamed,
                "privateRoot": directory.path(),
                "sourceSizeBytes": fs::metadata(directory.path().join("provider-name.pdf")).unwrap().len(),
                "displayName": "provider-name.pdf",
                "declaredMimeType": "application/pdf",
            })
            .to_string(),
        )
        .unwrap();
    assert_eq!(prepared["canonicalFormat"], "docx");
    assert!(
        prepared["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|warning| warning == "format_hint_mismatch")
    );

    for (name, bytes, expected) in [
        ("empty.docx", Vec::new(), "empty"),
        ("random.docx", b"not a document".to_vec(), "malformed"),
        ("truncated.pdf", b"%PDF-1.7\n1 0 obj".to_vec(), "malformed"),
    ] {
        let source = directory.path().join(name);
        fs::write(&source, bytes).unwrap();
        let result = PocketAnyDocEngine::new().prepare(
            &json!({
                "schemaVersion": 1,
                "requestId": format!("invalid-{name}"),
                "sourcePath": source,
                "privateRoot": directory.path(),
                "sourceSizeBytes": fs::metadata(directory.path().join(name)).unwrap().len(),
                "displayName": name,
            })
            .to_string(),
        );
        match expected {
            "empty" => assert!(matches!(result, Err(CoreError::NoExtractableText))),
            _ => assert!(matches!(result, Err(CoreError::Malformed))),
        }
    }
}

#[test]
fn asset_materialization_release_and_reprepare_are_deterministic() {
    let engine = Arc::new(PocketAnyDocEngine::new());
    let first = prepare_fixture(
        &engine,
        "pocket-ai/office/multilingual.docx",
        "assets-prepare-1",
    )
    .unwrap();
    let assets = first["assets"].as_array().unwrap();
    assert!(!assets.is_empty());
    let asset = &assets[0];
    let selected = select_all(&engine, &first, "assets-select").unwrap();
    assert!(selected["chunks"].as_array().unwrap().iter().any(|chunk| {
        chunk["assetIds"]
            .as_array()
            .is_some_and(|ids| ids.iter().any(|id| id == &asset["id"]))
    }));

    let output = tempfile::tempdir().unwrap();
    let extension = match asset["mediaType"].as_str().unwrap() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        other => panic!("unsupported validated corpus asset: {other}"),
    };
    let destination = output.path().join(format!("asset.{extension}"));
    let materialized = engine
        .materialize(
            &json!({
                "schemaVersion": 1,
                "requestId": "assets-materialize",
                "handle": first["handle"],
                "assetId": asset["id"],
                "destinationPath": destination,
                "privateRoot": output.path(),
            })
            .to_string(),
        )
        .unwrap();
    assert_eq!(materialized["sha256"], asset["sha256"]);
    assert_eq!(
        fs::metadata(&destination).unwrap().len(),
        asset["byteLength"]
    );

    let release = engine
        .release(&json!({"schemaVersion":1,"handle":first["handle"]}).to_string())
        .unwrap();
    assert_eq!(release["releasedCount"], 1);
    assert_eq!(release["removedAssetFiles"], 1);
    assert!(!destination.exists());

    let second = prepare_fixture(
        &engine,
        "pocket-ai/office/multilingual.docx",
        "assets-prepare-2",
    )
    .unwrap();
    assert_eq!(first["contentSha256"], second["contentSha256"]);
    assert_eq!(first["chunkCount"], second["chunkCount"]);
    assert_ne!(first["handle"], second["handle"]);
}

#[test]
fn supported_presentation_aliases_preserve_canonical_extension_and_content() {
    let capabilities = PocketAnyDocEngine::capabilities();
    let advertised = capabilities["formats"].as_array().unwrap();
    let directory = tempfile::tempdir().unwrap();
    for (alias, family) in [
        ("pot", "ppt"),
        ("pps", "ppt"),
        ("pptm", "pptx"),
        ("ppsx", "pptx"),
        ("ppsm", "pptx"),
    ] {
        assert!(advertised.iter().any(|format| format == alias));
        let source = directory.path().join(format!("alias.{alias}"));
        fs::copy(
            fixture_root().join(format!("pocket-ai/office/multilingual.{family}")),
            &source,
        )
        .unwrap();
        let engine = PocketAnyDocEngine::new();
        let prepared = engine
            .prepare(
                &json!({
                    "schemaVersion": 1,
                    "requestId": format!("alias-prepare-{alias}"),
                    "sourcePath": source,
                    "privateRoot": directory.path(),
                    "sourceSizeBytes": fs::metadata(directory.path().join(format!("alias.{alias}"))).unwrap().len(),
                    "displayName": format!("alias.{alias}"),
                })
                .to_string(),
            )
            .unwrap_or_else(|error| panic!("{alias}: {error:?}"));
        assert_eq!(prepared["canonicalFormat"], alias);
        let selected = select_all(&engine, &prepared, &format!("alias-select-{alias}")).unwrap();
        assert!(selection_text(&selected).contains("ORCHID-742"));
    }
}

#[test]
fn successful_epub_preserves_structured_multilingual_content() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("multilingual.epub");
    let file = fs::File::create(&source).unwrap();
    let mut archive = zip::ZipWriter::new(file);
    let stored =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    archive.start_file("mimetype", stored).unwrap();
    archive.write_all(b"application/epub+zip").unwrap();
    let deflated = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, body) in [
        (
            "META-INF/container.xml",
            r#"<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#,
        ),
        (
            "OEBPS/content.opf",
            r#"<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">pocket-epub</dc:identifier><dc:title>Pocket EPUB</dc:title><dc:language>en</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>"#,
        ),
        (
            "OEBPS/chapter.xhtml",
            r#"<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Pocket chapter</h1><p>English ORCHID-742. Русский ОРХИДЕЯ-742.</p></body></html>"#,
        ),
    ] {
        archive.start_file(name, deflated).unwrap();
        archive.write_all(body.as_bytes()).unwrap();
    }
    archive.finish().unwrap();

    let engine = PocketAnyDocEngine::new();
    let prepared = engine
        .prepare(
            &json!({
                "schemaVersion":1,
                "requestId":"epub-success-prepare",
                "sourcePath":source,
                "privateRoot":directory.path(),
                "sourceSizeBytes":fs::metadata(directory.path().join("multilingual.epub")).unwrap().len(),
                "displayName":"multilingual.epub",
            })
            .to_string(),
        )
        .unwrap();
    assert_eq!(prepared["canonicalFormat"], "epub");
    let selected = select_all(&engine, &prepared, "epub-success-select").unwrap();
    assert!(
        selected["chunks"]
            .as_array()
            .is_some_and(|chunks| !chunks.is_empty())
    );
    let text = selection_text(&selected);
    assert!(text.contains("ORCHID-742"));
    assert!(text.contains("ОРХИДЕЯ-742"));
}

#[test]
fn retained_encrypted_and_archive_abuse_fixtures_map_to_stable_classes() {
    for name in ["encrypted--errors.odt", "encrypted-secret123.pdf"] {
        let error = prepare_fixture(
            &PocketAnyDocEngine::new(),
            &format!("upstream-abuse/{name}"),
            &format!("encrypted-{name}"),
        )
        .unwrap_err();
        assert!(matches!(error, CoreError::Encrypted), "{name}: {error:?}");
    }
    for name in [
        "deepxml--errors.docx",
        "imagebomb--errors.docx",
        "zipbomb--errors.docx",
        "deepnest--errors.ppt",
    ] {
        let error = prepare_fixture(
            &PocketAnyDocEngine::new(),
            &format!("upstream-abuse/{name}"),
            &format!("abuse-{name}"),
        )
        .unwrap_err();
        assert!(
            matches!(error, CoreError::ResourceLimit(_)),
            "{name}: {error:?}"
        );
    }
    for name in [
        "hugerepeat--errors.ods",
        "emptyrowrepeat--errors.ods",
        "hugespan--errors.ods",
    ] {
        let error = prepare_fixture(
            &PocketAnyDocEngine::new(),
            &format!("upstream-anydoc-v0.1.7/abuse/{name}"),
            &format!("spreadsheet-abuse-{name}"),
        )
        .unwrap_err();
        assert!(
            matches!(error, CoreError::ResourceLimit(_)),
            "{name}: {error:?}"
        );
    }
}

#[test]
fn vendored_calamine_rejects_ods_repeats_spans_and_sparse_dense_ranges() {
    use calamine::Reader;

    for name in [
        "hugerepeat--errors.ods",
        "emptyrowrepeat--errors.ods",
        "hugespan--errors.ods",
    ] {
        let bytes = fs::read(
            fixture_root()
                .join("upstream-anydoc-v0.1.7/abuse")
                .join(name),
        )
        .unwrap();
        let result = calamine::Ods::new(Cursor::new(complete_ods_container(bytes)));
        let error = match result {
            Ok(_) => panic!("{name}: malicious ODS unexpectedly opened"),
            Err(error) => error,
        };
        assert!(
            error
                .to_string()
                .contains(calamine::MOBILE_CELL_LIMIT_MESSAGE),
            "{name}: {error}"
        );
    }

    let mut workbook = calamine::Xlsx::new(Cursor::new(sparse_xlsx_bytes()))
        .expect("sparse XLSX opens before worksheet materialization");
    let error = workbook
        .worksheet_range("S")
        .expect_err("sparse dense extent must be rejected before Range allocation");
    assert!(
        error
            .to_string()
            .contains(calamine::MOBILE_CELL_LIMIT_MESSAGE),
        "sparse XLSX: {error}"
    );
}
