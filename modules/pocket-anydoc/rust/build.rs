fn main() {
    // The checked-in C ABI header is an input to the mobile artifact
    // fingerprint even though no code is generated at build time.
    println!("cargo:rerun-if-changed=../include/pocket_anydoc.h");
    println!("cargo:rerun-if-changed=build.rs");
}
