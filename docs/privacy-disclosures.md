# Privacy & Disclosures

Last updated: 2026-03-27

## Summary

Pocket AI is an offline-first mobile assistant built around local GGUF models. After a model has been downloaded and loaded, chat inference runs on-device instead of through a hosted chat-completion API.

This document summarizes the current behavior of the app as configured in this repository. It is intended as a product-facing disclosure summary, not a legal policy template.

## What stays on-device

- Chat prompts and generated responses stay on the device during local inference.
- Downloaded GGUF files are stored in app-managed local storage.
- Conversation history is persisted locally on the device.
- System prompt presets and generation settings are persisted locally on the device.
- Storage cleanup controls are available in-app through `Storage Manager` and `All Conversations`.

## When the app uses the network

Pocket AI uses the network only for model-management flows:

- Hugging Face model catalog search
- Optional metadata and config fetches used for model hints
- Model file downloads from remote hosting endpoints

The current release flow in this repository does not send chat prompts to a hosted chat-completion API.

## Local data controls

Users can manage local data directly in the app:

- offload downloaded models
- unload the active model
- clear persisted chat history
- reset settings
- manage retention for older conversations

## Device and resource limits

Local inference is constrained by the device:

- large GGUF models can exceed available RAM
- large downloads can exceed available storage
- sustained inference can increase thermal pressure and reduce responsiveness

The app includes warnings for risky operations such as low-disk downloads, cellular downloads, and models that may not fit into available memory. When required, the app can unload the active model to protect stability.

## Release configuration in this repository

For the release configuration currently committed here:

- Android package name: `com.github.tah10n.pocketai`
- Android auto-backup is disabled to avoid backing up local chat and model state
- Android permissions are limited to `INTERNET` and `VIBRATE`

## Scope note

This document describes the behavior of the code in this repository at the time of writing. If the product's privacy or networking behavior changes, this file should be updated alongside [`README.md`](../README.md) and [`app.json`](../app.json).
