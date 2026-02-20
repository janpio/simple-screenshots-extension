const assert = require("node:assert/strict");

async function readClipboardPngMetrics(page, options = {}) {
  const samplePoints = options.samplePoints || [];

  return page.evaluate(async ({ samplePoints: points }) => {
    const items = await navigator.clipboard.read();
    const pngItem = items.find((item) => item.types.includes("image/png"));
    if (!pngItem) {
      throw new Error("Clipboard does not contain an image/png item");
    }

    const blob = await pngItem.getType("image/png");
    const bitmap = await createImageBitmap(blob);

    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;

    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);

    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const pixelCount = data.length / 4;
    const stride = Math.max(1, Math.floor(pixelCount / 10000));

    let mean = 0;
    let count = 0;
    for (let i = 0; i < pixelCount; i += stride) {
      const idx = i * 4;
      const lum = 0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2];
      mean += lum;
      count++;
    }
    mean /= Math.max(count, 1);

    let varianceSum = 0;
    for (let i = 0; i < pixelCount; i += stride) {
      const idx = i * 4;
      const lum = 0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2];
      const diff = lum - mean;
      varianceSum += diff * diff;
    }
    const variance = varianceSum / Math.max(count, 1);

    const samples = {};
    for (const point of points) {
      const x = Math.max(0, Math.min(canvas.width - 1, Math.round(point.x)));
      const y = Math.max(0, Math.min(canvas.height - 1, Math.round(point.y)));
      const idx = (y * canvas.width + x) * 4;
      samples[point.label] = {
        r: data[idx],
        g: data[idx + 1],
        b: data[idx + 2],
        a: data[idx + 3],
        x,
        y,
      };
    }

    return {
      width: canvas.width,
      height: canvas.height,
      pngBytes: blob.size,
      variance,
      samples,
    };
  }, { samplePoints });
}

function assertColorBandSamples(metrics, expectedSamples) {
  for (const expected of expectedSamples) {
    const actual = metrics.samples[expected.label];
    assert.ok(actual, `Missing sample '${expected.label}'`);

    const tolerance = expected.tolerance ?? 16;
    const deltas = {
      r: Math.abs(actual.r - expected.r),
      g: Math.abs(actual.g - expected.g),
      b: Math.abs(actual.b - expected.b),
    };

    assert.ok(
      deltas.r <= tolerance && deltas.g <= tolerance && deltas.b <= tolerance,
      `Sample '${expected.label}' outside tolerance ${tolerance}: expected rgb(${expected.r},${expected.g},${expected.b}), got rgb(${actual.r},${actual.g},${actual.b})`
    );
  }
}

module.exports = {
  readClipboardPngMetrics,
  assertColorBandSamples,
};
