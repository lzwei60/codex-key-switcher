import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';

const root = process.cwd();
const buildDir = path.join(root, 'apps/desktop/build');
const iconsetDir = path.join(buildDir, 'icon.iconset');

fs.rmSync(iconsetDir, { recursive: true, force: true });
fs.mkdirSync(iconsetDir, { recursive: true });

const iconsetFiles = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

for (const [fileName, size] of iconsetFiles) {
  fs.writeFileSync(path.join(iconsetDir, fileName), renderIconPng(size));
}

fs.writeFileSync(path.join(buildDir, 'icon.png'), renderIconPng(1024));
fs.writeFileSync(path.join(buildDir, 'icon.ico'), createIco([16, 24, 32, 48, 64, 128, 256]));

if (process.platform === 'darwin') {
  execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', path.join(buildDir, 'icon.icns')], {
    stdio: 'inherit',
  });
  fs.rmSync(iconsetDir, { recursive: true, force: true });
}

console.log(`Generated app icons in ${path.relative(root, buildDir)}`);

function renderIconPng(size) {
  const pixels = new Uint8Array(size * size * 4);
  drawRoundedRect(pixels, size, 512, 512, 920, 920, 220, [11, 18, 32, 255]);
  drawRoundedRect(pixels, size, 512, 384, 690, 150, 75, [255, 255, 255, 15]);
  drawCircle(pixels, size, 260, 260, 180, [45, 212, 191, 38]);
  drawCircle(pixels, size, 782, 760, 240, [59, 130, 246, 42]);
  drawCapsule(pixels, size, 220, 820, 830, 210, 30, [45, 212, 191, 130]);
  drawCapsule(pixels, size, 256, 862, 866, 252, 16, [96, 165, 250, 160]);

  drawCapsule(pixels, size, 216, 352, 440, 352, 54, [248, 250, 252, 255]);
  drawCapsule(pixels, size, 216, 672, 440, 672, 54, [248, 250, 252, 255]);
  drawCapsule(pixels, size, 216, 352, 216, 672, 54, [248, 250, 252, 255]);

  drawCapsule(pixels, size, 572, 330, 572, 694, 54, [248, 250, 252, 255]);
  drawCapsule(pixels, size, 610, 520, 790, 340, 52, [248, 250, 252, 255]);
  drawCapsule(pixels, size, 610, 520, 804, 690, 52, [248, 250, 252, 255]);
  drawCircle(pixels, size, 610, 520, 57, [248, 250, 252, 255]);

  drawCircle(pixels, size, 812, 318, 34, [45, 212, 191, 255]);
  drawCircle(pixels, size, 812, 706, 34, [59, 130, 246, 255]);
  return encodePng(size, size, pixels);
}

function drawRoundedRect(pixels, size, cx, cy, width, height, radius, color) {
  drawSdf(pixels, size, color, (x, y) => {
    const sx = 1024 / size;
    const px = (x + 0.5) * sx;
    const py = (y + 0.5) * sx;
    const qx = Math.abs(px - cx) - width / 2 + radius;
    const qy = Math.abs(py - cy) - height / 2 + radius;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
  });
}

function drawCircle(pixels, size, cx, cy, radius, color) {
  drawSdf(pixels, size, color, (x, y) => {
    const sx = 1024 / size;
    const px = (x + 0.5) * sx;
    const py = (y + 0.5) * sx;
    return Math.hypot(px - cx, py - cy) - radius;
  });
}

function drawCapsule(pixels, size, ax, ay, bx, by, radius, color) {
  drawSdf(pixels, size, color, (x, y) => {
    const sx = 1024 / size;
    const px = (x + 0.5) * sx;
    const py = (y + 0.5) * sx;
    const abx = bx - ax;
    const aby = by - ay;
    const apx = px - ax;
    const apy = py - ay;
    const t = clamp((apx * abx + apy * aby) / (abx * abx + aby * aby), 0, 1);
    return Math.hypot(px - (ax + abx * t), py - (ay + aby * t)) - radius;
  });
}

function drawSdf(pixels, size, color, sdf) {
  const edge = 1024 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = sdf(x, y);
      const alpha = clamp(0.5 - distance / edge, 0, 1) * (color[3] / 255);
      if (alpha <= 0) continue;
      blendPixel(pixels, (y * size + x) * 4, color, alpha);
    }
  }
}

function blendPixel(pixels, offset, color, alpha) {
  const sourceAlpha = alpha;
  const targetAlpha = pixels[offset + 3] / 255;
  const outAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
  if (outAlpha <= 0) return;

  pixels[offset] = Math.round((color[0] * sourceAlpha + pixels[offset] * targetAlpha * (1 - sourceAlpha)) / outAlpha);
  pixels[offset + 1] = Math.round((color[1] * sourceAlpha + pixels[offset + 1] * targetAlpha * (1 - sourceAlpha)) / outAlpha);
  pixels[offset + 2] = Math.round((color[2] * sourceAlpha + pixels[offset + 2] * targetAlpha * (1 - sourceAlpha)) / outAlpha);
  pixels[offset + 3] = Math.round(outAlpha * 255);
}

function createIco(sizes) {
  const images = sizes.map((size) => renderIconPng(size));
  const headerSize = 6 + images.length * 16;
  let offset = headerSize;
  const chunks = [Buffer.alloc(headerSize)];
  chunks[0].writeUInt16LE(0, 0);
  chunks[0].writeUInt16LE(1, 2);
  chunks[0].writeUInt16LE(images.length, 4);

  images.forEach((image, index) => {
    const size = sizes[index];
    const entryOffset = 6 + index * 16;
    chunks[0][entryOffset] = size >= 256 ? 0 : size;
    chunks[0][entryOffset + 1] = size >= 256 ? 0 : size;
    chunks[0][entryOffset + 2] = 0;
    chunks[0][entryOffset + 3] = 0;
    chunks[0].writeUInt16LE(1, entryOffset + 4);
    chunks[0].writeUInt16LE(32, entryOffset + 6);
    chunks[0].writeUInt32LE(image.length, entryOffset + 8);
    chunks[0].writeUInt32LE(offset, entryOffset + 12);
    chunks.push(image);
    offset += image.length;
  });

  return Buffer.concat(chunks);
}

function encodePng(width, height, rgba) {
  const rowLength = width * 4 + 1;
  const raw = Buffer.alloc(rowLength * height);
  for (let y = 0; y < height; y++) {
    raw[y * rowLength] = 0;
    Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * rowLength + 1);
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', (() => {
      const data = Buffer.alloc(13);
      data.writeUInt32BE(width, 0);
      data.writeUInt32BE(height, 4);
      data[8] = 8;
      data[9] = 6;
      data[10] = 0;
      data[11] = 0;
      data[12] = 0;
      return data;
    })()),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
