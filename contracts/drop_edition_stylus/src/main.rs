// Bin shim — exists only so `cargo run --features export-abi` (invoked by
// cargo-stylus) has a target. All contract logic lives in `lib.rs`.
#![cfg_attr(not(feature = "export-abi"), no_main)]

#[cfg(feature = "export-abi")]
fn main() {
    drop_edition_stylus::print_abi("MIT-OR-APACHE-2.0", "pragma solidity ^0.8.23;");
}

#[cfg(not(feature = "export-abi"))]
fn main() {}
