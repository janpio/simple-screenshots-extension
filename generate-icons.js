#!/usr/bin/env node
/**
 * generate-icons.js
 *
 * Generates icon16.png, icon48.png, and icon128.png in the icons/ directory.
 *
 * Design: Camera icon with white fill and dark grey (#333) stroke on a
 * transparent background. Works on both light and dark browser toolbars.
 *
 * Usage:
 *   npm install          (canvas is configured as an optional dependency)
 *   node generate-icons.js
 */

const fs = require("fs");
const path = require("path");

const ICONS_DIR = path.join(__dirname, "icons");

const SIZES = [
  { size: 16, stroke: 1 },
  { size: 48, stroke: 2 },
  { size: 128, stroke: 4 },
];

// ---------------------------------------------------------------------------
// SVG generation
// ---------------------------------------------------------------------------

function generateSVG(size, strokeWidth) {
  const pad = strokeWidth / 2 + 1;

  // Camera body: rounded rectangle
  const bodyX = pad;
  const bodyY = size * 0.28;
  const bodyW = size - 2 * pad;
  const bodyH = size * 0.55;
  const bodyR = size * 0.1;

  // Camera viewfinder bump (small rectangle on top)
  const bumpW = size * 0.30;
  const bumpH = size * 0.14;
  const bumpX = size * 0.35;
  const bumpY = bodyY - bumpH + strokeWidth / 2;
  const bumpR = size * 0.05;

  // Lens: circle in center of body
  const lensR = Math.min(bodyW, bodyH) * 0.30;
  const lensCX = size / 2;
  const lensCY = bodyY + bodyH / 2;

  // Small detail circle inside lens
  const innerR = lensR * 0.45;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <!-- viewfinder bump -->
  <rect x="${bumpX}" y="${bumpY}" width="${bumpW}" height="${bumpH + bodyR}"
        rx="${bumpR}" ry="${bumpR}"
        fill="white" stroke="#333" stroke-width="${strokeWidth}"
        stroke-linejoin="round"/>
  <!-- camera body -->
  <rect x="${bodyX}" y="${bodyY}" width="${bodyW}" height="${bodyH}"
        rx="${bodyR}" ry="${bodyR}"
        fill="white" stroke="#333" stroke-width="${strokeWidth}"
        stroke-linejoin="round"/>
  <!-- lens outer -->
  <circle cx="${lensCX}" cy="${lensCY}" r="${lensR}"
          fill="white" stroke="#333" stroke-width="${strokeWidth}"/>
  <!-- lens inner -->
  <circle cx="${lensCX}" cy="${lensCY}" r="${innerR}"
          fill="#333" stroke="none"/>
</svg>`;
}

// ---------------------------------------------------------------------------
// Strategy 1: node-canvas
// ---------------------------------------------------------------------------

async function generateWithCanvas() {
  const { createCanvas, loadImage } = require("canvas");

  for (const { size, stroke } of SIZES) {
    const svg = generateSVG(size, stroke);
    const dataUri =
      "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
    const img = await loadImage(dataUri);
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, size, size);
    const outPath = path.join(ICONS_DIR, `icon${size}.png`);
    fs.writeFileSync(outPath, canvas.toBuffer("image/png"));
    console.log(`  wrote ${outPath}`);
  }
}

// ---------------------------------------------------------------------------
// Strategy 2: sharp
// ---------------------------------------------------------------------------

async function generateWithSharp() {
  const sharp = require("sharp");

  for (const { size, stroke } of SIZES) {
    const svg = generateSVG(size, stroke);
    const outPath = path.join(ICONS_DIR, `icon${size}.png`);
    await sharp(Buffer.from(svg)).resize(size, size).png().toFile(outPath);
    console.log(`  wrote ${outPath}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!fs.existsSync(ICONS_DIR)) {
    fs.mkdirSync(ICONS_DIR, { recursive: true });
  }

  // Try canvas first, then sharp
  const strategies = [
    { name: "canvas", fn: generateWithCanvas },
    { name: "sharp", fn: generateWithSharp },
  ];

  for (const { name, fn } of strategies) {
    try {
      require.resolve(name);
    } catch {
      console.log(`  '${name}' not installed, skipping...`);
      continue;
    }
    try {
      console.log(`Generating icons with '${name}'...`);
      await fn();
      console.log("Done.");
      return;
    } catch (err) {
      console.error(`  '${name}' failed: ${err.message}`);
    }
  }

  console.error(
    "ERROR: No image library available. Install one of: canvas, sharp"
  );
  console.error("  npm install canvas   OR   npm install sharp");
  process.exit(1);
}

main();
