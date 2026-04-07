# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Model controls: seed (random vs fixed) for reproducible generation.
- Load profiles: KV cache precision selector (`auto`, `f16`, `q8_0`, `q4_0`).

### Changed
- Model loading: improved GPU-layer recommendations and safer fallback behavior when GPU initialization fails.
