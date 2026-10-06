# Manual audio and voice check

Use a local Android QA build with downloaded, compatible model resources. Record only your own voice or a sample you have permission to use. A passed UI check does not prove speaker conditioning or intelligible synthesis. Keep separate outcomes for recording, audio input, playback, built-in voices, phonemization and reference conditioning.

## Record and send

1. Select a chat model and its matching audio projector. Open the attachment menu and **Record audio**. Opening the sheet must not activate the microphone.
2. Tap **Record audio**, say “The parcel is orange, and the code is seven”, then **Stop recording** after 3–5 seconds. Wait for the file-ready state. The timer must reflect actual recording.
3. Preview the take, stop preview, then **Record again**. The prior take must stop before the next recording begins. Record a different sentence and attach it. Attachment does not send automatically.
4. Send a request to describe the attached sound. The answer must match the second recording. Reopen the conversation after restarting the app: the attachment remains, and recording does not restart.
5. Start another recording, leave the app, then return. Recording stays stopped. Closing the sheet discards an un-attached take.

## Read aloud

1. Open **Read aloud** in Chat. Text and the current voice summary should be visible without technical controls. Enter “The quiet river flows beside the old bridge.”
2. The recommended summary is **English · OuteTTS 1.0 (0.6B)** with **Default**. If it is missing, expand the summary and choose **Download recommended voice** (about 524 MiB), or **Use recommended voice** when the files are already installed. This selects the exact model and decoder together. Other language/voice choices belong to their selected model and need their own content verification.
3. Tap **Create speech** and listen to the complete new sentence. **Starting** is distinct from **Playing**. Stop during generation, create speech again, then Replay the existing clip. Replay must not load the model again.
4. Paste more than 240 characters: the full draft remains and speech is disabled. Structured text must show the exact input and require explicit review.

## Voice sample and persistence

1. In a compatible reference model, expand the voice summary, choose **My sample**, then record or choose a WAV/MP3/M4A sample up to 8 seconds. Selecting this mode must not activate the microphone.
2. Preview the sample. Speech remains disabled until permission is explicitly confirmed. Temporary samples disappear when the sheet closes.
3. Open **Save this voice for later**, name the voice, then explicitly save. Close and restart the app. The saved voice remains selectable; no old native speaker handle, capture or synthesis resumes.
4. Produce the same new target sentence with two different permitted samples. Compare the audible voice while confirming that the words are the target sentence. Different WAV hashes alone do not establish voice conditioning.
5. Repeat with **Prepare voice first** and **Prepare voice when used** under Advanced settings. Change the sample and return to Default. Delete a selected saved voice, restart, and confirm it is gone.
6. Start from a chat model with a LoRA if available. After speech finishes, send a normal chat prompt and verify that the original model and LoRA are restored.

Record a memory refusal as a refusal. Do not disable admission or decoder limits to produce a pass. The Stage 7 [acceptance report](validation/llama-rn-stage7/acceptance.md) lists device limitations and native paths still awaiting verification.
