# Privacy & Disclosures

Last updated: 2026-04-06

## Summary

Pocket AI is an offline-first mobile assistant built around local GGUF models. After a model has been downloaded and loaded, chat inference runs on-device instead of through a hosted chat-completion API.

This document summarizes the current behavior of the app as configured in this repository. It is intended as a product-facing disclosure summary, not a legal policy template.

## What stays on-device

- Chat prompts and generated responses stay on the device during local inference.
- Downloaded GGUF files are stored in app-managed local storage.
- Conversation history is persisted locally on the device and encrypted at rest.
- System prompt presets, generation settings, and model-specific load profiles are persisted locally on the device and encrypted at rest.
- An optional Hugging Face access token can be stored locally in secure device storage for browsing and downloading gated or private models.
- Catalog metadata such as resolved GGUF size, access state, and local download status is cached locally only for app behavior and is not synced to a hosted account service.
- Recent first-page Hugging Face catalog results and recently opened public model-detail snapshots are stored in a bounded on-device cache so the catalog can reopen quickly on this device.
- Hugging Face popularity metadata, tag summaries, and routed model-detail state are cached locally only to improve catalog browsing on this device.
- Storage cleanup controls are available in-app through `Storage Manager` and `All Conversations`, including model removal that can keep or reset saved per-model settings.

## When the app uses the network

Pocket AI uses the network only for model-management flows:

- Hugging Face model catalog search
- Optional metadata, README summary, and config fetches used for model hints, popularity sorting, size recovery, context-window recovery, and gated-model access checks
- Model file downloads from remote hosting endpoints
- If a Hugging Face access token is configured, the app attaches it to Hugging Face API requests as needed to surface gated or private repositories (including catalog browsing). Some endpoints are still probed anonymously first and retried with auth only when required.
- When a user taps through to Hugging Face from the token screen or a model detail view, the app opens the public Hugging Face site in the device browser

The app can display public, token-required, and access-denied Hugging Face repositories in the same catalog. When a token is configured, token-scoped catalog state is kept only in memory and is cleared when the token is updated or removed; the on-disk catalog cache stores only anonymous/public results. Saving or clearing a token clears the local Hugging Face catalog cache so stale access labels are not reused. When the network is available, cached first-page catalog results are revalidated against Hugging Face on reopen.

The current release flow in this repository does not send chat prompts to a hosted chat-completion API.

## Local data controls

Users can manage local data directly in the app:

- offload downloaded models while keeping or resetting saved per-model settings
- unload the active model
- clear persisted chat history
- reset settings
- manage retention for older conversations

## Device and resource limits

Local inference is constrained by the device:

- large GGUF models can exceed available RAM
- large downloads can exceed available storage
- sustained inference can increase thermal pressure and reduce responsiveness
- the maximum context window exposed in model controls can be reduced by verified model limits and estimated RAM headroom on the current device

The app includes warnings for risky operations such as low-disk downloads, cellular downloads, and models that may not fit into available memory. If the safest available load profile still exceeds the estimated RAM budget (or a model only fits at the minimum context window of 512 tokens), the app marks it as `Won't fit RAM` and blocks the load instead of attempting the native model initialization. When required, the app can unload the active model to protect stability.

## Release configuration in this repository

For the release configuration currently committed here:

- Android package name: `com.github.tah10n.pocketai`
- Android auto-backup is disabled to avoid backing up local chat and model state
- Android permissions are limited to `INTERNET` and `VIBRATE`

## Scope note

This document describes the behavior of the code in this repository at the time of writing. If the product's privacy or networking behavior changes, this file should be updated alongside [`README.md`](../README.md) and [`app.json`](../app.json).
