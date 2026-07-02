#!/usr/bin/env python3
"""
faster_whisper_transcribe.py

Small CLI helper used by backend/whisper.js when STT_ENGINE=fasterwhisper.
Uses the free, open-source `faster-whisper` library (CTranslate2 backend)
to transcribe a WAV file and print the resulting text to stdout.

Install:
    pip install faster-whisper

Usage:
    python3 faster_whisper_transcribe.py --audio call.wav --model medium \
        --device cpu --language hi
"""

import argparse
import sys

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--audio', required=True, help='Path to WAV file')
    parser.add_argument('--model', default='medium', help='Whisper model size (tiny/base/small/medium/large-v3)')
    parser.add_argument('--device', default='cpu', help='cpu or cuda')
    parser.add_argument('--language', default='hi', help='Language hint, e.g. hi')
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print('ERROR: faster-whisper is not installed. Run: pip install faster-whisper', file=sys.stderr)
        sys.exit(1)

    compute_type = 'int8' if args.device == 'cpu' else 'float16'
    model = WhisperModel(args.model, device=args.device, compute_type=compute_type)

    segments, _info = model.transcribe(
        args.audio,
        language=args.language,
        beam_size=5,
        vad_filter=True,  # skip silence for lower latency
    )

    text = ' '.join(segment.text.strip() for segment in segments)
    print(text.strip())


if __name__ == '__main__':
    main()
