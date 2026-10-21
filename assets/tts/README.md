# Synthetic Neu reference source

`pocket-synthetic-en-v1.source.wav` is an original synthetic, speakerless OuteTTS output, with no imported human reference or upstream Neu voice sample. Its eight-word transcript is **The quiet river flows beside the old bridge.** The generated JSON contains 166 reference codes and the plain transcript. Production synthesis phonemizes that transcript and each requested target independently; it does not use stored target phonemes.

The source WAV and generated JSON are provided under the project's [MIT license](../../LICENSE), preserving its copyright and permission notice. The generator is also MIT-licensed. Model weights, the encoder, and the GPL-enabled native phonemizer retain their separate license scopes; see [provenance](pocket-synthetic-en-v1.provenance.json) and [distribution requirements](../../DISTRIBUTION.md). The WAV is regeneration source only: application code does not import it or bundle it as a runtime asset.

## Exact inputs

- Source WAV: 158,748 bytes, mono PCM16, 24 kHz, 79,352 samples; SHA-256 `7a6668e6184eba856b5f324f5388cdf03e9fd76cd9d7b06b27948da98ea8aa70`.
- Encoder: [distill_neucodec_encoder.onnx](https://huggingface.co/KevinAHM/distill-neucodec-onnx/resolve/2cd5cf022b7a1e689e561f0492787768cfe8395d/onnx/distill_neucodec_encoder.onnx), 276,970,840 bytes; SHA-256 `04af54f6af51a7573a8bbcfd691b4f2c68b6dbd03aef72b983cbb4e5140c3a23`.
- External data: [distill_neucodec_encoder.onnx.data](https://huggingface.co/KevinAHM/distill-neucodec-onnx/resolve/2cd5cf022b7a1e689e561f0492787768cfe8395d/onnx/distill_neucodec_encoder.onnx.data), 241,565,696 bytes; SHA-256 `935859ed7904671dc82da1c533b9bf2fd8bcf6d8fc702bdba5bc25c8f7329e4f`.

Both encoder files must retain those names in the same directory. The generator makes no network requests and verifies their exact sizes and hashes. Download them separately from the pinned revision above. They are not included in this repository.

## Reproduction

Run from the repository root with Windows x86-64 **CPython 3.12.10**. Create a separate environment and install the six exact packages from `scripts/neu-synthetic-reference-requirements-windows-cp312.txt` using pip's hash enforcement. That file audits Windows CPython 3.12 wheels only; other platforms require their own wheel/hash audit. It does not authorize floating versions or replacement model files.

```powershell
python -m venv .venv-neu-reference
.venv-neu-reference/Scripts/python.exe -m pip install --no-cache-dir --require-hashes -r scripts/neu-synthetic-reference-requirements-windows-cp312.txt
.venv-neu-reference/Scripts/python.exe -I scripts/generate-neu-synthetic-reference.py --wav assets/tts/pocket-synthetic-en-v1.source.wav --encoder encoder/distill_neucodec_encoder.onnx --encoder-data encoder/distill_neucodec_encoder.onnx.data --output pocket-synthetic-en-v1.generated.json
```

The output path must not exist. Expected output SHA-256: `2d80b34675fb03b5a5f2af86738d0549cce00bd08a165fc6badc5a9ba88473b0`. A mismatch fails before writing output. JSON uses UTF-8, two-space indentation and a final LF.

The pipeline converts PCM16 to float64, resamples 24 kHz to 16 kHz with SciPy polyphase `2/3`, casts to float32, pads the resulting 52,902 samples with 218 zeros, then runs the encoder using ONNX Runtime's CPU provider with two intra-op threads and one inter-op thread. It verifies the resampled PCM hash and the final payload hash. The encoder output is not a proof of native Neu compatibility or speech quality; those require separate native synthesis and content evaluation.

For standard-library-only source validation, without installing dependencies or running the encoder:

```powershell
python -I scripts/generate-neu-synthetic-reference.py --wav assets/tts/pocket-synthetic-en-v1.source.wav --verify-inputs
```

This reports only WAV verification. Add both encoder arguments to verify their identities too. `--help` and `--verify-inputs` do not import NumPy, SciPy or ONNX Runtime.