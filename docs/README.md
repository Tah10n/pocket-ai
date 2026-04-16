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
- [`android-build.md`](./android-build.md): Android release signing, bundling, and Play Store versioning
- [`ios-build.md`](./ios-build.md): iOS archive, Xcode distribution, signing, and TestFlight upload

## When to update these files

Review this folder whenever you change:

- product messaging in the public `README`
- privacy or network behavior
- release flow or build metadata
- native architecture assumptions
- UI component conventions or localization rules
