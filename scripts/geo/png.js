/* ── PNG → RGBA pixels, in the browser or in Node ──
   Browser: createImageBitmap + OffscreenCanvas (no colour management, so the
   elevation bytes come back exactly as encoded).
   Node: a minimal decoder for 8-bit, non-interlaced greyscale/RGB/RGBA PNGs
   (what the Terrarium elevation tiles are), using the built-in zlib. */

export async function decodePng(bytes) {
  if (typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function') {
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), {
      colorSpaceConversion: 'none', premultiplyAlpha: 'none',
    });
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    return { width: bmp.width, height: bmp.height, data: g.getImageData(0, 0, bmp.width, bmp.height).data };
  }
  return decodePngNode(bytes);
}

async function decodePngNode(u8) {
  const { inflateSync } = await import('node:zlib');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = 8, width = 0, height = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  while (p < u8.length) {
    const len = dv.getUint32(p), type = String.fromCharCode(...u8.subarray(p + 4, p + 8));
    const body = u8.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      const h = new DataView(body.buffer, body.byteOffset, body.byteLength);
      width = h.getUint32(0); height = h.getUint32(4); depth = body[8]; ctype = body[9]; interlace = body[12];
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ctype];
  if (depth !== 8 || !ch || interlace) throw new Error(`unsupported PNG (depth ${depth}, type ${ctype}, interlace ${interlace})`);
  const raw = inflateSync(Buffer.concat(idat.map((b) => Buffer.from(b.buffer, b.byteOffset, b.byteLength))));
  const stride = width * ch, px = new Uint8Array(height * stride);
  for (let y = 0, q = 0; y < height; y++) {
    const f = raw[q++], row = y * stride, prev = row - stride;
    for (let x = 0; x < stride; x++, q++) {
      const a = x >= ch ? px[row + x - ch] : 0, b = y ? px[prev + x] : 0, c = x >= ch && y ? px[prev + x - ch] : 0;
      let v = raw[q];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[row + x] = v & 255;
    }
  }
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * ch, d = i * 4;
    if (ch === 1 || ch === 2) { data[d] = data[d + 1] = data[d + 2] = px[s]; data[d + 3] = ch === 2 ? px[s + 1] : 255; }
    else { data[d] = px[s]; data[d + 1] = px[s + 1]; data[d + 2] = px[s + 2]; data[d + 3] = ch === 4 ? px[s + 3] : 255; }
  }
  return { width, height, data };
}
