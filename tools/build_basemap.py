#!/usr/bin/env python3
"""Build the base map files from Natural Earth (public domain).

Runs only in GitHub Actions, on files the workflow has downloaded. Writes
to the output folder:

  land.json, ocean.json, lakes.json, rivers.json, borders.json
      Shapes cut to the map area, coordinates rounded to about 10 metres
      and lightly simplified. No text: lakes and rivers keep only a size
      rank ("r"), everything else keeps no fields at all.
  relief-R-C.jpg
      The shaded relief, lined up with the map's projection (Web Mercator)
      and cut into pieces no larger than 2048 pixels a side.
  index.json
      The map area and the corners of each relief piece.
  MANIFEST-basemap.txt
      Sources, fingerprints, counts and sizes only.

Prints fixed messages and counts only, never text from the data.
Standard library only, except the image library (Pillow) for the relief.
"""
import argparse
import hashlib
import json
import math
import os
import re
import shutil
import sys
import tempfile
import zipfile

AREA = (-12.0, 34.0, 45.0, 72.0)  # west, south, east, north, in degrees
W, S, E, N = AREA
DECIMALS = 4                       # about 10 metres
TOLERANCE = 0.001                  # simplification, in degrees (about 100 metres)
MIN_AREA = 1e-8                    # rings smaller than this (square degrees) are dropped
MAX_TILE = 2048                    # relief piece size limit, pixels a side
JPEG_QUALITY = 80
MAX_SOURCE_PIXELS = 400_000_000
MAX_SOURCE_IMAGE_BYTES = 2_000_000_000

# name, kind, keeps a size rank, Natural Earth source files (without .geojson)
LAYERS = [
    ('land', 'polygon', False, ['ne_10m_land']),
    ('ocean', 'polygon', False, ['ne_10m_ocean']),
    ('lakes', 'polygon', True, ['ne_10m_lakes', 'ne_10m_lakes_europe']),
    ('rivers', 'line', True, ['ne_10m_rivers_lake_centerlines', 'ne_10m_rivers_europe']),
    ('borders', 'line', False, ['ne_10m_admin_0_boundary_lines_land']),
]


def fail(message):
    print('ERROR: ' + message)
    sys.exit(1)


class BadGeometry(Exception):
    pass


# ---------- geometry helpers ----------

def to_points(coords):
    """A list of positions as (x, y) floats; anything else is bad geometry."""
    if not isinstance(coords, list):
        raise BadGeometry()
    pts = []
    for c in coords:
        if not isinstance(c, list) or len(c) < 2:
            raise BadGeometry()
        x, y = c[0], c[1]
        for v in (x, y):
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
                raise BadGeometry()
        pts.append((float(x), float(y)))
    return pts


def outside_area(pts):
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return max(xs) < W or min(xs) > E or max(ys) < S or min(ys) > N


def _inside(p, edge):
    if edge == 0:
        return p[0] >= W
    if edge == 1:
        return p[0] <= E
    if edge == 2:
        return p[1] >= S
    return p[1] <= N


def _cross(p, q, edge):
    (x1, y1), (x2, y2) = p, q
    if edge in (0, 1):
        x = W if edge == 0 else E
        t = (x - x1) / (x2 - x1)
        return (x, y1 + t * (y2 - y1))
    y = S if edge == 2 else N
    t = (y - y1) / (y2 - y1)
    return (x1 + t * (x2 - x1), y)


def clip_ring(points):
    """Clip a ring (without its repeated end point) to the area (Sutherland-Hodgman)."""
    out = points
    for edge in range(4):
        if not out:
            return []
        inp, out = out, []
        prev = inp[-1]
        for cur in inp:
            if _inside(cur, edge):
                if not _inside(prev, edge):
                    out.append(_cross(prev, cur, edge))
                out.append(cur)
            elif _inside(prev, edge):
                out.append(_cross(prev, cur, edge))
            prev = cur
    return out


def clip_segment(p, q):
    """Clip one segment to the area (Liang-Barsky). Returns (a, b, a_is_p, b_is_q) or None."""
    x1, y1 = p
    x2, y2 = q
    dx, dy = x2 - x1, y2 - y1
    t0, t1 = 0.0, 1.0
    for pp, qq in ((-dx, x1 - W), (dx, E - x1), (-dy, y1 - S), (dy, N - y1)):
        if pp == 0:
            if qq < 0:
                return None
        else:
            r = qq / pp
            if pp < 0:
                if r > t1:
                    return None
                if r > t0:
                    t0 = r
            else:
                if r < t0:
                    return None
                if r < t1:
                    t1 = r
    a = p if t0 == 0.0 else (x1 + t0 * dx, y1 + t0 * dy)
    b = q if t1 == 1.0 else (x1 + t1 * dx, y1 + t1 * dy)
    return a, b, t0 == 0.0, t1 == 1.0


def clip_line(points):
    """Clip a line to the area; returns the pieces that lie inside."""
    pieces, cur = [], []
    for p, q in zip(points, points[1:]):
        seg = clip_segment(p, q)
        if seg is None:
            if len(cur) >= 2:
                pieces.append(cur)
            cur = []
            continue
        a, b, a_is_p, b_is_q = seg
        if cur and a_is_p and cur[-1] == a:
            cur.append(b)
        else:
            if len(cur) >= 2:
                pieces.append(cur)
            cur = [a, b]
        if not b_is_q:
            pieces.append(cur)
            cur = []
    if len(cur) >= 2:
        pieces.append(cur)
    return pieces


def simplify(points, tol):
    """Douglas-Peucker simplification, without recursion."""
    n = len(points)
    if n < 3:
        return points
    keep = [False] * n
    keep[0] = keep[-1] = True
    tol2 = tol * tol
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = points[a]
        bx, by = points[b]
        dx, dy = bx - ax, by - ay
        length2 = dx * dx + dy * dy
        best, idx = -1.0, -1
        for i in range(a + 1, b):
            px, py = points[i]
            if length2 == 0:
                d2 = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = ((px - ax) * dx + (py - ay) * dy) / length2
                t = 0.0 if t < 0 else 1.0 if t > 1 else t
                cx, cy = ax + t * dx, ay + t * dy
                d2 = (px - cx) ** 2 + (py - cy) ** 2
            if d2 > best:
                best, idx = d2, i
        if idx != -1 and best > tol2:
            keep[idx] = True
            stack.append((a, idx))
            stack.append((idx, b))
    return [p for p, k in zip(points, keep) if k]


def tidy(points):
    """Round to DECIMALS and drop repeated points."""
    out = []
    for x, y in points:
        p = [round(x, DECIMALS), round(y, DECIMALS)]
        if not out or out[-1] != p:
            out.append(p)
    return out


def ring_area(ring):
    s = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        s += x1 * y2 - x2 * y1
    return abs(s) / 2


def process_polygon(rings):
    """One polygon (outer ring, then holes). Returns the kept rings, or None."""
    if not isinstance(rings, list) or not rings:
        raise BadGeometry()
    kept = []
    for i, ring in enumerate(rings):
        pts = to_points(ring)
        if len(pts) >= 2 and pts[0] == pts[-1]:
            pts = pts[:-1]
        ok = len(pts) >= 3 and not outside_area(pts)
        if ok:
            clipped = clip_ring(pts)
            ok = len(clipped) >= 3
        if ok:
            closed = tidy(simplify(clipped + [clipped[0]], TOLERANCE))
            if closed[0] != closed[-1]:
                closed.append(closed[0])
            ok = len(closed) >= 4 and ring_area(closed) >= MIN_AREA
        if ok:
            kept.append(closed)
        elif i == 0:
            return None
    return kept


def process_geometry(geom, kind):
    if not isinstance(geom, dict):
        raise BadGeometry()
    gtype = geom.get('type')
    coords = geom.get('coordinates')
    if kind == 'polygon':
        if gtype == 'Polygon':
            polys = [coords]
        elif gtype == 'MultiPolygon':
            if not isinstance(coords, list):
                raise BadGeometry()
            polys = coords
        else:
            raise BadGeometry()
        out = [p for p in (process_polygon(r) for r in polys) if p]
        if not out:
            return None
        if len(out) == 1:
            return {'type': 'Polygon', 'coordinates': out[0]}
        return {'type': 'MultiPolygon', 'coordinates': out}
    if gtype == 'LineString':
        lines = [coords]
    elif gtype == 'MultiLineString':
        if not isinstance(coords, list):
            raise BadGeometry()
        lines = coords
    else:
        raise BadGeometry()
    pieces = []
    for line in lines:
        pts = to_points(line)
        if len(pts) < 2 or outside_area(pts):
            continue
        for piece in clip_line(pts):
            piece = tidy(simplify(piece, TOLERANCE))
            if len(piece) >= 2:
                pieces.append(piece)
    if not pieces:
        return None
    if len(pieces) == 1:
        return {'type': 'LineString', 'coordinates': pieces[0]}
    return {'type': 'MultiLineString', 'coordinates': pieces}


def rank_of(props):
    v = props.get('scalerank') if isinstance(props, dict) else None
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        return 10
    return max(0, min(20, int(round(v))))


# ---------- files ----------

def sha256_of(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def write_json(path, obj):
    with open(path, 'w', encoding='ascii') as f:
        json.dump(obj, f, separators=(',', ':'), ensure_ascii=True, allow_nan=False)


def build_layer(src_dir, out_dir, name, kind, ranked, sources):
    features = []
    skipped = 0
    for src in sources:
        path = os.path.join(src_dir, src + '.geojson')
        if not os.path.isfile(path):
            fail('source file missing: ' + src)
        try:
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except (ValueError, UnicodeDecodeError, RecursionError):
            fail('source file could not be read: ' + src)
        if not isinstance(data, dict) or not isinstance(data.get('features'), list):
            fail('source file has an unexpected structure: ' + src)
        for feat in data['features']:
            if not isinstance(feat, dict) or feat.get('geometry') is None:
                skipped += 1
                continue
            try:
                geom = process_geometry(feat['geometry'], kind)
            except (BadGeometry, RecursionError):
                skipped += 1
                continue
            if geom is None:
                continue
            props = {'r': rank_of(feat.get('properties'))} if ranked else {}
            features.append({'type': 'Feature', 'geometry': geom, 'properties': props})
    out_path = os.path.join(out_dir, name + '.json')
    write_json(out_path, {'type': 'FeatureCollection', 'features': features})
    print(f'{name}: {len(features)} shapes kept, {skipped} skipped')
    return len(features)


def build_relief(zip_path, out_dir):
    try:
        from PIL import Image
    except ImportError:
        fail('the image library is not installed')
    Image.MAX_IMAGE_PIXELS = MAX_SOURCE_PIXELS

    try:
        archive = zipfile.ZipFile(zip_path)
    except (zipfile.BadZipFile, OSError):
        fail('the relief archive could not be opened')
    with archive:
        images = [i for i in archive.infolist()
                  if not i.is_dir() and re.search(r'\.tiff?$', i.filename, re.IGNORECASE)]
        if len(images) != 1:
            fail('expected exactly one image in the relief archive')
        if images[0].file_size > MAX_SOURCE_IMAGE_BYTES:
            fail('the relief image is larger than expected')
        tmp = tempfile.NamedTemporaryFile(suffix='.tif', delete=False)
        try:
            with archive.open(images[0]) as src, tmp:
                shutil.copyfileobj(src, tmp, 1 << 20)
        except (zipfile.BadZipFile, OSError):
            fail('the relief image could not be extracted')

    try:
        try:
            img = Image.open(tmp.name, formats=['TIFF'])
            img.load()
        except Exception:
            fail('the relief image could not be read')
        if img.mode not in ('L', 'LA', 'P', 'RGB', 'RGBA'):
            fail('the relief image is of an unexpected type')
        sw, sh = img.size
        if sw != 2 * sh or sw % 360 != 0:
            fail('the relief image does not cover the world as expected')
        ppd = sw / 360.0
        x0 = round((W + 180) * ppd)
        x1 = round((E + 180) * ppd)
        y0 = max(0, math.floor((90 - N) * ppd) - 1)
        y1 = min(sh, math.ceil((90 - S) * ppd) + 1)
        src = img.crop((x0, y0, x1, y1)).convert('L')
        img.close()
    finally:
        os.unlink(tmp.name)

    def merc(lat):
        return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))

    def inv(y):
        return math.degrees(2 * math.atan(math.exp(y)) - math.pi / 2)

    yn, ys = merc(N), merc(S)
    out_w = x1 - x0
    out_h = round((yn - ys) / (math.radians(E - W) / out_w))

    # Each output row covers an equal step in Web Mercator; find the source
    # rows (equal steps in latitude) it covers.
    mesh = []
    for r in range(out_h):
        lat_top = inv(yn - (yn - ys) * r / out_h)
        lat_bottom = inv(yn - (yn - ys) * (r + 1) / out_h)
        a = (90 - lat_top) * ppd - y0
        b = (90 - lat_bottom) * ppd - y0
        mesh.append(((0, r, out_w, r + 1), (0, a, 0, b, out_w, b, out_w, a)))
    merc_img = src.transform((out_w, out_h), Image.Transform.MESH, mesh, Image.Resampling.BILINEAR)

    cols = math.ceil(out_w / MAX_TILE)
    rows = math.ceil(out_h / MAX_TILE)
    xs = [round(i * out_w / cols) for i in range(cols + 1)]
    ys_px = [round(j * out_h / rows) for j in range(rows + 1)]

    def lon_at(px):
        return min(E, max(W, W + (E - W) * px / out_w))

    def lat_at(py):
        return min(N, max(S, inv(yn - (yn - ys) * py / out_h)))

    tiles = []
    for j in range(rows):
        for i in range(cols):
            name = f'relief-{j}-{i}.jpg'
            piece = merc_img.crop((xs[i], ys_px[j], xs[i + 1], ys_px[j + 1]))
            clean = Image.frombytes('L', piece.size, piece.tobytes())  # no carried-over metadata
            clean.save(os.path.join(out_dir, name), 'JPEG', quality=JPEG_QUALITY, optimize=True)
            left, right = round(lon_at(xs[i]), 6), round(lon_at(xs[i + 1]), 6)
            top, bottom = round(lat_at(ys_px[j]), 6), round(lat_at(ys_px[j + 1]), 6)
            tiles.append({'file': name,
                          'coordinates': [[left, top], [right, top], [right, bottom], [left, bottom]],
                          'size': [xs[i + 1] - xs[i], ys_px[j + 1] - ys_px[j]]})
    print(f'relief: {out_w}x{out_h} pixels in {rows}x{cols} pieces')
    return {'source': (sw, sh), 'pixels': (out_w, out_h), 'grid': (rows, cols), 'tiles': tiles}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True)
    ap.add_argument('--relief-zip', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--ne-tag', required=True)
    ap.add_argument('--ne-commit', required=True)
    ap.add_argument('--relief-sha256', required=True)
    ap.add_argument('--pillow', required=True)
    args = ap.parse_args()

    if not re.fullmatch(r'v\d{1,3}\.\d{1,3}\.\d{1,3}|none', args.ne_tag):
        fail('release name is not in the expected form')
    if not re.fullmatch(r'[0-9a-f]{40}', args.ne_commit):
        fail('commit is not in the expected form')
    if not re.fullmatch(r'[0-9a-f]{64}', args.relief_sha256):
        fail('relief fingerprint is not in the expected form')
    if not re.fullmatch(r'\d{1,3}\.\d{1,3}\.\d{1,3}', args.pillow):
        fail('image library version is not in the expected form')

    os.makedirs(args.out, exist_ok=False)

    counts = {}
    for name, kind, ranked, sources in LAYERS:
        counts[name] = build_layer(args.src, args.out, name, kind, ranked, sources)

    relief = build_relief(args.relief_zip, args.out)
    index = {
        'area': [W, S, E, N],
        'relief': [{'file': t['file'], 'coordinates': t['coordinates']} for t in relief['tiles']],
    }
    write_json(os.path.join(args.out, 'index.json'), index)

    lines = [
        'basemap manifest',
        f'natural_earth_vector_tag: {args.ne_tag}',
        f'natural_earth_vector_commit: {args.ne_commit}',
        f'relief_source_sha256: {args.relief_sha256}',
        f'relief_source_pixels: {relief["source"][0]}x{relief["source"][1]}',
        f'pillow: {args.pillow}',
        'area: ' + ','.join(f'{v:g}' for v in AREA),
        f'decimals: {DECIMALS}',
        f'tolerance: {TOLERANCE:g}',
    ]
    total = 0
    for name, _, _, _ in LAYERS:
        path = os.path.join(args.out, name + '.json')
        size = os.path.getsize(path)
        total += size
        lines.append(f'file {name}.json features={counts[name]} bytes={size} sha256={sha256_of(path)}')
    for t in relief['tiles']:
        path = os.path.join(args.out, t['file'])
        size = os.path.getsize(path)
        total += size
        lines.append(f'file {t["file"]} width={t["size"][0]} height={t["size"][1]} '
                     f'bytes={size} sha256={sha256_of(path)}')
    path = os.path.join(args.out, 'index.json')
    size = os.path.getsize(path)
    total += size
    lines.append(f'file index.json bytes={size} sha256={sha256_of(path)}')
    lines.append(f'relief_pixels: {relief["pixels"][0]}x{relief["pixels"][1]} '
                 f'pieces={relief["grid"][0]}x{relief["grid"][1]}')
    lines.append(f'total_bytes: {total}')
    with open(os.path.join(args.out, 'MANIFEST-basemap.txt'), 'w', encoding='ascii') as f:
        f.write('\n'.join(lines) + '\n')
    print(f'total: {total} bytes')


if __name__ == '__main__':
    main()
