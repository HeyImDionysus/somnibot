import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  createStaticDelivery,
  isSupportedStaticFile,
  verifyStaticManifest,
} from '@/lib/store/static-delivery';
import { resolveStaticFormat, STATIC_FORMAT_ADAPTERS } from '@/lib/store/static-format-contract';

const SECRET = 'static-delivery-test-secret-is-at-least-32-characters';
const PRODUCT_ID = '00000000-0000-4000-8000-000000000123';
const ENTITLEMENT_ID = '00000000-0000-4000-8000-000000000456';

function input(
  bytes: Uint8Array,
  mimeType: string,
  fileName: string,
  customerId = '00000000-0000-4000-8000-000000000789',
) {
  return {
    bytes,
    mimeType,
    fileName,
    productId: PRODUCT_ID,
    entitlementId: ENTITLEMENT_ID,
    customerId,
    secret: SECRET,
  };
}

async function pageContentOnly(source: Uint8Array): Promise<Uint8Array> {
  const sourceDocument = await PDFDocument.load(source);
  const extracted = await PDFDocument.create();
  const [page] = await extracted.copyPages(sourceDocument, [0]);
  extracted.addPage(page);
  return extracted.save({ useObjectStreams: false });
}

async function attackedRaster(source: Uint8Array): Promise<Buffer> {
  const cover = Buffer.from(
    '<svg width="190" height="125"><rect width="190" height="125" fill="#2a5882"/></svg>',
  );
  return sharp(source)
    .composite([{ input: cover, left: 450, top: 235, blend: 'over' }])
    .extract({ left: 40, top: 20, width: 560, height: 300 })
    .resize(280, 150)
    .jpeg({ quality: 45 })
    .toBuffer();
}

async function meanPixelDifference(first: Uint8Array, second: Uint8Array): Promise<number> {
  const left = await sharp(first).removeAlpha().raw().toBuffer();
  const right = await sharp(second).removeAlpha().raw().toBuffer();
  expect(left.byteLength).toBe(right.byteLength);
  let total = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    total += Math.abs(left[index] - right[index]);
  }
  return total / left.byteLength;
}

describe('static delivery', () => {
  it('supports the bounded static format contract and rejects arbitrary binaries', () => {
    expect(STATIC_FORMAT_ADAPTERS.map((adapter) => adapter.family)).toEqual([
      'pdf', 'raster', 'raster', 'raster', 'svg', 'text', 'text', 'text', 'text',
    ]);
    expect(isSupportedStaticFile('application/pdf', 'guide.pdf')).toBe(true);
    expect(isSupportedStaticFile('application/octet-stream', 'theme.css')).toBe(true);
    expect(isSupportedStaticFile('image/png', 'art.png')).toBe(true);
    expect(resolveStaticFormat('application/octet-stream', 'art.webp')?.family).toBe('raster');
    expect(isSupportedStaticFile('application/zip', 'bundle.zip')).toBe(false);
    expect(isSupportedStaticFile('application/octet-stream', 'plugin.dll')).toBe(false);
  });

  it('creates buyer-distinct text derivatives without embedding raw customer IDs', async () => {
    const master = new TextEncoder().encode('<html><body><h1>Safe fixture</h1></body></html>');
    const first = await createStaticDelivery(input(master, 'text/html', 'index.html'));
    const second = await createStaticDelivery(input(
      master,
      'text/html',
      'index.html',
      '00000000-0000-4000-8000-000000000999',
    ));
    const firstText = new TextDecoder().decode(first.bytes);

    expect(first.manifest.fingerprint).not.toBe(second.manifest.fingerprint);
    expect(first.manifest.derivativeSha256).not.toBe(second.manifest.derivativeSha256);
    expect(firstText).toContain(first.manifest.fingerprint);
    expect(firstText).toContain('SomniBot licensed copy');
    expect(firstText).not.toContain('00000000-0000-4000-8000-000000000789');
  });

  it('retains independent HTML and SVG signals after metadata or comment stripping', async () => {
    const html = await createStaticDelivery(input(
      new TextEncoder().encode('<html><body><main>Fixture</main></body></html>'),
      'text/html',
      'fixture.html',
    ));
    const htmlWithoutComments = new TextDecoder()
      .decode(html.bytes)
      .replace(/<!--.*?-->/gs, '')
      .replace(/ data-somnibot-license="[^"]+"/g, '');
    expect(htmlWithoutComments).toContain(html.manifest.fingerprint);

    const svg = await createStaticDelivery(input(
      new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100"/></svg>'),
      'image/svg+xml',
      'fixture.svg',
    ));
    const svgWithoutMetadata = new TextDecoder()
      .decode(svg.bytes)
      .replace(/<metadata>.*?<\/metadata>/gs, '')
      .replace(/ aria-label="[^"]+"/g, '');
    expect(svgWithoutMetadata.match(new RegExp(svg.manifest.fingerprint, 'g'))).toHaveLength(4);
  });

  it('signs manifests and rejects tampered manifests or signatures', async () => {
    const delivery = await createStaticDelivery(input(
      new TextEncoder().encode('Harmless static fixture'),
      'text/plain',
      'fixture.txt',
    ));

    expect(verifyStaticManifest(
      delivery.manifestBase64Url,
      delivery.signature,
      SECRET,
    )).toEqual(delivery.manifest);
    expect(verifyStaticManifest(
      `${delivery.manifestBase64Url}a`,
      delivery.signature,
      SECRET,
    )).toBeNull();
    expect(verifyStaticManifest(
      delivery.manifestBase64Url,
      `${delivery.signature}a`,
      SECRET,
    )).toBeNull();
  });

  it('embeds repeated and metadata-backed marks in a generated PNG fixture', async () => {
    const master = await sharp({
      create: {
        width: 640,
        height: 360,
        channels: 4,
        background: { r: 42, g: 88, b: 130, alpha: 1 },
      },
    }).png().toBuffer();
    const delivery = await createStaticDelivery(input(master, 'image/png', 'fixture.png'));
    const metadata = await sharp(delivery.bytes).metadata();

    expect(delivery.bytes).not.toEqual(master);
    expect(delivery.manifest.verificationHints).toContain('repeated-low-salience-mark');
    expect(metadata.width).toBe(640);
    expect(metadata.height).toBe(360);
    expect(metadata.exif).toBeDefined();
  });

  it('retains distributed image evidence after crop, recompression, metadata removal, and one-region overwrite', async () => {
    const master = await sharp({
      create: {
        width: 640,
        height: 360,
        channels: 4,
        background: { r: 42, g: 88, b: 130, alpha: 1 },
      },
    }).png().toBuffer();
    const delivery = await createStaticDelivery(input(master, 'image/png', 'fixture.png'));
    const attackedMaster = await attackedRaster(master);
    const attackedDerivative = await attackedRaster(delivery.bytes);

    expect((await sharp(attackedDerivative).metadata()).exif).toBeUndefined();
    expect(await meanPixelDifference(attackedMaster, attackedDerivative)).toBeGreaterThan(0.5);
  });

  it('embeds page and document marks in a generated PDF fixture', async () => {
    const masterDocument = await PDFDocument.create();
    masterDocument.addPage([612, 792]);
    const master = await masterDocument.save();
    const delivery = await createStaticDelivery(input(master, 'application/pdf', 'fixture.pdf'));
    const derivative = await PDFDocument.load(delivery.bytes);

    expect(derivative.getPageCount()).toBe(1);
    expect(derivative.getSubject()).toContain(delivery.manifest.fingerprint);
    expect(derivative.getKeywords()).toContain(delivery.manifest.fingerprint);

    const extractedMasterPage = await pageContentOnly(master);
    const extractedDerivativePage = await pageContentOnly(delivery.bytes);
    expect(extractedDerivativePage).not.toEqual(extractedMasterPage);
  });

  it('fails closed for unsupported masters and unavailable secrets', async () => {
    await expect(createStaticDelivery(input(
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      'application/zip',
      'fixture.zip',
    ))).rejects.toThrow('Unsupported static format');
    await expect(createStaticDelivery({
      ...input(new TextEncoder().encode('fixture'), 'text/plain', 'fixture.txt'),
      secret: 'short',
    })).rejects.toThrow('Static delivery secret is unavailable');
  });
});
