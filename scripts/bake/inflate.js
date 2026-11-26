/* ── A small raw-DEFLATE decoder (after zlib's puff.c) ──
   The bake sends each band of the place as deflated bytes inside a run_code
   script, and the DSL sandbox has no DecompressionStream, so the script
   carries this decoder. Plain ES2015: no imports, no globals beyond
   Uint8Array. Input: raw deflate (deflateRawSync), output: Uint8Array. */
export function inflate(src) {
  let pos = 0, buf = 0, cnt = 0;
  const out = [];
  const bits = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (!cnt) { buf = src[pos++]; cnt = 8; }
      v |= (buf & 1) << i; buf >>= 1; cnt--;
    }
    return v;
  };
  const table = (lens, n) => {
    const count = new Uint16Array(16), sym = new Uint16Array(n), offs = new Uint16Array(16);
    for (let i = 0; i < n; i++) count[lens[i]]++;
    count[0] = 0;
    for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
    for (let i = 0; i < n; i++) if (lens[i]) sym[offs[lens[i]]++] = i;
    return { count, sym };
  };
  const decode = (h) => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const c = h.count[len];
      if (code - c < first) return h.sym[index + (code - first)];
      index += c; first += c; first <<= 1; code <<= 1;
    }
    throw new Error('bad code');
  };
  const LB = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LE = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DB = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DE = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const codes = (lit, dist) => {
    for (;;) {
      let s = decode(lit);
      if (s < 256) { out.push(s); continue; }
      if (s === 256) return;
      s -= 257;
      const len = LB[s] + bits(LE[s]);
      const ds = decode(dist);
      const d = DB[ds] + bits(DE[ds]);
      for (let i = 0; i < len; i++) out.push(out[out.length - d]);
    }
  };
  let last;
  do {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      cnt = 0;
      const len = src[pos] | (src[pos + 1] << 8);
      pos += 4;
      for (let i = 0; i < len; i++) out.push(src[pos++]);
    } else if (type === 1) {
      const l = new Uint8Array(288);
      for (let i = 0; i < 288; i++) l[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
      codes(table(l, 288), table(new Uint8Array(30).fill(5), 30));
    } else if (type === 2) {
      const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
      const ORD = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
      const cl = new Uint8Array(19);
      for (let i = 0; i < ncode; i++) cl[ORD[i]] = bits(3);
      const ch = table(cl, 19), lens = new Uint8Array(nlen + ndist);
      for (let i = 0; i < nlen + ndist;) {
        const s = decode(ch);
        if (s < 16) lens[i++] = s;
        else {
          let v = 0, r;
          if (s === 16) { v = lens[i - 1]; r = 3 + bits(2); } else if (s === 17) r = 3 + bits(3); else r = 11 + bits(7);
          while (r--) lens[i++] = v;
        }
      }
      codes(table(lens.subarray(0, nlen), nlen), table(lens.subarray(nlen), ndist));
    } else throw new Error('bad block');
  } while (!last);
  return Uint8Array.from(out);
}
