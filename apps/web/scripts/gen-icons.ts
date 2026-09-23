/**
 * PWA icon generator. Run from anywhere:
 *
 *   bun apps/web/scripts/gen-icons.ts
 *
 * Draws the Mise mark — a white 2px-stroke circle with the pinned-event spine
 * to its left — on a solid --ink (#16181D) ground, and encodes it as real
 * PNGs with a minimal hand-rolled encoder (raw RGBA scanlines, filter 0,
 * zlib deflateSync, CRC32). No image dependencies.
 *
 * Outputs:
 *   public/icons/icon-192.png        rounded square (mark in maskable safe zone)
 *   public/icons/icon-512.png        rounded square
 *   public/icons/apple-touch-icon.png  180×180, full bleed (iOS applies its own mask)
 *   public/apple-touch-icon.png      copy of the above — layout.tsx links this path
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Minimal PNG encoder
// ---------------------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function encodePng(size: number, rgba: Uint8Array): Buffer {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size);
  dv.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // Each scanline prefixed with filter byte 0 (None).
  const stride = size * 4;
  const raw = new Uint8Array(size * (1 + stride));
  for (let y = 0; y < size; y++) {
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (1 + stride) + 1);
  }
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

// ---------------------------------------------------------------------------
// The mark: circle (1px-border analogue) + left spine (the 2px pinned rule)
// ---------------------------------------------------------------------------

const INK = [0x16, 0x18, 0x1d] as const;
const SS = 4; // 4×4 supersampling per pixel

function drawIcon(size: number, rounded: boolean): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const half = size / 2;
  const cornerR = rounded ? size * 0.12 : 0;
  const stroke = size / 32; // "1px" at icon scale
  const spineW = stroke * 2; // the 2px spine
  const R = size * 0.21; // circle radius
  const cx = size * 0.57;
  const cy = size * 0.5;
  const spineX = size * 0.27;
  const markTop = cy - R - stroke / 2;
  const markBot = cy + R + stroke / 2;

  const inBg = (x: number, y: number): boolean => {
    if (cornerR === 0) return true; // full bleed
    const qx = Math.abs(x - half) - (half - cornerR);
    const qy = Math.abs(y - half) - (half - cornerR);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) <= cornerR;
  };

  const inMark = (x: number, y: number): boolean => {
    if (Math.abs(x - spineX) <= spineW / 2 && y >= markTop && y <= markBot) return true;
    return Math.abs(Math.hypot(x - cx, y - cy) - R) <= stroke / 2;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0;
      let markHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const sampleX = x + (sx + 0.5) / SS;
          const sampleY = y + (sy + 0.5) / SS;
          if (!inBg(sampleX, sampleY)) continue;
          bgHits++;
          if (inMark(sampleX, sampleY)) markHits++;
        }
      }
      const alpha = bgHits / (SS * SS);
      const mark = bgHits > 0 ? markHits / bgHits : 0;
      const i = (y * size + x) * 4;
      px[i] = Math.round(INK[0] * (1 - mark) + 0xff * mark);
      px[i + 1] = Math.round(INK[1] * (1 - mark) + 0xff * mark);
      px[i + 2] = Math.round(INK[2] * (1 - mark) + 0xff * mark);
      px[i + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

// ---------------------------------------------------------------------------
// Write files
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url)); // apps/web/scripts
const pub = join(here, '..', 'public');
mkdirSync(join(pub, 'icons'), { recursive: true });

writeFileSync(join(pub, 'icons', 'icon-192.png'), encodePng(192, drawIcon(192, true)));
writeFileSync(join(pub, 'icons', 'icon-512.png'), encodePng(512, drawIcon(512, true)));

const apple = encodePng(180, drawIcon(180, false));
writeFileSync(join(pub, 'icons', 'apple-touch-icon.png'), apple);
// layout.tsx links /apple-touch-icon.png at the public root — keep it in sync.
writeFileSync(join(pub, 'apple-touch-icon.png'), apple);

console.log('wrote icon-192.png, icon-512.png, apple-touch-icon.png (x2)');
