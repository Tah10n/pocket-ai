#!/usr/bin/env python3
"""Reproduce the fixed synthetic Neu reference from local, hash-pinned inputs.

Copyright (c) 2026 Pocket AI contributors. SPDX-License-Identifier: MIT
This asset tool does not establish native Neu compatibility or speech quality.
"""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import socket
import sys
import wave

WAV_SHA256 = '7a6668e6184eba856b5f324f5388cdf03e9fd76cd9d7b06b27948da98ea8aa70'
PAYLOAD_SHA256 = '2d80b34675fb03b5a5f2af86738d0549cce00bd08a165fc6badc5a9ba88473b0'
ENCODER = ('distill_neucodec_encoder.onnx', 276970840,
           '04af54f6af51a7573a8bbcfd691b4f2c68b6dbd03aef72b983cbb4e5140c3a23')
ENCODER_DATA = ('distill_neucodec_encoder.onnx.data', 241565696,
                '935859ed7904671dc82da1c533b9bf2fd8bcf6d8fc702bdba5bc25c8f7329e4f')
VERSIONS = {'onnxruntime': '1.31.0', 'numpy': '2.5.4', 'scipy': '1.18.1',
            'flatbuffers': '25.12.19', 'packaging': '26.3', 'protobuf': '7.36.2'}


class InputError(Exception):
    """Closed validation error, without input contents or paths."""


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as source:
        while chunk := source.read(1024 * 1024):
            value.update(chunk)
    return value.hexdigest()


def verify_file(path, size, expected):
    if not path.is_file() or path.stat().st_size != size or digest(path) != expected:
        raise InputError('input_identity_mismatch')


def verify_wav(path):
    verify_file(path, 158748, WAV_SHA256)
    with wave.open(str(path), 'rb') as source:
        if (source.getframerate(), source.getnchannels(), source.getsampwidth(),
                source.getnframes(), source.getcomptype()) != (24000, 1, 2, 79352, 'NONE'):
            raise InputError('wav_format_mismatch')
        pcm = source.readframes(source.getnframes())
    if len(pcm) != 79352 * 2 or digest(path) != WAV_SHA256:
        raise InputError('wav_changed_or_truncated')
    return pcm


def verify_encoder(encoder, data):
    if encoder.name != ENCODER[0] or data.name != ENCODER_DATA[0] or encoder.parent != data.parent:
        raise InputError('encoder_external_data_layout')
    verify_file(encoder, ENCODER[1], ENCODER[2])
    verify_file(data, ENCODER_DATA[1], ENCODER_DATA[2])


def encode(pcm_bytes, encoder):
    # Preserve the original generation path; target text is not an ASR/model hint.
    import numpy as np
    from scipy.signal import resample_poly
    import onnxruntime as ort

    pcm = np.frombuffer(pcm_bytes, dtype='<i2').astype(np.float64) / 32768.0
    resampled = resample_poly(pcm, 2, 3).astype(np.float32)
    if not np.isfinite(resampled).all() or np.max(np.abs(resampled)) > 1:
        raise InputError('resampled_pcm')
    padding = 320 - (len(resampled) % 320)
    if len(resampled) != 52902 or padding != 218:
        raise InputError('resampling_shape')
    if hashlib.sha256(resampled.tobytes()).hexdigest() != '0d8e90ae21f3dcb162906d9f2e42cfa6e4049999b204a0ba969492dac9a4035c':
        raise InputError('resampling_identity')
    x = np.pad(resampled, (0, padding))[None, None, :].astype(np.float32)
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 2
    opts.inter_op_num_threads = 1
    opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    opts.enable_cpu_mem_arena = False
    session = ort.InferenceSession(str(encoder), sess_options=opts, providers=['CPUExecutionProvider'])
    inputs = session.get_inputs()
    if len(inputs) != 1 or inputs[0].name != 'audio' or inputs[0].type != 'tensor(float)':
        raise InputError('onnx_input_contract')
    out = session.run(None, {'audio': x})
    if len(out) != 1:
        raise InputError('onnx_output_count')
    codes = out[0]
    if (codes.shape != (1, 1, x.shape[-1] // 320) or codes.dtype not in (np.int32, np.int64)
            or np.any(codes < 0) or np.any(codes >= 65536)):
        raise InputError('code_contract')
    payload = {'schemaVersion': 1, 'id': 'pocket-synthetic-en-v1', 'language': 'en-us',
               'ref_text': 'The quiet river flows beside the old bridge.', 'ref_codes': codes.flatten().tolist()}
    return (json.dumps(payload, ensure_ascii=False, indent=2) + '\n').encode('utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wav', type=Path, required=True, help='Exact source WAV supplied in assets/tts')
    parser.add_argument('--encoder', type=Path, help='Pinned local distill_neucodec_encoder.onnx')
    parser.add_argument('--encoder-data', type=Path, help='Pinned sibling ONNX external-data file')
    parser.add_argument('--output', type=Path, help='New output JSON; existing paths are never overwritten')
    parser.add_argument('--verify-inputs', action='store_true', help='Stdlib-only validation; encoder pair optional, no encoding')
    args = parser.parse_args()
    if bool(args.encoder) != bool(args.encoder_data):
        parser.error('--encoder and --encoder-data must be supplied together')
    if not args.verify_inputs and (not args.encoder or not args.output):
        parser.error('generation requires --wav, --encoder, --encoder-data and --output')
    if args.verify_inputs and args.output:
        parser.error('--output is not used with --verify-inputs')
    try:
        if args.output and (args.output.exists() or args.output.is_symlink() or not args.output.parent.is_dir()):
            raise InputError('output_exists_or_parent_missing')
        pcm = verify_wav(args.wav)
        encoder = args.encoder.resolve() if args.encoder else None
        data = args.encoder_data.resolve() if args.encoder_data else None
        if encoder:
            verify_encoder(encoder, data)
        if args.verify_inputs:
            print(json.dumps({'status': 'inputs_verified', 'wavSha256': WAV_SHA256,
                              'encoderVerified': encoder is not None, 'encodingRun': False}))
            return 0
        if sys.version_info[:3] != (3, 12, 10):
            raise InputError('python_version_requires_3_12_10')
        for name, version in VERSIONS.items():
            if importlib.metadata.version(name) != version:
                raise InputError('dependency_version_mismatch')
        os.environ.update(OMP_NUM_THREADS='2', OPENBLAS_NUM_THREADS='2', MKL_NUM_THREADS='2',
                          NUMEXPR_NUM_THREADS='2', PYTHONNOUSERSITE='1')
        def offline(*_args, **_kwargs):
            raise InputError('network_disabled')
        socket.create_connection = offline
        socket.socket.connect = offline
        socket.socket.connect_ex = offline
        result = encode(pcm, encoder)
        if hashlib.sha256(result).hexdigest() != PAYLOAD_SHA256:
            raise InputError('generated_payload_identity_mismatch')
        # Recheck all source files before publishing the result, without replacing any file.
        verify_wav(args.wav)
        verify_encoder(encoder, data)
        with args.output.open('xb') as output:
            output.write(result)
        print(json.dumps({'status': 'generated', 'sha256': PAYLOAD_SHA256, 'bytes': len(result), 'codeCount': 166}))
        return 0
    except InputError as error:
        print(json.dumps({'status': 'failed', 'error': str(error)}), file=sys.stderr)
    except Exception as error:
        print(json.dumps({'status': 'failed', 'error': 'generation_failed', 'exceptionType': type(error).__name__}), file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())