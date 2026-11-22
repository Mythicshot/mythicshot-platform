"""Reads the pair kerning of a TrueType font's GPOS table, for scripts/build-wordmark.py.

Pillow draws glyphs with FreeType but, without the Raqm layout library, applies no GPOS
kerning, so the wordmark builder takes the font's own pair adjustments from here. This reads
only what that needs: the cmap (format 4) for glyph ids, the 'kern' feature's pair
adjustment lookups (type 2, directly or through extension lookups, type 9) in both of their
formats, and, for a variable font, the deltas of each adjustment from GDEF's item variation
store at the given axis position (normalised through avar when the font has one). Anything
else in the font is not read. Standard library only.
"""
import struct


class Font:
    def __init__(self, path):
        with open(path, "rb") as f:
            self.data = f.read()
        num = struct.unpack_from(">H", self.data, 4)[0]
        self.tables = {}
        for i in range(num):
            tag, _, off, length = struct.unpack_from(">4sIII", self.data, 12 + 16 * i)
            self.tables[tag.decode("latin-1")] = (off, length)

    def u16(self, o): return struct.unpack_from(">H", self.data, o)[0]
    def i16(self, o): return struct.unpack_from(">h", self.data, o)[0]
    def u32(self, o): return struct.unpack_from(">I", self.data, o)[0]
    def table(self, tag): return self.tables[tag][0] if tag in self.tables else None

    def glyph_id(self, ch):
        cmap = self.table("cmap")
        code = ord(ch)
        for i in range(self.u16(cmap + 2)):
            pid, eid, off = struct.unpack_from(">HHI", self.data, cmap + 4 + 8 * i)
            sub = cmap + off
            if self.u16(sub) != 4 or (pid, eid) not in ((3, 1), (0, 3), (0, 4)):
                continue
            segx2 = self.u16(sub + 6)
            ends, starts = sub + 14, sub + 16 + segx2
            deltas, ranges = starts + segx2, starts + 2 * segx2
            for s in range(segx2 // 2):
                end, start = self.u16(ends + 2 * s), self.u16(starts + 2 * s)
                if start <= code <= end:
                    delta, roff = self.i16(deltas + 2 * s), self.u16(ranges + 2 * s)
                    if roff == 0:
                        return (code + delta) & 0xFFFF
                    g = self.u16(ranges + 2 * s + roff + 2 * (code - start))
                    return (g + delta) & 0xFFFF if g else 0
        raise ValueError(f"no glyph for {ch!r}")

    def coverage(self, o, glyph):
        fmt = self.u16(o)
        if fmt == 1:
            for i in range(self.u16(o + 2)):
                if self.u16(o + 4 + 2 * i) == glyph:
                    return i
        else:
            for i in range(self.u16(o + 2)):
                start, end, first = struct.unpack_from(">HHH", self.data, o + 4 + 6 * i)
                if start <= glyph <= end:
                    return first + glyph - start
        return None

    def class_of(self, o, glyph):
        if o is None:
            return 0
        fmt = self.u16(o)
        if fmt == 1:
            start, count = self.u16(o + 2), self.u16(o + 4)
            return self.u16(o + 6 + 2 * (glyph - start)) if start <= glyph < start + count else 0
        for i in range(self.u16(o + 2)):
            start, end, cls = struct.unpack_from(">HHH", self.data, o + 4 + 6 * i)
            if start <= glyph <= end:
                return cls
        return 0

    # -- variations -------------------------------------------------------------------
    def normalise(self, coords):
        fvar = self.table("fvar")
        if fvar is None:
            return []
        axes_off, count, size = self.u16(fvar + 4), self.u16(fvar + 8), self.u16(fvar + 10)
        out = []
        for i in range(count):
            a = fvar + axes_off + i * size
            lo, default, hi = (struct.unpack_from(">i", self.data, a + 4 + 4 * k)[0] / 65536 for k in range(3))
            v = coords[i] if i < len(coords) else default
            v = max(lo, min(hi, v))
            n = 0.0 if v == default else (v - default) / (default - lo) if v < default else (v - default) / (hi - default)
            out.append(n)
        avar = self.table("avar")
        if avar is not None:
            p = avar + 8
            for i in range(self.u16(avar + 6)):
                pairs = [(self.i16(p + 2 + 4 * k) / 16384, self.i16(p + 4 + 4 * k) / 16384) for k in range(self.u16(p))]
                p += 2 + 4 * len(pairs)
                for (f0, t0), (f1, t1) in zip(pairs, pairs[1:]):
                    if f0 <= out[i] <= f1:
                        out[i] = t0 if f1 == f0 else t0 + (out[i] - f0) * (t1 - t0) / (f1 - f0)
                        break
        return out

    def delta(self, outer, inner, coords):
        gdef = self.table("GDEF")
        if gdef is None or self.u32(gdef) < 0x00010003:
            return 0.0
        store_off = self.u32(gdef + 12)
        if store_off == 0:
            return 0.0
        store = gdef + store_off
        regions = store + self.u32(store + 2)
        axis_count = self.u16(regions)
        data = store + self.u32(store + 8 + 4 * outer)
        item_count, word_count, region_count = self.u16(data), self.u16(data + 2), self.u16(data + 4)
        long_words = bool(word_count & 0x8000)
        word_count &= 0x7FFF
        region_ids = [self.u16(data + 6 + 2 * k) for k in range(region_count)]
        row_size = (word_count * (4 if long_words else 2)) + (region_count - word_count) * (2 if long_words else 1)
        row = data + 6 + 2 * region_count + inner * row_size
        deltas, p = [], row
        for k in range(region_count):
            if k < word_count:
                d = struct.unpack_from(">i" if long_words else ">h", self.data, p)[0]
                p += 4 if long_words else 2
            else:
                d = struct.unpack_from(">h" if long_words else ">b", self.data, p)[0]
                p += 2 if long_words else 1
            deltas.append(d)
        total = 0.0
        for rid, d in zip(region_ids, deltas):
            scalar = 1.0
            for a in range(axis_count):
                start, peak, end = (self.i16(regions + 2 + rid * axis_count * 6 + a * 6 + 2 * k) / 16384 for k in range(3))
                v = coords[a] if a < len(coords) else 0.0
                if peak == 0 or start > peak or peak > end or (start < 0 < end):
                    continue
                if v == peak:
                    continue
                if v <= start or v >= end:
                    scalar = 0.0
                    break
                scalar *= (v - start) / (peak - start) if v < peak else (end - v) / (end - peak)
            total += scalar * d
        return total

    def value_x_advance(self, o, fmt, coords):
        """The XAdvance of a value record at o, with its variation delta; and the record's size."""
        x, p = 0.0, o
        for bit in range(8):
            if not fmt & (1 << bit):
                continue
            if bit == 2:
                x += self.i16(p)
            if bit == 6:
                dev = self.u16(p)
                if dev:
                    # The device offset is from the start of the subtable: the caller passes it in.
                    x += self._device(dev, coords)
            p += 2
        return x, p - o

    # -- GPOS ---------------------------------------------------------------------------
    def kern_lookups(self):
        gpos = self.table("GPOS")
        if gpos is None:
            return []
        features = gpos + self.u16(gpos + 6)
        lookups = gpos + self.u16(gpos + 8)
        indices = []
        for i in range(self.u16(features)):
            tag = self.data[features + 2 + 6 * i: features + 6 + 6 * i]
            if tag != b"kern":
                continue
            feat = features + self.u16(features + 6 + 6 * i)
            for k in range(self.u16(feat + 2)):
                idx = self.u16(feat + 4 + 2 * k)
                if idx not in indices:
                    indices.append(idx)
        out = []
        for idx in sorted(indices):
            lk = lookups + self.u16(lookups + 2 + 2 * idx)
            kind = self.u16(lk)
            for s in range(self.u16(lk + 4)):
                sub = lk + self.u16(lk + 6 + 2 * s)
                if kind == 9:
                    kind_ext = self.u16(sub + 2)
                    if kind_ext != 2:
                        continue
                    sub = sub + self.u32(sub + 4)
                elif kind != 2:
                    continue
                out.append(sub)
        return out

    def pair_x_advance(self, left, right, coords):
        """The first glyph's x advance adjustment for the pair, in font units: the first subtable that holds the pair."""
        for sub in self.kern_lookups():
            fmt, cov = self.u16(sub), sub + self.u16(sub + 2)
            vf1, vf2 = self.u16(sub + 4), self.u16(sub + 6)
            index = self.coverage(cov, left)
            if index is None:
                continue
            size1 = 2 * bin(vf1).count("1")
            size2 = 2 * bin(vf2).count("1")
            self._sub = sub
            if fmt == 1:
                pairset = sub + self.u16(sub + 10 + 2 * index)
                for k in range(self.u16(pairset)):
                    rec = pairset + 2 + k * (2 + size1 + size2)
                    if self.u16(rec) == right:
                        return self.value_x_advance(rec + 2, vf1, coords)[0]
                continue
            cd1, cd2 = sub + self.u16(sub + 8), sub + self.u16(sub + 10)
            n2 = self.u16(sub + 14)
            c1, c2 = self.class_of(cd1, left), self.class_of(cd2, right)
            rec = sub + 16 + (c1 * n2 + c2) * (size1 + size2)
            return self.value_x_advance(rec, vf1, coords)[0]
        return 0.0

    def _device(self, offset, coords):
        dev = self._sub + offset
        if self.u16(dev + 4) != 0x8000:
            return 0.0
        return self.delta(self.u16(dev), self.u16(dev + 2), coords)

    def units_per_em(self):
        return self.u16(self.table("head") + 18)
