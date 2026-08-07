# Documentation Guide

This folder contains the public maintainer-facing documentation for Pocket AI.

## Documents

- [`workflow.md`](./workflow.md): branching model, PR title conventions, CI checks, and automated releases
- [`background-tasks.md`](./background-tasks.md): background downloads/inference, Android foreground service constraints, and notification permission behavior
- [`privacy-disclosures.md`](./privacy-disclosures.md): summary of what stays on-device, when the app uses the network, and which local-data controls are available
- [`release-checklist.md`](./release-checklist.md): pre-release verification steps, manual QA flow, and release-facing files that must stay aligned
- [`new-architecture.md`](./new-architecture.md): notes about React Native New Architecture, native-module expectations, and troubleshooting direction
- [`ui-architecture.md`](./ui-architecture.md): conventions for UI structure, imports, layout, styling, and localization
- [`model-parameters.md`](./model-parameters.md): how generation/load parameters are stored, snapshotted, and mapped to runtime engine settings
- [`multimodal-attachments.md`](./multimodal-attachments.md): runtime media payload contracts, local attachment lifecycle boundaries, and privacy constraints
- [`document-processing.md`](./document-processing.md): offline document formats, native parser boundary, resource limits, context selection, and update procedure
- [`document-qa-benchmarks.md`](./document-qa-benchmarks.md): synthetic Android document scenarios, sentinel-only evidence, and reproducible host/device benchmark reports
- [`runtime-performance.md`](./runtime-performance.md): bounded chat, model-load, catalog, storage-scan, telemetry, and regression contracts
- [`runtime-hardening-device-validation.md`](./runtime-hardening-device-validation.md): physical-device model/backend matrix, fail-closed prompt state-cache checks, future A/B protocol, and honest evidence template
- [`android-build.md`](./android-build.md): Android release signing, bundling, and Play Store versioning
- [`ios-build.md`](./ios-build.md): iOS archive, Xcode distribution, signing, and TestFlight upload

## When to update these files

Review this folder whenever you change:

- product messaging in the public `README`
- privacy or network behavior
- model discovery, variant selection, or download behavior
- multimodal runtime, attachment lifecycle, or media diagnostics behavior
- runtime performance contracts, instrumentation, cache ownership, or cancellation behavior
- release flow or build metadata
- native architecture assumptions
- UI component conventions or localization rules
