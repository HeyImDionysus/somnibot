import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import sharp from 'sharp';
import { resolveStaticFormat } from '@/lib/store/static-format-contract';
export const MAX_STATIC_SOURCE_BYTES = 25 * 1024 * 1024;
type StaticManifest = {
  readonly version: 'somnibot-static-v1';
  readonly algorithm: 'hmac-sha256';
  readonly productId: string;
  readonly entitlementRef: string;
  readonly masterSha256: string;
  readonly derivativeSha256: string;
  readonly fingerprint: string;
  readonly mimeType: string;
  readonly verificationHints: readonly string[];
};
export type StaticDeliveryResult = {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly manifest: StaticManifest;
  readonly manifestBase64Url: string;
  readonly signature: string;
};

type StaticDeliveryInput = {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly mimeType: string | null | undefined;
  readonly productId: string;
  readonly entitlementId: string;
  readonly customerId: string;
  readonly secret: string;
};

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isSupportedStaticFile(
  mimeType: string | null | undefined,
  fileName: string,
): boolean {
  return resolveStaticFormat(mimeType, fileName) !== null;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function watermarkText(source: Uint8Array, mimeType: string, fingerprint: string): Uint8Array {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(source);
  const mark = `SomniBot licensed copy ${fingerprint}`;
  let watermarked: string;

  if (mimeType === 'text/html') {
    const visible = `<footer data-somnibot-license="${fingerprint}" style="font:10px/1.4 sans-serif;opacity:.55;text-align:center;padding:8px">${mark}</footer>`;
    const payload = `<!-- ${mark} -->\n${visible}`;
    watermarked = /<\/body\s*>/i.test(text)
      ? text.replace(/<\/body\s*>/i, `${payload}\n</body>`)
      : `${text}\n${payload}\n`;
  } else if (mimeType === 'text/css') {
    watermarked = `/* ${mark} */\n:root{--somnibot-license-mark:"${fingerprint}"}\n${text}\n/* ${mark} */\n`;
  } else {
    watermarked = `${text.replace(/\s*$/, '')}\n\n[${mark}]\n`;
  }

  return new TextEncoder().encode(watermarked);
}

function watermarkSvg(source: Uint8Array, fingerprint: string): Uint8Array {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(source);
  if (!/<svg(?:\s|>)/i.test(text) || !/<\/svg\s*>/i.test(text)) {
    throw new Error('Invalid SVG master');
  }
  const safe = escapeXml(fingerprint);
  const overlay = `<metadata>SomniBot licensed copy ${safe}</metadata><g aria-label="SomniBot licensed copy ${safe}" fill="#111" fill-opacity="0.09" font-family="sans-serif" font-size="12"><text x="4%" y="12%">${safe}</text><text x="38%" y="48%" transform="rotate(-24)">${safe}</text><text x="68%" y="82%">${safe}</text></g><text x="98%" y="98%" text-anchor="end" fill="#111" fill-opacity="0.55" font-family="sans-serif" font-size="9">${safe}</text>`;
  return new TextEncoder().encode(text.replace(/<\/svg\s*>/i, `${overlay}</svg>`));
}

async function watermarkPdf(source: Uint8Array, fingerprint: string): Promise<Uint8Array> {
  const document = await PDFDocument.load(source, { updateMetadata: false });
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const page of document.getPages()) {
    const { width, height } = page.getSize();
    const fontSize = Math.max(7, Math.min(11, width / 80));
    for (let y = height * 0.18; y < height; y += height * 0.28) {
      for (let x = -width * 0.08; x < width; x += width * 0.42) {
        page.drawText(fingerprint, {
          x,
          y,
          font,
          size: fontSize,
          color: rgb(0.2, 0.2, 0.2),
          opacity: 0.08,
          rotate: degrees(28),
        });
      }
    }
    page.drawText(`Licensed copy ${fingerprint}`, {
      x: 12,
      y: 8,
      font,
      size: Math.max(6, fontSize - 2),
      color: rgb(0.15, 0.15, 0.15),
      opacity: 0.6,
    });
  }
  document.setProducer('SomniBot static delivery');
  document.setSubject(`Licensed copy ${fingerprint}`);
  document.setKeywords(['SomniBot', 'licensed-copy', fingerprint]);
  return document.save({ useObjectStreams: false, addDefaultPage: false });
}

function rasterOverlay(width: number, height: number, fingerprint: string): Buffer {
  const fontSize = Math.max(12, Math.min(28, Math.round(Math.min(width, height) / 28)));
  const safe = escapeXml(fingerprint);
  const marks: string[] = [];
  const xStep = Math.max(140, Math.round(width / 4));
  const yStep = Math.max(90, Math.round(height / 4));
  for (let y = Math.round(yStep / 2); y < height; y += yStep) {
    for (let x = -Math.round(xStep / 3); x < width; x += xStep) {
      marks.push(`<text x="${x}" y="${y}" transform="rotate(-24 ${x} ${y})">${safe}</text>`);
    }
  }
  return Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><g fill="white" fill-opacity="0.16" stroke="black" stroke-opacity="0.1" stroke-width="0.5" font-family="sans-serif" font-size="${fontSize}">${marks.join('')}</g><text x="${width - 12}" y="${height - 12}" text-anchor="end" fill="white" fill-opacity="0.68" stroke="black" stroke-opacity="0.45" stroke-width="0.7" font-family="sans-serif" font-size="${Math.max(10, fontSize - 3)}">Licensed ${safe}</text></svg>`);
}

async function watermarkRaster(
  source: Uint8Array,
  mimeType: string,
  fingerprint: string,
): Promise<Uint8Array> {
  const image = sharp(source, { failOn: 'error', limitInputPixels: 100_000_000 });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) throw new Error('Image dimensions unavailable');
  const composed = image
    .composite([{ input: rasterOverlay(metadata.width, metadata.height, fingerprint), blend: 'over' }])
    .withMetadata({
      exif: {
        IFD0: {
          Copyright: `SomniBot licensed copy ${fingerprint}`,
          ImageDescription: `SomniBot licensed copy ${fingerprint}`,
        },
      },
    });
  if (mimeType === 'image/jpeg') return composed.jpeg({ quality: 92 }).toBuffer();
  if (mimeType === 'image/png') return composed.png({ compressionLevel: 9 }).toBuffer();
  return composed.webp({ quality: 92 }).toBuffer();
}

function stableManifestJson(manifest: StaticManifest): string {
  return JSON.stringify(manifest);
}

export function verifyStaticManifest(
  manifestBase64Url: string,
  signature: string,
  secret: string,
): StaticManifest | null {
  try {
    const serialized = Buffer.from(manifestBase64Url, 'base64url').toString('utf8');
    const expected = createHmac('sha256', secret)
      .update('somnibot-static-manifest-v1\0')
      .update(serialized)
      .digest();
    const received = Buffer.from(signature, 'base64url');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
    const parsed: unknown = JSON.parse(serialized);
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as Partial<StaticManifest>;
    if (
      candidate.version !== 'somnibot-static-v1'
      || candidate.algorithm !== 'hmac-sha256'
      || typeof candidate.productId !== 'string'
      || typeof candidate.entitlementRef !== 'string'
      || typeof candidate.masterSha256 !== 'string'
      || typeof candidate.derivativeSha256 !== 'string'
      || typeof candidate.fingerprint !== 'string'
      || typeof candidate.mimeType !== 'string'
      || !Array.isArray(candidate.verificationHints)
    ) return null;
    return candidate as StaticManifest;
  } catch {
    return null;
  }
}

export async function createStaticDelivery(input: StaticDeliveryInput): Promise<StaticDeliveryResult> {
  if (input.bytes.byteLength === 0) throw new Error('Static master is empty');
  if (input.bytes.byteLength > MAX_STATIC_SOURCE_BYTES) {
    throw new Error(`Static master exceeds ${MAX_STATIC_SOURCE_BYTES} bytes`);
  }
  if (input.secret.trim().length < 32) throw new Error('Static delivery secret is unavailable');

  const adapter = resolveStaticFormat(input.mimeType, input.fileName);
  if (!adapter) throw new Error(`Unsupported static format: ${input.mimeType ?? input.fileName}`);
  const mimeType = adapter.mimeTypes[0];
  const masterSha256 = sha256(input.bytes);
  const fingerprint = createHmac('sha256', input.secret)
    .update('somnibot-static-fingerprint-v1\0')
    .update(input.productId)
    .update('\0')
    .update(input.entitlementId)
    .update('\0')
    .update(input.customerId)
    .update('\0')
    .update(masterSha256)
    .digest('hex')
    .slice(0, 24);

  let bytes: Uint8Array;
  if (adapter.family === 'pdf') {
    bytes = await watermarkPdf(input.bytes, fingerprint);
  } else if (adapter.family === 'svg') {
    bytes = watermarkSvg(input.bytes, fingerprint);
  } else if (adapter.family === 'raster') {
    bytes = await watermarkRaster(input.bytes, mimeType, fingerprint);
  } else {
    bytes = watermarkText(input.bytes, mimeType, fingerprint);
  }

  const manifest: StaticManifest = {
    version: 'somnibot-static-v1',
    algorithm: 'hmac-sha256',
    productId: input.productId,
    entitlementRef: input.entitlementId,
    masterSha256,
    derivativeSha256: sha256(bytes),
    fingerprint,
    mimeType,
    verificationHints: [
      'visible-content-mark',
      'repeated-low-salience-mark',
      'format-metadata-where-supported',
    ],
  };
  const serialized = stableManifestJson(manifest);
  const manifestBase64Url = Buffer.from(serialized).toString('base64url');
  const signature = createHmac('sha256', input.secret)
    .update('somnibot-static-manifest-v1\0')
    .update(serialized)
    .digest('base64url');

  return { bytes, mimeType, manifest, manifestBase64Url, signature };
}
