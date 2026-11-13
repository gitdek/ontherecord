#!/usr/bin/env python3
"""Who spoke when in one recording, and a voiceprint for each voice, using sherpa-onnx (pyannote segmentation
plus NeMo TitaNet speaker embeddings). Everything runs on this Mac; nothing is sent anywhere.

  diarize.py --segmentation model.onnx --embedding titanet.onnx --input recording.mp4
             [--lines lines.json] [--read-text read-text.swift]
  diarize.py ... --input recording.mp4 --turns turns.json --read-text read-text.swift

Prints one JSON object:
  {"version": 1, "duration": s, "turns": [[start, end, speaker], ...],
   "speakers": {"0": {"seconds": s, "voiceprint": [...]}, ...},
   "lines": {"speakers": [0, 1, ...], "sims": [[0.71, 0.02, ...] or null, ...]},
   "screen": {"0": {"name": "Ada Lovelace", "votes": 5, "of": 6}, ...}}
Speakers are numbered in order of first appearance. With --lines (a transcript's lines as [[start, end], ...]),
each line's own voice is compared with every main speaker's, which catches a short interjection inside someone
else's turn. With --read-text (scripts/read-text.swift, macOS Vision), a screen recording of a Google Meet call
names its voices: while one voice talks alone, Meet outlines that person's tile in light blue, and the name on
the tile is read off a few such moments. With --turns (who spoke when, as [[start, end, speaker], ...] on the
recording's timeline: a caption export's labels, say), the audio is skipped and only the names are read, printed
as {"version": 1, "screen": {...}}. The recording is decoded by ffmpeg as a plain local media file (no playlists,
no network)."""
import argparse
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
from collections import Counter

import numpy as np
import sherpa_onnx

VERSION = 1
RATE = 16000
FORMATS = 'mov,matroska,webm,mp3,wav,aac,ogg,flac'
# sherpa-onnx groups second-long pieces of speech with a strict cutoff, so one person usually comes back as
# many small groups. Whole groups are then merged by their averaged voice, which is far steadier: on our
# meetings a person's groups score 0.9+ against each other and different people about 0.1.
MERGE = 0.45  # two groups this alike are one person
STRAY = 0.25  # a scrap of speech this alike to someone is theirs
ALONE = 2.0  # seconds of a voice unlike everyone else's before it counts as another speaker
MAIN = 8.0  # seconds of speech before a voice is steady enough to compare lines against
LOOKS = 6  # moments looked at per voice when reading names off the screen


def audio(path):
    out = subprocess.run(
        ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file',
         '-format_whitelist', FORMATS, '-i', path, '-vn', '-ac', '1', '-ar', str(RATE), '-f', 's16le', 'pipe:1'],
        capture_output=True, check=True)
    return np.frombuffer(out.stdout, dtype=np.int16).astype(np.float32) / 32768.0


def unit(v):
    v = np.asarray(v, dtype=np.float32)
    n = float(np.linalg.norm(v))
    return v / n if n else v


# ---------- names off the screen ----------

def frame(path, t, width=1920):
    out = subprocess.run(
        ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file',
         '-format_whitelist', FORMATS, '-ss', f'{max(0.0, t):.2f}', '-i', path, '-frames:v', '1',
         '-vf', f'scale={width}:-2', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
        capture_output=True)
    if out.returncode or not out.stdout or len(out.stdout) % (width * 3):
        return None
    return np.frombuffer(out.stdout, dtype=np.uint8).reshape(-1, width, 3)


def runs(row, minrun):
    """(start, length) of every stretch of True in a row of pixels at least minrun long."""
    padded = np.concatenate(([False], row, [False])).astype(np.int8)
    edges = np.flatnonzero(np.diff(padded))
    starts, lengths = edges[::2], edges[1::2] - edges[::2]
    keep = lengths >= minrun
    return list(zip(starts[keep].tolist(), lengths[keep].tolist()))


def highlighted_tile(rgb):
    """The tile Google Meet outlines while that person talks, as (x0, y0, x1, y1), or None unless there's exactly
    one. The outline is light blue around a video, or a light tint of the tile's own colour when the camera is
    off: either way a thin bright line of one colour, on the dark page between the tiles."""
    img = rgb.astype(np.int32)
    h, w, _ = img.shape
    lum = (img[..., 0] * 299 + img[..., 1] * 587 + img[..., 2] * 114) // 1000
    smooth = np.zeros((h, w), dtype=bool)
    smooth[:, 1:] = np.abs(np.diff(img, axis=1)).sum(axis=2) <= 30
    line = (lum >= 150) & smooth
    minrun = max(80, w // 20)
    # long straight runs of one bright colour, joined down the rows they continue on: the top and bottom
    # edges of an outline (alongside, in presentation mode, the shared screen's own bright areas)
    bands = []
    for y in np.flatnonzero(line.sum(axis=1) >= minrun):
        for x0, length in runs(line[y], minrun):
            color = img[y, x0:x0 + length].mean(axis=0)
            band = next((b for b in reversed(bands) if y - b['y1'] <= 2 and abs(b['x0'] - x0) <= 20 and abs(b['x1'] - x0 - length) <= 20 and np.abs(b['color'] - color).max() <= 40), None)
            if band:
                band.update(y1=y, x0=min(band['x0'], x0), x1=max(band['x1'], x0 + length))
            else:
                bands.append({'y0': y, 'y1': y, 'x0': x0, 'x1': x0 + length, 'color': color})

    def near(block, color):
        return np.abs(block - color).max(axis=-1) <= 45

    tiles = []
    for i, top in enumerate(bands):
        # thin, with the dark page just above it (a box on a shared slide sits on a light background)
        if top['y1'] - top['y0'] > 8 or top['y0'] < 4 or lum[top['y0'] - 4:top['y0'] - 1, top['x0']:top['x1']].mean() > 80:
            continue
        for bottom in bands[i + 1:]:
            if bottom['y1'] - bottom['y0'] > 8 or bottom['y0'] - top['y1'] < 60:
                continue
            if abs(top['x0'] - bottom['x0']) > 20 or abs(top['x1'] - bottom['x1']) > 20 or np.abs(top['color'] - bottom['color']).max() > 40:
                continue
            inner = img[top['y1'] + 20:bottom['y0'] - 20]
            # an outline, not a filled box
            if not len(inner) or near(inner[:, top['x0']:top['x1']], top['color']).mean() > 0.2:
                continue

            # the sides: a column of the colour just outside where the straight edges end (corners are rounded)
            def side(lo, hi):
                cols = near(inner[:, max(0, lo):min(w, hi)], top['color'])
                return cols.mean(axis=0).max() if cols.size else 0
            if side(top['x0'] - 40, top['x0'] + 10) > 0.7 and side(top['x1'] - 10, top['x1'] + 40) > 0.7:
                tile = (max(0, top['x0'] - 30), int(top['y0']), min(w, top['x1'] + 30), int(bottom['y1']))
                # the first bottom edge under a top edge is its own; an edge drawn as two bands is one tile
                if not any(all(abs(a - b) <= 12 for a, b in zip(tile, t)) for t in tiles):
                    tiles.append(tile)
                break
    return tiles[0] if len(tiles) == 1 else None


def name_strip(rgb, tile):
    """The bottom-left of a tile, where Meet writes the name, enlarged for reading."""
    x0, y0, x1, y1 = tile
    strip = rgb[y1 - max(24, int((y1 - y0) * 0.17)):y1, x0:x0 + int((x1 - x0) * 0.8)]
    k = max(2, -(-64 // strip.shape[0]))
    return np.repeat(np.repeat(strip, k, axis=0), k, axis=1)


def write_bmp(path, rgb):
    h, w, _ = rgb.shape
    pad = b'\0' * ((4 - w * 3 % 4) % 4)
    rows = b''.join(rgb[y, :, ::-1].tobytes() + pad for y in range(h - 1, -1, -1))
    with open(path, 'wb') as fh:
        fh.write(b'BM' + struct.pack('<IHHI', 54 + len(rows), 0, 0, 54))
        fh.write(struct.pack('<IiiHHIIiiII', 40, w, h, 1, 24, 0, len(rows), 2835, 2835, 0, 0))
        fh.write(rows)


NAME = re.compile(r"^[^\W\d_][\w.'’ -]{0,58}?(\.\.\.|…)?$")
TAG = re.compile(r'\s*\((?:you|presenting|host|co-host)\b[^)]*\)\s*$', re.I)


def read_names(strips, helper):
    """The name macOS Vision reads on each strip (None where it reads nothing name-like)."""
    if not strips or not shutil.which('swift'):
        return [None] * len(strips)
    tmp = tempfile.mkdtemp(prefix='meet-names-')
    try:
        paths = []
        for i, strip in enumerate(strips):
            paths.append(os.path.join(tmp, f'{i}.bmp'))
            write_bmp(paths[-1], strip)
        try:
            out = subprocess.run(['swift', helper, *paths], capture_output=True, timeout=600)
        except (subprocess.SubprocessError, OSError):
            return [None] * len(strips)
        read = {}
        for line in out.stdout.decode('utf-8', 'replace').splitlines():
            try:
                d = json.loads(line)
                read[d['file']] = d['lines']
            except (ValueError, KeyError, TypeError):
                continue
        names = []
        for p in paths:
            name = None
            # Meet writes the name at the tile's bottom-left, so the leftmost confident text that looks like a name;
            # other words in the picture (a printed T-shirt, a poster) sit further right and are often bigger.
            # Meet appends "(You)", "(Presenting)" and so on
            for line in sorted(read.get(p, []), key=lambda l: float(l.get('x', 1))):
                # an icon beside the name can read as a stray letter ("U Ada Lovelace") or a letter on its own,
                # and the picture's edge behind it as a dash ("-Ada Lovelace")
                text = re.sub(r'^[\W_]+', '', TAG.sub('', str(line.get('text', '')).strip()))
                text = re.sub(r'^\S\s+(?=\S+\s+\S)', '', text)
                if float(line.get('confidence', 0)) >= 0.5 and len(text) > 1 and NAME.match(text):
                    name = text
                    break
            names.append(name)
        return names
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def screen_names(path, turns, voices, helper):
    """Each voice's name as Meet showed it while they talked: a name needs two reads and most of the votes."""
    looks = []  # (voice, time)
    for spk in voices:
        mine = sorted((t for t in turns if t[2] == spk and t[1] - t[0] >= 2), key=lambda t: t[0] - t[1])
        picked = 0
        for s, e, _ in mine:
            if picked == LOOKS:
                break
            # the middle of their turn, with nobody else talking for a second either side
            t = (s + e) / 2
            if any(o[2] != spk and o[0] < t + 1 and o[1] > t - 1 for o in turns):
                continue
            looks.append((spk, t))
            picked += 1
    strips, owners = [], []
    for spk, t in looks:
        rgb = frame(path, t)
        tile = highlighted_tile(rgb) if rgb is not None else None
        if tile:
            strips.append(name_strip(rgb, tile))
            owners.append(spk)
    names = read_names(strips, helper)
    # small tiles cut long names short ("Grace Hopp...", or "Grace Brewster H" when the dots aren't read): finish them
    # from the longest name read elsewhere in the call that they begin
    full = {n for n in names if n and not n.endswith(('...', '…'))}

    def finish(n):
        if not n:
            return n
        stem = n.rstrip('.…').strip().lower()
        if not n.endswith(('...', '…')) and len(stem) < 6:
            return n
        longer = [f for f in full if f.lower().startswith(stem)]
        best = max(longer, key=len, default=None)
        return best if best and all(best.lower().startswith(f.lower()) for f in longer) else n
    reads = {}
    for spk, n in zip(owners, names):
        if n:
            reads.setdefault(spk, []).append(finish(n))
    out = {}
    for spk, got in reads.items():
        counts = Counter(n.lower() for n in got)
        best, votes = counts.most_common(1)[0]
        tried = sum(1 for s, _ in looks if s == spk)
        if votes >= 2 and votes >= 0.6 * len(got):
            out[str(spk)] = {'name': next(n for n in got if n.lower() == best), 'votes': votes, 'of': tried}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--segmentation', required=True)
    ap.add_argument('--embedding', required=True)
    ap.add_argument('--input', required=True)
    ap.add_argument('--lines')
    ap.add_argument('--read-text')
    ap.add_argument('--turns')
    ap.add_argument('--threads', type=int, default=4)
    a = ap.parse_args()
    # numpy 2.0 on Apple's Accelerate raises spurious divide/overflow warnings from matmul on clean unit vectors
    np.seterr(all='ignore')

    # speakers already known (a caption export's labels): only read their names off the screen
    if a.turns:
        with open(a.turns) as fh:
            given = [[float(s), float(e), int(k)] for s, e, k in json.load(fh)]
        talk = Counter()
        for s, e, k in given:
            talk[k] += e - s
        mains = sorted(k for k, secs in talk.items() if secs >= MAIN)
        json.dump({'version': VERSION, 'screen': screen_names(a.input, given, mains, a.read_text) if a.read_text else {}}, sys.stdout)
        return

    samples = audio(a.input)
    embedding = sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=a.embedding, num_threads=a.threads)
    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=a.segmentation),
            num_threads=a.threads),
        embedding=embedding,
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=-1, threshold=0.5),
        min_duration_on=0.3,
        min_duration_off=0.5)
    if not config.validate():
        sys.exit('invalid diarization configuration (check the model paths)')
    turns = [[r.start, r.end, r.speaker] for r in sherpa_onnx.OfflineSpeakerDiarization(config).process(samples).sort_by_start_time()]

    # one voice sample per turn of a second or more (the middle 20 s of a long one is plenty)
    extractor = sherpa_onnx.SpeakerEmbeddingExtractor(embedding)

    def voice(start, end):
        if end - start > 20:
            start = (start + end) / 2 - 10
            end = start + 20
        stream = extractor.create_stream()
        stream.accept_waveform(RATE, samples[max(0, int(start * RATE)):max(0, int(end * RATE))])
        stream.input_finished()
        return unit(extractor.compute(stream)) if extractor.is_ready(stream) else None

    vecs = [voice(s, e) if e - s >= 1.0 else None for s, e, _ in turns]
    span = lambda i: turns[i][1] - turns[i][0]

    groups = {}
    for i, t in enumerate(turns):
        groups.setdefault(t[2], []).append(i)

    def centroid(members):
        w = [(vecs[i], min(span(i), 10.0)) for i in members if vecs[i] is not None]
        return unit(sum(v * x for v, x in w)) if w else None

    # merge the two most alike groups until no pair is alike enough
    cents = {g: centroid(m) for g, m in groups.items()}
    while True:
        keys = [g for g in groups if cents[g] is not None]
        if len(keys) < 2:
            break
        c = np.stack([cents[g] for g in keys])
        sim = c @ c.T
        np.fill_diagonal(sim, -1)
        x, y = np.unravel_index(int(np.argmax(sim)), sim.shape)
        if sim[x, y] < MERGE:
            break
        keep, gone = keys[x], keys[y]
        groups[keep] += groups.pop(gone)
        del cents[gone]
        cents[keep] = centroid(groups[keep])

    # scraps join the voice they sound most like; a distinct voice with enough speech stays its own speaker
    secs = {g: sum(span(i) for i in m) for g, m in groups.items()}
    main_ = [g for g in groups if cents[g] is not None and secs[g] >= MAIN]
    for g in sorted(set(groups) - set(main_), key=lambda g: -secs[g]):
        best = max(main_, key=lambda h: float(cents[g] @ cents[h]), default=None) if cents[g] is not None else None
        if best is not None and float(cents[g] @ cents[best]) >= STRAY:
            groups[best] += groups.pop(g)
        elif cents[g] is not None and secs[g] >= ALONE:
            main_.append(g)
        else:
            groups.pop(g)  # too little to tell whose it is

    # number speakers by first appearance; join a speaker's back-to-back turns
    owner = {i: g for g, m in groups.items() for i in m}
    order = {}
    out = []
    for i, (s, e, _) in enumerate(turns):
        if i not in owner:
            continue
        spk = order.setdefault(owner[i], len(order))
        if out and out[-1][2] == spk and s - out[-1][1] <= 0.5:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e, spk])
    speakers = {}
    for g, spk in order.items():
        vp = centroid(groups[g])
        speakers[str(spk)] = {
            'seconds': round(sum(span(i) for i in groups[g]), 1),
            'voiceprint': [round(float(x), 5) for x in vp] if vp is not None else None,
        }

    result = {
        'version': VERSION,
        'duration': round(len(samples) / RATE, 2),
        'turns': [[round(s, 2), round(e, 2), spk] for s, e, spk in out],
        'speakers': speakers,
    }

    # each transcript line's own voice against every main speaker (a line under 0.6 s is too short to judge)
    if a.lines:
        with open(a.lines) as fh:
            lines = [(float(s), float(e)) for s, e in json.load(fh)]
        mains = [int(k) for k, v in speakers.items() if v['voiceprint'] and v['seconds'] >= MAIN]
        prints = [np.asarray(speakers[str(k)]['voiceprint'], dtype=np.float32) for k in mains]
        sims = []
        for s, e in lines:
            v = None
            if prints and 0.6 <= e - s <= 30:
                mid = (s + e) / 2
                v = voice(min(s, mid - 0.6), max(e, mid + 0.6))
            sims.append([round(float(v @ p), 2) for p in prints] if v is not None else None)
        result['lines'] = {'speakers': mains, 'sims': sims}

    if a.read_text:
        mains = [spk for spk in order.values() if speakers[str(spk)]['seconds'] >= MAIN]
        # names are a bonus: a recording that can't be read (no video, an odd layout) still gets its voices
        try:
            result['screen'] = screen_names(a.input, out, mains, a.read_text)
        except Exception as err:
            print(f'reading names off the screen failed: {err}', file=sys.stderr)

    json.dump(result, sys.stdout)


if __name__ == '__main__':
    main()
