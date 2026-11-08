#!/usr/bin/env python3
"""Check the base map files before they are committed.

Checks the folder written by build_basemap.py. Standard library only; run
it with python3 -I. Prints fixed messages and counts only, never text from
the files. Exit code 0 means every check passed.

What it checks:
  - the folder holds exactly the expected files and nothing else;
  - each shape file is a plain collection of the expected shape types,
    every coordinate is a number inside the map area, and the only field
    allowed is a whole-number size rank ("r") on lakes and rivers;
  - index.json gives the map area and a rectangle for each relief piece;
  - each relief piece is a plain 8-bit grey JPEG, no larger than
    2048 pixels a side, with no extra data such as text or comments;
  - every line of MANIFEST-basemap.txt matches a fixed pattern, and its
    counts, sizes and fingerprints match the real files;
  - size limits for each file and in total.
"""
import hashlib
import json
import math
import os
import re
import struct
import sys

AREA = (-12.0, 34.0, 45.0, 72.0)  # west, south, east, north; must match build_basemap.py
W, S, E, N = AREA
SLACK = 1e-6

VECTORS = {
    'land.json': ('polygon', False),
    'ocean.json': ('polygon', False),
    'lakes.json': ('polygon', True),
    'rivers.json': ('line', True),
    'borders.json': ('line', False),
}
TILE_NAME = re.compile(r'relief-(\d)-(\d)\.jpg')
MAX_TILES = 16
MAX_TILE_PIXELS = 2048
MAX_JSON_BYTES = 25_000_000
MAX_JPEG_BYTES = 8_000_000
MAX_INDEX_BYTES = 20_000
MAX_MANIFEST_BYTES = 20_000
MAX_TOTAL_BYTES = 60_000_000

MANIFEST_LINES = [
    ('header', re.compile(r'basemap manifest')),
    ('tag', re.compile(r'natural_earth_vector_tag: (?:v\d{1,3}\.\d{1,3}\.\d{1,3}|none)')),
    ('commit', re.compile(r'natural_earth_vector_commit: [0-9a-f]{40}')),
    ('relief_sha', re.compile(r'relief_source_sha256: [0-9a-f]{64}')),
    ('relief_source', re.compile(r'relief_source_pixels: \d{1,6}x\d{1,6}')),
    ('pillow', re.compile(r'pillow: \d{1,3}\.\d{1,3}\.\d{1,3}')),
    ('area', re.compile(r'area: -12,34,45,72')),
    ('decimals', re.compile(r'decimals: \d')),
    ('tolerance', re.compile(r'tolerance: [0-9.e-]{1,12}')),
    ('vector', re.compile(r'file (land|ocean|lakes|rivers|borders)\.json features=(\d{1,9}) '
                          r'bytes=(\d{1,10}) sha256=([0-9a-f]{64})')),
    ('tile', re.compile(r'file (relief-\d-\d\.jpg) width=(\d{1,5}) height=(\d{1,5}) '
                        r'bytes=(\d{1,10}) sha256=([0-9a-f]{64})')),
    ('index', re.compile(r'file index\.json bytes=(\d{1,10}) sha256=([0-9a-f]{64})')),
    ('relief_pixels', re.compile(r'relief_pixels: \d{1,6}x\d{1,6} pieces=\d{1,2}x\d{1,2}')),
    ('total', re.compile(r'total_bytes: (\d{1,10})')),
]
ONCE = {'header', 'tag', 'commit', 'relief_sha', 'relief_source', 'pillow', 'area',
        'decimals', 'tolerance', 'index', 'relief_pixels', 'total'}


class Failed(Exception):
    pass


def fail(message):
    raise Failed(message)


def sha256_of(data):
    return hashlib.sha256(data).hexdigest()


def read_limited(path, limit, what):
    size = os.path.getsize(path)
    if size > limit:
        fail(what + ' is larger than the limit')
    with open(path, 'rb') as f:
        return f.read()


def load_json(data, what):
    try:
        text = data.decode('ascii')
    except UnicodeDecodeError:
        fail(what + ' contains unexpected characters')

    def no_constants(_):
        fail(what + ' contains a value that is not a number')

    try:
        return json.loads(text, parse_constant=no_constants)
    except (ValueError, RecursionError):
        fail(what + ' is not valid JSON')


def is_number(v):
    return not isinstance(v, bool) and isinstance(v, (int, float)) and math.isfinite(v)


def check_position(p, what):
    if not isinstance(p, list) or len(p) != 2 or not is_number(p[0]) or not is_number(p[1]):
        fail(what + ' has a coordinate that is not a pair of numbers')
    if not (W - SLACK <= p[0] <= E + SLACK and S - SLACK <= p[1] <= N + SLACK):
        fail(what + ' has a coordinate outside the map area')


def check_line(line, what):
    if not isinstance(line, list) or len(line) < 2:
        fail(what + ' has a line with too few points')
    for p in line:
        check_position(p, what)
    return len(line)


def check_ring(ring, what):
    if not isinstance(ring, list) or len(ring) < 4:
        fail(what + ' has a ring with too few points')
    for p in ring:
        check_position(p, what)
    if ring[0] != ring[-1]:
        fail(what + ' has a ring that is not closed')
    return len(ring)


def check_polygon(rings, what):
    if not isinstance(rings, list) or not rings:
        fail(what + ' has an empty shape')
    return sum(check_ring(r, what) for r in rings)


def check_vector(path, name, kind, ranked):
    data = read_limited(path, MAX_JSON_BYTES, name)
    obj = load_json(data, name)
    if not isinstance(obj, dict) or set(obj) != {'type', 'features'} or obj['type'] != 'FeatureCollection':
        fail(name + ' is not a plain collection of shapes')
    feats = obj['features']
    if not isinstance(feats, list):
        fail(name + ' is not a plain collection of shapes')
    points = 0
    for f in feats:
        if not isinstance(f, dict) or set(f) != {'type', 'geometry', 'properties'} or f['type'] != 'Feature':
            fail(name + ' has an entry that is not a plain shape')
        props = f['properties']
        if ranked:
            if not isinstance(props, dict) or set(props) != {'r'}:
                fail(name + ' has fields other than the size rank')
            r = props['r']
            if isinstance(r, bool) or not isinstance(r, int) or not 0 <= r <= 20:
                fail(name + ' has a size rank that is not a whole number from 0 to 20')
        elif props != {}:
            fail(name + ' has fields where none are allowed')
        g = f['geometry']
        if not isinstance(g, dict) or set(g) != {'type', 'coordinates'}:
            fail(name + ' has a shape of an unexpected form')
        t, c = g['type'], g['coordinates']
        if kind == 'polygon' and t == 'Polygon':
            points += check_polygon(c, name)
        elif kind == 'polygon' and t == 'MultiPolygon':
            if not isinstance(c, list) or not c:
                fail(name + ' has an empty shape')
            points += sum(check_polygon(p, name) for p in c)
        elif kind == 'line' and t == 'LineString':
            points += check_line(c, name)
        elif kind == 'line' and t == 'MultiLineString':
            if not isinstance(c, list) or not c:
                fail(name + ' has an empty shape')
            points += sum(check_line(l, name) for l in c)
        else:
            fail(name + ' has a shape of an unexpected type')
    return {'features': len(feats), 'points': points, 'bytes': len(data), 'sha256': sha256_of(data)}


def check_index(path):
    data = read_limited(path, MAX_INDEX_BYTES, 'index.json')
    obj = load_json(data, 'index.json')
    if not isinstance(obj, dict) or set(obj) != {'area', 'relief'}:
        fail('index.json is not in the expected form')
    if obj['area'] != [W, S, E, N]:
        fail('index.json gives a different map area')
    tiles = obj['relief']
    if not isinstance(tiles, list) or not 1 <= len(tiles) <= MAX_TILES:
        fail('index.json lists an unexpected number of relief pieces')
    names = []
    for t in tiles:
        if not isinstance(t, dict) or set(t) != {'file', 'coordinates'}:
            fail('index.json has a relief entry in an unexpected form')
        if not isinstance(t['file'], str) or not TILE_NAME.fullmatch(t['file']):
            fail('index.json has a relief file name in an unexpected form')
        c = t['coordinates']
        if not isinstance(c, list) or len(c) != 4:
            fail('index.json has relief corners in an unexpected form')
        for p in c:
            check_position(p, 'index.json')
        (l1, t1), (r1, t2), (r2, b1), (l2, b2) = c
        if not (l1 == l2 and r1 == r2 and t1 == t2 and b1 == b2 and l1 < r1 and b1 < t1):
            fail('index.json has relief corners that are not a rectangle')
        names.append(t['file'])
    if len(set(names)) != len(names):
        fail('index.json lists a relief piece twice')
    return names, {'bytes': len(data), 'sha256': sha256_of(data)}


def check_jpeg(path, name):
    data = read_limited(path, MAX_JPEG_BYTES, name)
    if len(data) < 4 or data[:2] != b'\xff\xd8' or data[-2:] != b'\xff\xd9':
        fail(name + ' is not a plain JPEG image')
    i = 2
    size = None
    scans = 0
    n = len(data)
    while True:
        if i >= n or data[i] != 0xFF:
            fail(name + ' is not a plain JPEG image')
        while i < n and data[i] == 0xFF:
            i += 1
        if i >= n:
            fail(name + ' is cut short')
        marker = data[i]
        i += 1
        if marker == 0xD9:
            if i != n:
                fail(name + ' has data after the image')
            break
        if i + 2 > n:
            fail(name + ' is cut short')
        length = struct.unpack('>H', data[i:i + 2])[0]
        if length < 2 or i + length > n:
            fail(name + ' is cut short')
        seg = data[i + 2:i + length]
        if marker == 0xE0:
            if not seg.startswith(b'JFIF\x00'):
                fail(name + ' has extra data that is not allowed')
        elif marker in (0xC0, 0xC1, 0xC2):
            if size is not None or len(seg) < 6:
                fail(name + ' is not a plain JPEG image')
            precision, height, width, components = struct.unpack('>BHHB', seg[:6])
            if precision != 8 or components != 1:
                fail(name + ' is not an 8-bit grey image')
            size = (width, height)
        elif marker in (0xC4, 0xDB, 0xDD):
            pass
        elif marker == 0xDA:
            i += length
            scans += 1
            while True:
                j = data.find(b'\xff', i)
                if j == -1 or j + 1 >= n:
                    fail(name + ' is cut short')
                nxt = data[j + 1]
                if nxt == 0x00 or 0xD0 <= nxt <= 0xD7:
                    i = j + 2
                    continue
                i = j
                break
            continue
        else:
            fail(name + ' has extra data that is not allowed')
        i += length
    if size is None or scans == 0:
        fail(name + ' is not a plain JPEG image')
    if not (1 <= size[0] <= MAX_TILE_PIXELS and 1 <= size[1] <= MAX_TILE_PIXELS):
        fail(name + ' is larger than 2048 pixels a side')
    return {'width': size[0], 'height': size[1], 'bytes': len(data), 'sha256': sha256_of(data)}


def check_manifest(path, vectors, tiles, index, total):
    data = read_limited(path, MAX_MANIFEST_BYTES, 'MANIFEST-basemap.txt')
    try:
        text = data.decode('ascii')
    except UnicodeDecodeError:
        fail('MANIFEST-basemap.txt contains unexpected characters')
    if '\r' in text or not text.endswith('\n'):
        fail('MANIFEST-basemap.txt is not in the expected form')
    lines = text[:-1].split('\n')
    seen = {}
    vec_seen, tile_seen = set(), set()
    for k, line in enumerate(lines):
        kind = None
        for key, rx in MANIFEST_LINES:
            m = rx.fullmatch(line)
            if m:
                kind = key
                break
        if kind is None:
            fail('MANIFEST-basemap.txt has a line that matches no allowed pattern')
        if kind == 'header' and k != 0:
            fail('MANIFEST-basemap.txt is not in the expected form')
        seen[kind] = seen.get(kind, 0) + 1
        if kind == 'vector':
            fname = m.group(1) + '.json'
            v = vectors[fname]
            if fname in vec_seen or int(m.group(2)) != v['features'] or int(m.group(3)) != v['bytes'] \
                    or m.group(4) != v['sha256']:
                fail('MANIFEST-basemap.txt does not match a shape file')
            vec_seen.add(fname)
        elif kind == 'tile':
            fname = m.group(1)
            t = tiles.get(fname)
            if t is None or fname in tile_seen or int(m.group(2)) != t['width'] \
                    or int(m.group(3)) != t['height'] or int(m.group(4)) != t['bytes'] \
                    or m.group(5) != t['sha256']:
                fail('MANIFEST-basemap.txt does not match a relief piece')
            tile_seen.add(fname)
        elif kind == 'index':
            if int(m.group(1)) != index['bytes'] or m.group(2) != index['sha256']:
                fail('MANIFEST-basemap.txt does not match index.json')
        elif kind == 'total':
            if int(m.group(1)) != total:
                fail('MANIFEST-basemap.txt gives a different total size')
    if lines[0] != 'basemap manifest':
        fail('MANIFEST-basemap.txt is not in the expected form')
    for key in ONCE:
        if seen.get(key) != 1:
            fail('MANIFEST-basemap.txt is missing a line or repeats one')
    if vec_seen != set(vectors) or tile_seen != set(tiles):
        fail('MANIFEST-basemap.txt does not list every file')


def main():
    if len(sys.argv) != 2:
        print('ERROR: give the output folder')
        return 1
    folder = sys.argv[1]
    try:
        if not os.path.isdir(folder):
            fail('the output folder is missing')
        entries = os.listdir(folder)
        for e in entries:
            if not os.path.isfile(os.path.join(folder, e)) or os.path.islink(os.path.join(folder, e)):
                fail('the output folder holds something other than plain files')

        vectors = {}
        for fname, (kind, ranked) in VECTORS.items():
            if fname not in entries:
                fail('a shape file is missing')
            vectors[fname] = check_vector(os.path.join(folder, fname), fname, kind, ranked)
            v = vectors[fname]
            print(f'{fname}: passed ({v["features"]} shapes, {v["points"]} points, {v["bytes"]} bytes)')

        if 'index.json' not in entries:
            fail('index.json is missing')
        names, index = check_index(os.path.join(folder, 'index.json'))
        print(f'index.json: passed ({len(names)} relief pieces)')

        tiles = {}
        for fname in names:
            if fname not in entries:
                fail('a relief piece listed in index.json is missing')
            tiles[fname] = check_jpeg(os.path.join(folder, fname), fname)
            t = tiles[fname]
            print(f'{fname}: passed ({t["width"]}x{t["height"]} pixels, {t["bytes"]} bytes)')

        expected = set(VECTORS) | {'index.json', 'MANIFEST-basemap.txt'} | set(names)
        if set(entries) != expected:
            fail('the output folder holds an unexpected file or is missing one')

        total = sum(v['bytes'] for v in vectors.values()) + sum(t['bytes'] for t in tiles.values()) \
            + index['bytes']
        if total > MAX_TOTAL_BYTES:
            fail('the files are larger in total than the limit')

        if 'MANIFEST-basemap.txt' not in entries:
            fail('MANIFEST-basemap.txt is missing')
        check_manifest(os.path.join(folder, 'MANIFEST-basemap.txt'), vectors, tiles, index, total)
        print('MANIFEST-basemap.txt: passed')
    except Failed as e:
        print('ERROR: ' + str(e))
        return 1
    print(f'All checks passed ({total} bytes in total)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
