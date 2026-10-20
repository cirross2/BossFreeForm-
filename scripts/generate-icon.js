/**
 * Generates FreeformDrive's unique multi-resolution Windows icon (assets/icon.ico, assets/icon.png, assets/icon.svg)
 * Design: Apple macOS/Freeform squircle dark glass badge + tilted golden sticky note + electric blue board card
 * + glowing cyan/magenta bezier connector curve & creative pen nib.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
if (!fs.existsSync(ASSETS_DIR)) {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
}

// ============================================================================
// 1. Vector Master SVG (assets/icon.svg)
// ============================================================================
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#171926"/>
      <stop offset="50%" stop-color="#0f111a"/>
      <stop offset="100%" stop-color="#07080d"/>
    </linearGradient>
    <radialGradient id="ambientGlow" cx="75%" cy="22%" r="70%">
      <stop offset="0%" stop-color="#2997ff" stop-opacity="0.38"/>
      <stop offset="55%" stop-color="#bf5af2" stop-opacity="0.16"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="blueCard" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#2997ff"/>
      <stop offset="100%" stop-color="#0055d4"/>
    </linearGradient>
    <linearGradient id="stickyCard" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffe66d"/>
      <stop offset="100%" stop-color="#ff9f0a"/>
    </linearGradient>
    <linearGradient id="curveGrad" x1="0%" y1="100%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#ff2d55"/>
      <stop offset="50%" stop-color="#bf5af2"/>
      <stop offset="100%" stop-color="#00f5d4"/>
    </linearGradient>
    <filter id="dropShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#000000" flood-opacity="0.55"/>
    </filter>
  </defs>

  <!-- Apple Squircle Base -->
  <rect x="20" y="20" width="472" height="472" rx="112" fill="url(#bgGrad)" stroke="#ffffff" stroke-opacity="0.16" stroke-width="6"/>
  <rect x="20" y="20" width="472" height="472" rx="112" fill="url(#ambientGlow)"/>

  <!-- Subtle Infinite Canvas Dot Grid -->
  <g fill="#ffffff" fill-opacity="0.12">
    <circle cx="116" cy="116" r="4"/><circle cx="186" cy="116" r="4"/><circle cx="256" cy="116" r="4"/><circle cx="326" cy="116" r="4"/><circle cx="396" cy="116" r="4"/>
    <circle cx="116" cy="186" r="4"/><circle cx="186" cy="186" r="4"/><circle cx="256" cy="186" r="4"/><circle cx="326" cy="186" r="4"/><circle cx="396" cy="186" r="4"/>
    <circle cx="116" cy="256" r="4"/><circle cx="186" cy="256" r="4"/><circle cx="256" cy="256" r="4"/><circle cx="326" cy="256" r="4"/><circle cx="396" cy="256" r="4"/>
    <circle cx="116" cy="326" r="4"/><circle cx="186" cy="326" r="4"/><circle cx="256" cy="326" r="4"/><circle cx="326" cy="326" r="4"/><circle cx="396" cy="326" r="4"/>
    <circle cx="116" cy="396" r="4"/><circle cx="186" cy="396" r="4"/><circle cx="256" cy="396" r="4"/><circle cx="326" cy="396" r="4"/><circle cx="396" cy="396" r="4"/>
  </g>

  <!-- Back Blue Board Card (Tilted Right) -->
  <g transform="translate(295 215) rotate(10) translate(-115 -95)" filter="url(#dropShadow)">
    <rect x="0" y="0" width="230" height="190" rx="34" fill="url(#blueCard)" stroke="#80c4ff" stroke-opacity="0.55" stroke-width="4"/>
    <rect x="28" y="34" width="110" height="14" rx="7" fill="#ffffff" fill-opacity="0.9"/>
    <rect x="28" y="66" width="168" height="12" rx="6" fill="#ffffff" fill-opacity="0.55"/>
    <rect x="28" y="92" width="140" height="12" rx="6" fill="#ffffff" fill-opacity="0.55"/>
    <circle cx="42" cy="138" r="11" fill="#30d158"/>
    <rect x="64" y="132" width="110" height="12" rx="6" fill="#ffffff" fill-opacity="0.8"/>
  </g>

  <!-- Front Golden Sticky Note Card (Tilted Left) -->
  <g transform="translate(190 295) rotate(-9) translate(-110 -100)" filter="url(#dropShadow)">
    <rect x="0" y="0" width="220" height="200" rx="34" fill="url(#stickyCard)" stroke="#fff4b8" stroke-opacity="0.7" stroke-width="4"/>
    <!-- Cute Red Pin -->
    <circle cx="110" cy="28" r="13" fill="#ff3b30"/>
    <circle cx="106" cy="24" r="4.5" fill="#ffb3ad"/>
    <!-- Sticky Note Lines -->
    <rect x="34" y="64" width="152" height="15" rx="7.5" fill="#1d1d1f" fill-opacity="0.82"/>
    <rect x="34" y="96" width="124" height="14" rx="7" fill="#1d1d1f" fill-opacity="0.62"/>
    <rect x="34" y="126" width="138" height="14" rx="7" fill="#1d1d1f" fill-opacity="0.62"/>
  </g>

  <!-- Freeform Bezier Connector Curve & Arrow -->
  <path d="M 118 386 C 145 215, 295 340, 386 126" fill="none" stroke="url(#curveGrad)" stroke-width="22" stroke-linecap="round" filter="url(#dropShadow)"/>
  <!-- Arrowhead at Top-Right -->
  <path d="M 342 134 L 394 114 L 404 168" fill="none" stroke="#00f5d4" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/>
  <!-- Glowing Anchor Node at Bottom-Left -->
  <circle cx="118" cy="386" r="18" fill="#ff2d55" stroke="#ffffff" stroke-width="7"/>
</svg>`;

// ============================================================================
// 2. High-Precision Software Vector/SDF Rasterizer (2x Supersampled RGBA)
// ============================================================================
function clamp(v, lo = 0, hi = 1) {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpColor(c1, c2, t) {
  const k = clamp(t, 0, 1);
  return [
    lerp(c1[0], c2[0], k),
    lerp(c1[1], c2[1], k),
    lerp(c1[2], c2[2], k),
    lerp(c1[3] ?? 255, c2[3] ?? 255, k)
  ];
}

// Signed Distance Function for a rounded box centered at (0,0) with half-size (hx, hy) and corner radius r
function sdRoundedBox(px, py, hx, hy, r) {
  const qx = Math.abs(px) - hx + r;
  const qy = Math.abs(py) - hy + r;
  const outDist = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inDist = Math.min(Math.max(qx, qy), 0);
  return outDist + inDist - r;
}

// Distance from point P to segment AB
function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const c1 = vx * wx + vy * wy;
  const c2 = vx * vx + vy * vy;
  const t = c2 <= 1e-6 ? 0 : clamp(c1 / c2, 0, 1);
  const cx = ax + t * vx;
  const cy = ay + t * vy;
  return { dist: Math.hypot(px - cx, py - cy), t };
}

// Pre-sample cubic bezier curve in 512x512 coordinate space
const BEZIER_SAMPLES = [];
{
  const p0 = [116, 390];
  const p1 = [145, 200];
  const p2 = [305, 345];
  const p3 = [392, 122];
  const N = 80;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const mt = 1 - t;
    const x =
      mt * mt * mt * p0[0] +
      3 * mt * mt * t * p1[0] +
      3 * mt * t * t * p2[0] +
      t * t * t * p3[0];
    const y =
      mt * mt * mt * p0[1] +
      3 * mt * mt * t * p1[1] +
      3 * mt * t * t * p2[1] +
      t * t * t * p3[1];
    BEZIER_SAMPLES.push([x, y, t]);
  }
}

function distToBezier(px, py) {
  let minD = Infinity;
  let bestT = 0;
  for (let i = 0; i < BEZIER_SAMPLES.length - 1; i++) {
    const a = BEZIER_SAMPLES[i];
    const b = BEZIER_SAMPLES[i + 1];
    const { dist, t } = distToSegment(px, py, a[0], a[1], b[0], b[1]);
    if (dist < minD) {
      minD = dist;
      bestT = lerp(a[2], b[2], t);
    }
  }
  return { dist: minD, t: bestT };
}

function blendPremul(dst, srcR, srcG, srcB, srcA) {
  const a = clamp(srcA, 0, 1);
  if (a <= 0.001) return;
  const outA = a + dst[3] * (1 - a);
  if (outA <= 0.0001) return;
  dst[0] = (srcR * a + dst[0] * dst[3] * (1 - a)) / outA;
  dst[1] = (srcG * a + dst[1] * dst[3] * (1 - a)) / outA;
  dst[2] = (srcB * a + dst[2] * dst[3] * (1 - a)) / outA;
  dst[3] = outA;
}

function rotatePoint(px, py, cx, cy, deg) {
  const rad = (-deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = px - cx;
  const dy = py - cy;
  return [dx * cos - dy * sin, dx * sin + dy * cos];
}

// Evaluate icon pixel color at normalized 512x512 coordinates (u, v) with pixel scale `aaWidth`
function sampleIconAt512(u, v, aaWidth) {
  const dst = [0, 0, 0, 0]; // [R, G, B, A(0..1)]

  // 1. Apple Squircle Base (center 256,256, half-size 234, radius 110)
  const dBase = sdRoundedBox(u - 256, v - 256, 234, 234, 110);
  if (dBase < aaWidth * 1.5) {
    const cov = clamp(0.5 - dBase / aaWidth, 0, 1);
    const diagT = clamp((u + v) / 1024, 0, 1);
    // Rich dark midnight gradient (#1a1f35 -> #0c0e18 -> #06070c)
    let bg = lerpColor([26, 31, 53], [8, 10, 18], diagT);

    // Top-right electric blue ambient glow
    const glowDist1 = Math.hypot(u - 370, v - 120) / 340;
    if (glowDist1 < 1) {
      const g1 = Math.pow(1 - glowDist1, 2) * 0.45;
      bg = lerpColor(bg, [41, 151, 255], g1);
    }
    // Bottom-left magenta-violet ambient glow
    const glowDist2 = Math.hypot(u - 140, v - 390) / 340;
    if (glowDist2 < 1) {
      const g2 = Math.pow(1 - glowDist2, 2) * 0.32;
      bg = lerpColor(bg, [191, 90, 242], g2);
    }

    // Subtle canvas dot grid (only on sizes where aaWidth < 8)
    if (aaWidth < 6 && dBase < -24) {
      const gx = ((u - 76) % 60 + 60) % 60 - 30;
      const gy = ((v - 76) % 60 + 60) % 60 - 30;
      const gd = Math.hypot(gx, gy) - 3.5;
      if (gd < aaWidth) {
        const dotCov = clamp(0.5 - gd / aaWidth, 0, 1) * 0.14;
        bg = lerpColor(bg, [255, 255, 255], dotCov);
      }
    }

    // Glass inner rim border
    const rimDist = Math.abs(dBase + 3.5) - 2.5;
    if (rimDist < aaWidth) {
      const rimCov = clamp(0.5 - rimDist / aaWidth, 0, 1) * 0.28;
      bg = lerpColor(bg, [255, 255, 255], rimCov);
    }

    blendPremul(dst, bg[0], bg[1], bg[2], cov);
  } else {
    return [0, 0, 0, 0];
  }

  // 2. Back Card: Electric Apple Blue Card (center 304, 210, tilted +11 deg)
  {
    const [shX, shY] = rotatePoint(u, v - 14, 304, 210, 11);
    const dShadow = sdRoundedBox(shX, shY, 114, 94, 34);
    if (dShadow < 26) {
      const shAlpha = Math.pow(clamp(1 - (dShadow + 10) / 36, 0, 1), 2) * 0.5;
      blendPremul(dst, 0, 0, 0, shAlpha);
    }

    const [lx, ly] = rotatePoint(u, v, 304, 210, 11);
    const dCard = sdRoundedBox(lx, ly, 114, 94, 34);
    if (dCard < aaWidth) {
      const cov = clamp(0.5 - dCard / aaWidth, 0, 1);
      const t = clamp((lx + 114) / 228 * 0.5 + (ly + 94) / 188 * 0.5, 0, 1);
      let c = lerpColor([56, 168, 255], [0, 92, 230], t);

      // White UI lines & green check dot inside blue card
      const dLine1 = sdRoundedBox(lx + 24, ly + 42, 54, 7, 7);
      const dLine2 = sdRoundedBox(lx + 6, ly + 10, 72, 6, 6);
      const dDot = Math.hypot(lx + 62, ly - 32) - 12;
      const dLine3 = sdRoundedBox(lx - 10, ly - 32, 48, 6.5, 6.5);

      if (dLine1 < aaWidth) {
        c = lerpColor(c, [255, 255, 255], clamp(0.5 - dLine1 / aaWidth, 0, 1) * 0.92);
      }
      if (dLine2 < aaWidth) {
        c = lerpColor(c, [255, 255, 255], clamp(0.5 - dLine2 / aaWidth, 0, 1) * 0.58);
      }
      if (dDot < aaWidth) {
        c = lerpColor(c, [48, 209, 88], clamp(0.5 - dDot / aaWidth, 0, 1));
      }
      if (dLine3 < aaWidth) {
        c = lerpColor(c, [255, 255, 255], clamp(0.5 - dLine3 / aaWidth, 0, 1) * 0.82);
      }

      // Highlight border
      const dRim = Math.abs(dCard + 2) - 1.8;
      if (dRim < aaWidth) {
        c = lerpColor(c, [175, 222, 255], clamp(0.5 - dRim / aaWidth, 0, 1) * 0.55);
      }

      blendPremul(dst, c[0], c[1], c[2], cov);
    }
  }

  // 3. Front Card: Warm Golden Sticky Note (center 192, 294, tilted -9 deg)
  {
    const [shX, shY] = rotatePoint(u, v - 16, 192, 294, -9);
    const dShadow = sdRoundedBox(shX, shY, 108, 98, 34);
    if (dShadow < 28) {
      const shAlpha = Math.pow(clamp(1 - (dShadow + 10) / 38, 0, 1), 2) * 0.56;
      blendPremul(dst, 0, 0, 0, shAlpha);
    }

    const [lx, ly] = rotatePoint(u, v, 192, 294, -9);
    const dSticky = sdRoundedBox(lx, ly, 108, 98, 34);
    if (dSticky < aaWidth) {
      const cov = clamp(0.5 - dSticky / aaWidth, 0, 1);
      const t = clamp((lx + 108) / 216 * 0.4 + (ly + 98) / 196 * 0.6, 0, 1);
      let c = lerpColor([255, 232, 105], [255, 159, 10], t);

      // Cute Red Pin at top center of sticky note
      const dPin = Math.hypot(lx, ly + 66) - 14;
      if (dPin < aaWidth) {
        c = lerpColor(c, [255, 59, 48], clamp(0.5 - dPin / aaWidth, 0, 1));
        const dPinHi = Math.hypot(lx - 4, ly + 70) - 4.5;
        if (dPinHi < aaWidth) {
          c = lerpColor(c, [255, 195, 190], clamp(0.5 - dPinHi / aaWidth, 0, 1));
        }
      }

      // Dark text lines on sticky note
      const dL1 = sdRoundedBox(lx, ly + 22, 72, 7.5, 7.5);
      const dL2 = sdRoundedBox(lx + 12, ly - 10, 60, 7, 7);
      const dL3 = sdRoundedBox(lx + 5, ly - 40, 67, 7, 7);
      if (dL1 < aaWidth) {
        c = lerpColor(c, [29, 29, 31], clamp(0.5 - dL1 / aaWidth, 0, 1) * 0.82);
      }
      if (dL2 < aaWidth) {
        c = lerpColor(c, [29, 29, 31], clamp(0.5 - dL2 / aaWidth, 0, 1) * 0.62);
      }
      if (dL3 < aaWidth) {
        c = lerpColor(c, [29, 29, 31], clamp(0.5 - dL3 / aaWidth, 0, 1) * 0.62);
      }

      // Warm highlight rim
      const dRim = Math.abs(dSticky + 2) - 1.8;
      if (dRim < aaWidth) {
        c = lerpColor(c, [255, 248, 200], clamp(0.5 - dRim / aaWidth, 0, 1) * 0.65);
      }

      blendPremul(dst, c[0], c[1], c[2], cov);
    }
  }

  // 4. Dynamic Freeform Bezier Connector Curve + Arrowhead + Glowing Node
  {
    const { dist: bDist, t: bT } = distToBezier(u, v);
    // Arrowhead segments near (392, 122)
    const a1 = distToSegment(u, v, 342, 134, 395, 115).dist;
    const a2 = distToSegment(u, v, 395, 115, 405, 170).dist;
    const arrowDist = Math.min(a1, a2);
    const strokeRadius = 12.5;
    const combinedDist = Math.min(bDist - strokeRadius, arrowDist - 11.5);

    // Drop shadow under curve
    const { dist: bShDist } = distToBezier(u, v - 10);
    if (bShDist < 24) {
      const shA = Math.pow(clamp(1 - bShDist / 24, 0, 1), 2) * 0.45;
      blendPremul(dst, 0, 0, 0, shA);
    }

    if (combinedDist < aaWidth) {
      const cov = clamp(0.5 - combinedDist / aaWidth, 0, 1);
      // Gradient along curve: Coral Pink (#ff2d55) -> Electric Purple (#bf5af2) -> Mint Cyan (#00f5d4)
      let c;
      const gradT = arrowDist - 11.5 < bDist - strokeRadius ? 1 : bT;
      if (gradT < 0.5) {
        c = lerpColor([255, 45, 85], [191, 90, 242], gradT * 2);
      } else {
        c = lerpColor([191, 90, 242], [0, 245, 212], (gradT - 0.5) * 2);
      }
      blendPremul(dst, c[0], c[1], c[2], cov);
    }

    // Bottom-left connector anchor node at (116, 390)
    const nodeDist = Math.hypot(u - 116, v - 390);
    const dOuterRing = nodeDist - 21;
    if (dOuterRing < aaWidth) {
      const cov = clamp(0.5 - dOuterRing / aaWidth, 0, 1);
      const dInner = nodeDist - 13.5;
      const innerCov = clamp(0.5 - dInner / aaWidth, 0, 1);
      const c = lerpColor([255, 255, 255], [255, 45, 85], innerCov);
      blendPremul(dst, c[0], c[1], c[2], cov);
    }
  }

  return [
    Math.round(clamp(dst[0], 0, 255)),
    Math.round(clamp(dst[1], 0, 255)),
    Math.round(clamp(dst[2], 0, 255)),
    Math.round(clamp(dst[3] * 255, 0, 255))
  ];
}

function renderIconRGBA(size) {
  const buf = Buffer.alloc(size * size * 4);
  const scale = 512 / size;
  // 2x2 supersampling for crisp edges at all resolutions (16..512)
  const subOffsets = [-0.25, 0.25];
  const aaWidth = Math.max(1.1, scale * 0.85);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rSum = 0,
        gSum = 0,
        bSum = 0,
        aSum = 0;
      for (const oy of subOffsets) {
        for (const ox of subOffsets) {
          const u = (x + 0.5 + ox) * scale;
          const v = (y + 0.5 + oy) * scale;
          const [r, g, b, a] = sampleIconAt512(u, v, aaWidth);
          const alpha = a / 255;
          rSum += r * alpha;
          gSum += g * alpha;
          bSum += b * alpha;
          aSum += alpha;
        }
      }
      const idx = (y * size + x) * 4;
      const avgA = aSum / 4;
      if (avgA <= 0.001) {
        buf[idx] = 0;
        buf[idx + 1] = 0;
        buf[idx + 2] = 0;
        buf[idx + 3] = 0;
      } else {
        buf[idx] = Math.round(clamp(rSum / 4 / avgA, 0, 255));
        buf[idx + 1] = Math.round(clamp(gSum / 4 / avgA, 0, 255));
        buf[idx + 2] = Math.round(clamp(bSum / 4 / avgA, 0, 255));
        buf[idx + 3] = Math.round(clamp(avgA * 255, 0, 255));
      }
    }
  }
  return buf;
}

// ============================================================================
// 3. Minimal PNG Encoder & Multi-Resolution ICO Encoder (Pure Node.js)
// ============================================================================
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type, data) {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgbaBuf) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const rawData = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    rawData[y * (stride + 1)] = 0; // filter type 0 (None)
    rgbaBuf.copy(rawData, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const compressed = zlib.deflateSync(rawData, { level: 9 });

  return Buffer.concat([
    signature,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', compressed),
    makePngChunk('IEND', Buffer.alloc(0))
  ]);
}

function encodeICO(pngEntries) {
  const count = pngEntries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // Reserved
  header.writeUInt16LE(1, 2); // Type 1 = ICO
  header.writeUInt16LE(count, 4);

  const dirEntries = [];
  const dataChunks = [];
  let offset = 6 + count * 16;

  for (const { size, pngBuf } of pngEntries) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // width
    entry[1] = size >= 256 ? 0 : size; // height
    entry[2] = 0; // palette
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(pngBuf.length, 8);
    entry.writeUInt32LE(offset, 12);
    dirEntries.push(entry);
    dataChunks.push(pngBuf);
    offset += pngBuf.length;
  }

  return Buffer.concat([header, ...dirEntries, ...dataChunks]);
}

// Generate all required sizes
console.log('🎨 Generating FreeformDrive custom icons...');
fs.writeFileSync(path.join(ASSETS_DIR, 'icon.svg'), ICON_SVG, 'utf8');

const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const pngEntries = icoSizes.map((size) => {
  const rgba = renderIconRGBA(size);
  const pngBuf = encodePNG(size, size, rgba);
  return { size, pngBuf };
});

const icoBuf = encodeICO(pngEntries);
fs.writeFileSync(path.join(ASSETS_DIR, 'icon.ico'), icoBuf);

// Save 256x256 PNG as assets/icon.png for BrowserWindow / Tray / Docs
const png256 = pngEntries.find((e) => e.size === 256).pngBuf;
fs.writeFileSync(path.join(ASSETS_DIR, 'icon.png'), png256);

console.log('[✓] Saved assets/icon.svg, assets/icon.png (256x256), and assets/icon.ico (16~256 multi-res)');
