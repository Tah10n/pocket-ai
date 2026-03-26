# Privacy & Disclosures

Last updated: 2026-03-26

## Product summary

Pocket AI is an offline-first mobile assistant focused on local GGUF models. The app is designed so that chat inference runs on-device after a model has been downloaded and loaded into memory.

## What stays on-device

- Chat prompts and generated responses stay on the device during local inference.
- Downloaded GGUF models are stored in app-managed local storage.
- Conversation history, system-prompt presets, and generation settings are persisted locally on the device.
- Storage cleanup controls are available in-app through `Storage Manager` and `All Conversations`.

## When the app uses the network

Pocket AI uses the network only for model-management flows:

- Hugging Face model catalog search
- Optional Hugging Face metadata/config fetches used for model hints
- Model file downloads from remote hosting endpoints

The app does not use a hosted chat-completion API in the v1 release flow.

## Device-resource disclosures

- Large models can exceed available RAM, reduce responsiveness, or trigger operating-system pressure.
- The app warns before risky operations such as low-disk downloads, cellular downloads, and models that may not fit into RAM.
- The app monitors memory and thermal state so it can warn the user and unload the active model when needed.

## Local data controls

Users can:

- offload downloaded models
- unload the active model
- clear persisted chat history
- reset settings
- manage retention for old conversations

## Android release note

For the release configuration committed in this repository:

- the Android app identifier is `com.antigravity.pocketai`
- Android auto-backup is disabled to avoid backing up local chat/model state through platform backup flows
- only the minimal `INTERNET` and `VIBRATE` permissions are declared in the app config
