/**
 * Hello World STP Provider
 *
 * A test provider that demonstrates the stimma-tools-protocol framework.
 * Provides a simple text-to-image tool that renders prompt text as a PNG.
 */

import { deflateSync } from "node:zlib";
import {
  defineTool,
  Provider,
  runProvider,
  setupLogging,
  createArgumentParser,
} from "../../src/index.js";
import type { ExecutionContext, ToolParameterDef } from "../../src/index.js";

// --- Minimal PNG generator (no native deps) ---

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

function renderTextToPng(
  text: string,
  width: number,
  height: number,
): Buffer {
  // 8-bit RGB image
  const pixels = Buffer.alloc(width * height * 3);

  // Dark background (30, 30, 40)
  for (let i = 0; i < width * height; i++) {
    pixels[i * 3] = 30;
    pixels[i * 3 + 1] = 30;
    pixels[i * 3 + 2] = 40;
  }

  // Simple 5x7 bitmap font for ASCII 32-126
  const FONT: Record<string, number[]> = {
    " ": [0, 0, 0, 0, 0, 0, 0],
    "!": [4, 4, 4, 4, 4, 0, 4],
    '"': [10, 10, 0, 0, 0, 0, 0],
    "#": [10, 31, 10, 10, 31, 10, 0],
    $: [4, 15, 20, 14, 5, 30, 4],
    "%": [24, 25, 2, 4, 8, 19, 3],
    "&": [12, 18, 12, 22, 9, 9, 22],
    "'": [4, 4, 0, 0, 0, 0, 0],
    "(": [2, 4, 8, 8, 8, 4, 2],
    ")": [8, 4, 2, 2, 2, 4, 8],
    "*": [0, 4, 21, 14, 21, 4, 0],
    "+": [0, 4, 4, 31, 4, 4, 0],
    ",": [0, 0, 0, 0, 0, 4, 8],
    "-": [0, 0, 0, 31, 0, 0, 0],
    ".": [0, 0, 0, 0, 0, 0, 4],
    "/": [1, 1, 2, 4, 8, 16, 16],
    "0": [14, 17, 19, 21, 25, 17, 14],
    "1": [4, 12, 4, 4, 4, 4, 14],
    "2": [14, 17, 1, 6, 8, 16, 31],
    "3": [14, 17, 1, 6, 1, 17, 14],
    "4": [2, 6, 10, 18, 31, 2, 2],
    "5": [31, 16, 30, 1, 1, 17, 14],
    "6": [6, 8, 16, 30, 17, 17, 14],
    "7": [31, 1, 2, 4, 8, 8, 8],
    "8": [14, 17, 17, 14, 17, 17, 14],
    "9": [14, 17, 17, 15, 1, 2, 12],
    ":": [0, 0, 4, 0, 0, 4, 0],
    ";": [0, 0, 4, 0, 0, 4, 8],
    "<": [2, 4, 8, 16, 8, 4, 2],
    "=": [0, 0, 31, 0, 31, 0, 0],
    ">": [8, 4, 2, 1, 2, 4, 8],
    "?": [14, 17, 1, 2, 4, 0, 4],
    "@": [14, 17, 23, 21, 23, 16, 14],
    A: [14, 17, 17, 31, 17, 17, 17],
    B: [30, 17, 17, 30, 17, 17, 30],
    C: [14, 17, 16, 16, 16, 17, 14],
    D: [30, 17, 17, 17, 17, 17, 30],
    E: [31, 16, 16, 30, 16, 16, 31],
    F: [31, 16, 16, 30, 16, 16, 16],
    G: [14, 17, 16, 19, 17, 17, 14],
    H: [17, 17, 17, 31, 17, 17, 17],
    I: [14, 4, 4, 4, 4, 4, 14],
    J: [7, 2, 2, 2, 2, 18, 12],
    K: [17, 18, 20, 24, 20, 18, 17],
    L: [16, 16, 16, 16, 16, 16, 31],
    M: [17, 27, 21, 21, 17, 17, 17],
    N: [17, 25, 25, 21, 19, 19, 17],
    O: [14, 17, 17, 17, 17, 17, 14],
    P: [30, 17, 17, 30, 16, 16, 16],
    Q: [14, 17, 17, 17, 21, 18, 13],
    R: [30, 17, 17, 30, 20, 18, 17],
    S: [14, 17, 16, 14, 1, 17, 14],
    T: [31, 4, 4, 4, 4, 4, 4],
    U: [17, 17, 17, 17, 17, 17, 14],
    V: [17, 17, 17, 17, 10, 10, 4],
    W: [17, 17, 17, 21, 21, 27, 17],
    X: [17, 17, 10, 4, 10, 17, 17],
    Y: [17, 17, 10, 4, 4, 4, 4],
    Z: [31, 1, 2, 4, 8, 16, 31],
    "[": [14, 8, 8, 8, 8, 8, 14],
    "\\": [16, 16, 8, 4, 2, 1, 1],
    "]": [14, 2, 2, 2, 2, 2, 14],
    "^": [4, 10, 17, 0, 0, 0, 0],
    _: [0, 0, 0, 0, 0, 0, 31],
    "`": [8, 4, 0, 0, 0, 0, 0],
    a: [0, 0, 14, 1, 15, 17, 15],
    b: [16, 16, 30, 17, 17, 17, 30],
    c: [0, 0, 14, 17, 16, 17, 14],
    d: [1, 1, 15, 17, 17, 17, 15],
    e: [0, 0, 14, 17, 31, 16, 14],
    f: [6, 8, 28, 8, 8, 8, 8],
    g: [0, 0, 15, 17, 15, 1, 14],
    h: [16, 16, 30, 17, 17, 17, 17],
    i: [4, 0, 12, 4, 4, 4, 14],
    j: [2, 0, 2, 2, 2, 18, 12],
    k: [16, 16, 18, 20, 24, 20, 18],
    l: [12, 4, 4, 4, 4, 4, 14],
    m: [0, 0, 26, 21, 21, 17, 17],
    n: [0, 0, 30, 17, 17, 17, 17],
    o: [0, 0, 14, 17, 17, 17, 14],
    p: [0, 0, 30, 17, 30, 16, 16],
    q: [0, 0, 15, 17, 15, 1, 1],
    r: [0, 0, 22, 25, 16, 16, 16],
    s: [0, 0, 15, 16, 14, 1, 30],
    t: [8, 8, 28, 8, 8, 9, 6],
    u: [0, 0, 17, 17, 17, 17, 15],
    v: [0, 0, 17, 17, 10, 10, 4],
    w: [0, 0, 17, 17, 21, 21, 10],
    x: [0, 0, 17, 10, 4, 10, 17],
    y: [0, 0, 17, 17, 15, 1, 14],
    z: [0, 0, 31, 2, 4, 8, 31],
    "{": [2, 4, 4, 8, 4, 4, 2],
    "|": [4, 4, 4, 4, 4, 4, 4],
    "}": [8, 4, 4, 2, 4, 4, 8],
    "~": [0, 0, 8, 21, 2, 0, 0],
  };

  const CHAR_W = 6; // 5px + 1px gap
  const CHAR_H = 9; // 7px + 2px gap
  const MARGIN = 16;
  const maxCharsPerLine = Math.floor((width - 2 * MARGIN) / CHAR_W);

  // Word-wrap
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(" ");
    if (words.length === 0 || (words.length === 1 && words[0] === "")) {
      lines.push("");
      continue;
    }
    let current = words[0];
    for (let i = 1; i < words.length; i++) {
      const test = current + " " + words[i];
      if (test.length <= maxCharsPerLine) {
        current = test;
      } else {
        lines.push(current);
        current = words[i];
      }
    }
    lines.push(current);
  }

  // Draw characters
  const fg = [200, 200, 220];
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const baseY = MARGIN + lineIdx * CHAR_H;
    if (baseY + 7 > height - MARGIN) break;
    const line = lines[lineIdx];
    for (let ci = 0; ci < line.length; ci++) {
      const baseX = MARGIN + ci * CHAR_W;
      if (baseX + 5 > width) break;
      const ch = line[ci];
      const glyph = FONT[ch] ?? FONT["?"];
      if (!glyph) continue;
      for (let row = 0; row < 7; row++) {
        const bits = glyph[row];
        for (let col = 0; col < 5; col++) {
          if (bits & (1 << (4 - col))) {
            const px = baseX + col;
            const py = baseY + row;
            if (px < width && py < height) {
              const idx = (py * width + px) * 3;
              pixels[idx] = fg[0];
              pixels[idx + 1] = fg[1];
              pixels[idx + 2] = fg[2];
            }
          }
        }
      }
    }
  }

  // Encode as PNG
  const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // IDAT: each row = filter byte (0) + RGB pixels
  const rawRows = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + width * 3);
    rawRows[rowOffset] = 0; // no filter
    pixels.copy(rawRows, rowOffset + 1, y * width * 3, (y + 1) * width * 3);
  }
  const compressed = deflateSync(rawRows);

  // IEND
  const iend = Buffer.alloc(0);

  return Buffer.concat([
    PNG_SIG,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", iend),
  ]);
}

// --- Tool ---

const t2iTestTool = defineTool({
  slug: "t2i-test",
  displayName: "T2I Test Tool",
  taskTypes: "text-to-image",
  description: "Test tool for text-to-image - renders prompt text as a PNG image.",
  parameters: [
    {
      name: "prompt",
      type: "string",
      description: "Text to render",
      required: true,
    },
    {
      name: "uppercase",
      type: "boolean",
      description: "Convert text to uppercase",
      default: false,
    },
    {
      name: "width",
      type: "integer",
      description: "Image width",
      default: 512,
      minimum: 128,
      maximum: 2048,
    },
    {
      name: "height",
      type: "integer",
      description: "Image height",
      default: 512,
      minimum: 128,
      maximum: 2048,
    },
  ],
  execute: async (context, parameters) => {
    let text = (parameters.prompt as string) ?? "Hello World!";
    const uppercase = parameters.uppercase as boolean;
    const width = (parameters.width as number) ?? 512;
    const height = (parameters.height as number) ?? 512;

    await context.reportProgress(0.0);

    if (uppercase) {
      text = text.toUpperCase();
    }

    await context.reportProgress(0.3);

    const pngData = renderTextToPng(text, width, height);

    await context.reportProgress(0.8);

    const assetId = await context.assets.upload(pngData, ".png");

    await context.reportProgress(1.0);

    return { asset_id: assetId };
  },
});

// --- Main ---

async function main() {
  const parser = createArgumentParser("Hello World STP Provider");
  const args = parser.parse();

  setupLogging(args.logLevel);

  const provider = new Provider({
    config: {
      providerId: "hello-world",
      providerName: "Hello World Provider",
      server: "hello-world/1.0.0",
      maxConcurrent: 2,
      supportsCancel: true,
    },
  });

  await runProvider(provider, args);
}

main().catch((e) => {
  process.stderr.write(`Fatal error: ${e}\n`);
  process.exit(1);
});
