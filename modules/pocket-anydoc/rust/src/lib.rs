#![deny(unsafe_code)]

//! Pocket AI's bounded, offline document conversion engine.

mod chunk;
mod engine;
mod error;
#[allow(unsafe_code)]
mod ffi;
mod limits;
mod materialize;
mod preflight;
mod runtime;
mod schema;
mod select;
mod xlsx;

#[cfg(test)]
mod corpus_tests;

pub use engine::PocketAnyDocEngine;
pub use ffi::PocketAnyDocBuffer;

pub(crate) const ABI_SCHEMA_VERSION: u32 = 1;
pub(crate) const ANYDOC_VERSION: &str = "0.1.7";
pub(crate) const ANYDOC_COMMIT: &str = "4a45addbd607e8b59f0c263bca26aab228e10370";
pub(crate) const PDF_INSPECTOR_COMMIT: &str = "1c32e4bd691bde83778ffef235019c8feac0c0c5";
pub(crate) const PATCH_REVISION: &str = "pocket-mobile-3";

#[cfg(test)]
mod provenance_tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn compiled_constants_and_locked_packages_match_upstream_manifest() {
        let manifest: Value = serde_json::from_str(include_str!("../UPSTREAM.json")).unwrap();
        assert_eq!(manifest["version"], ANYDOC_VERSION);
        assert_eq!(manifest["exactCommit"], ANYDOC_COMMIT);
        assert_eq!(manifest["patchRevision"], PATCH_REVISION);
        assert_eq!(
            manifest["components"]["anydoc"]["exactCommit"],
            ANYDOC_COMMIT
        );
        assert_eq!(
            manifest["components"]["pdfInspector"]["exactCommit"],
            PDF_INSPECTOR_COMMIT
        );

        let expo_package: Value = serde_json::from_str(include_str!("../../package.json")).unwrap();
        assert_eq!(expo_package["version"], env!("CARGO_PKG_VERSION"));
        let android_gradle = include_str!("../../android/build.gradle");
        assert!(android_gradle.contains(&format!("version = '{}'", env!("CARGO_PKG_VERSION"))));
        assert!(android_gradle.contains(&format!("versionName '{}'", env!("CARGO_PKG_VERSION"))));

        let lock = include_str!("../Cargo.lock");
        for (component, package_name) in [
            ("anydoc", "anydoc"),
            ("pdfInspector", "pdf-inspector"),
            ("calamine", "calamine"),
            ("lopdf", "lopdf"),
        ] {
            let version = manifest["components"][component]["version"]
                .as_str()
                .unwrap();
            assert!(
                locked_package_has_version(lock, package_name, version),
                "Cargo.lock does not match UPSTREAM.json for {component}"
            );
        }
    }

    fn locked_package_has_version(lock: &str, name: &str, version: &str) -> bool {
        lock.split("[[package]]").any(|package| {
            package
                .lines()
                .any(|line| line.trim() == format!("name = \"{name}\""))
                && package
                    .lines()
                    .any(|line| line.trim() == format!("version = \"{version}\""))
        })
    }
}
