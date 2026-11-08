import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(process.cwd(), "public", "icons");
mkdirSync(OUT, { recursive: true });

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function mix(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function roundedRect(pixels, size, x0, y0, x1, y1, r, color) {
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(size, Math.ceil(y1)); y += 1) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(size, Math.ceil(x1)); x += 1) {
      const dx = x < x0 + r ? x0 + r - x : x > x1 - r ? x - (x1 - r) : 0;
      const dy = y < y0 + r ? y0 + r - y : y > y1 - r ? y - (y1 - r) : 0;
      if (dx * dx + dy * dy <= r * r) {
        const i = (y * size + x) * 4;
        pixels[i] = color[0];
        pixels[i + 1] = color[1];
        pixels[i + 2] = color[2];
        pixels[i + 3] = color[3] ?? 255;
      }
    }
  }
}

function circle(pixels, size, cx, cy, radius, color) {
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y += 1) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x += 1) {
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= radius * radius) {
        const i = (y * size + x) * 4;
        pixels[i] = color[0];
        pixels[i + 1] = color[1];
        pixels[i + 2] = color[2];
        pixels[i + 3] = color[3] ?? 255;
      }
    }
  }
}

function gradient(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const t = (x + y) / (size * 2 - 2);
      const i = (y * size + x) * 4;
      pixels[i] = mix(30, 20, t);
      pixels[i + 1] = mix(103, 56, t);
      pixels[i + 2] = mix(86, 49, t);
      pixels[i + 3] = 255;
    }
  }
  return pixels;
}

function draw(size, padding) {
  const pixels = gradient(size);
  const s = size;
  const pad = s * padding;
  const cardX0 = pad;
  const cardY0 = pad;
  const cardX1 = s - pad;
  const cardY1 = s - pad;
  const radius = s * 0.12;
  roundedRect(pixels, s, cardX0, cardY0, cardX1, cardY1, radius, [255, 255, 255, 235]);

  const inset = s * 0.055;
  roundedRect(
    pixels,
    s,
    cardX0 + inset,
    cardY0 + inset,
    cardX1 - inset,
    cardY1 - inset,
    radius * 0.6,
    [255, 255, 255, 255],
  );

  const brand = [30, 103, 86, 255];
  const lineH = s * 0.052;
  const left = cardX0 + s * 0.11;
  const widths = [0.46, 0.36, 0.42, 0.28];
  const startY = cardY0 + s * 0.16;
  for (let i = 0; i < widths.length; i += 1) {
    roundedRect(
      pixels,
      s,
      left,
      startY + i * (lineH + s * 0.045),
      left + s * widths[i],
      startY + i * (lineH + s * 0.045) + lineH,
      lineH / 2,
      brand,
    );
  }

  circle(pixels, s, cardX1 - s * 0.2, cardY1 - s * 0.2, s * 0.095, brand);
  roundedRect(
    pixels,
    s,
    cardX1 - s * 0.235,
    cardY1 - s * 0.208,
    cardX1 - s * 0.195,
    cardY1 - s * 0.168,
    s * 0.02,
    [255, 255, 255, 255],
  );
  return pixels;
}

const targets = [
  ["icon-192.png", 192, 0.14],
  ["icon-512.png", 512, 0.14],
  ["icon-maskable-512.png", 512, 0.2],
  ["apple-touch-icon.png", 180, 0.12],
];

for (const [name, size, padding] of targets) {
  writeFileSync(join(OUT, name), encodePng(size, size, draw(size, padding)));
  console.log(`wrote ${name}`);
}
