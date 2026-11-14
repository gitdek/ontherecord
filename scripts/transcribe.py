#!/usr/bin/env python3
"""Writes down what is said in one sound file, with MLX Whisper, as JSON on standard output.

usage: transcribe.py --model MODEL --input SOUND [--language CODE]
       transcribe.py --check

MODEL is a folder that holds an MLX Whisper model, or the name of one already in the Hugging Face cache
(mlx-community/whisper-large-v3-turbo, say). The server starts this with HF_HUB_OFFLINE=1, so nothing is
downloaded: a model that is not on this Mac is an error.

The output is {"language": "en", "segments": [{"id", "start", "end", "text"}, ...]}, times in seconds. When
something goes wrong, one line on standard error says what, since the server shows only the start of it.
--check only says, by its exit status, whether this Python has mlx_whisper (0) or not (3), without loading it.
"""
import argparse
import importlib.util
import json
import math
import sys


def number(value):
    # a time can come back as a NumPy or MLX number rather than a Python float
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--model')
    parser.add_argument('--input')
    parser.add_argument('--language', default='')
    args = parser.parse_args()
    if args.check:
        return 0 if importlib.util.find_spec('mlx_whisper') else 3
    if not args.model or not args.input:
        parser.error('--model and --input are required')
    try:
        import mlx_whisper
    except Exception as err:  # the Python this was started with has no mlx_whisper
        print(f'mlx_whisper is not installed for this Python ({err})', file=sys.stderr)
        return 3
    options = {}
    if args.language:
        options['language'] = args.language
    # Only the JSON goes to standard output: anything a library prints on the way goes to standard error.
    out = sys.stdout
    sys.stdout = sys.stderr
    try:
        # Each window is heard on its own, and a long silence is skipped: with the defaults a quiet stretch can
        # set the model repeating one line for the rest of the recording.
        result = mlx_whisper.transcribe(
            args.input,
            path_or_hf_repo=args.model,
            verbose=None,
            condition_on_previous_text=False,
            word_timestamps=True,
            hallucination_silence_threshold=2.0,
            **options,
        )
    except Exception as err:
        print(f'{type(err).__name__}: {" ".join(str(err).split())}'[:400], file=sys.stderr)
        return 1
    finally:
        sys.stdout = out
    segments = []
    for heard in result.get('segments') or []:
        text = ' '.join(str(heard.get('text') or '').split())
        start, end = number(heard.get('start')), number(heard.get('end'))
        if not text or start is None or end is None or start < 0:
            continue
        segment = {'id': len(segments), 'start': round(start, 3), 'end': round(max(end, start), 3), 'text': ' ' + text}
        for key in ('no_speech_prob', 'avg_logprob'):
            value = number(heard.get(key))
            if value is not None:
                segment[key] = round(value, 4)
        segments.append(segment)
    sys.stdout.reconfigure(encoding='utf-8')
    json.dump({'language': str(result.get('language') or args.language or ''), 'segments': segments}, sys.stdout, ensure_ascii=False, allow_nan=False)
    return 0


if __name__ == '__main__':
    sys.exit(main())
