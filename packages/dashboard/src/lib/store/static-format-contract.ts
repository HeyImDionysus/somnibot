export type StaticFormatFamily = 'pdf' | 'raster' | 'svg' | 'text';

export type StaticFormatAdapter = {
  readonly family: StaticFormatFamily;
  readonly label: string;
  readonly mimeTypes: readonly string[];
  readonly extensions: readonly string[];
};

export const STATIC_FORMAT_ADAPTERS: readonly StaticFormatAdapter[] = [
  {
    family: 'pdf',
    label: 'PDF',
    mimeTypes: ['application/pdf'],
    extensions: ['pdf'],
  },
  {
    family: 'raster',
    label: 'PNG',
    mimeTypes: ['image/png'],
    extensions: ['png'],
  },
  {
    family: 'raster',
    label: 'JPEG',
    mimeTypes: ['image/jpeg'],
    extensions: ['jpeg', 'jpg'],
  },
  {
    family: 'raster',
    label: 'WebP',
    mimeTypes: ['image/webp'],
    extensions: ['webp'],
  },
  {
    family: 'svg',
    label: 'SVG',
    mimeTypes: ['image/svg+xml'],
    extensions: ['svg'],
  },
  {
    family: 'text',
    label: 'HTML',
    mimeTypes: ['text/html'],
    extensions: ['htm', 'html'],
  },
  {
    family: 'text',
    label: 'CSS',
    mimeTypes: ['text/css'],
    extensions: ['css'],
  },
  {
    family: 'text',
    label: 'Markdown',
    mimeTypes: ['text/markdown'],
    extensions: ['markdown', 'md'],
  },
  {
    family: 'text',
    label: 'plain text',
    mimeTypes: ['text/plain'],
    extensions: ['txt'],
  },
] as const;

export const STATIC_FORMAT_SUMMARY = STATIC_FORMAT_ADAPTERS
  .map((adapter) => adapter.label)
  .join(', ');

function normalizedMime(mimeType: string | null | undefined): string | null {
  const normalized = mimeType?.split(';', 1)[0]?.trim().toLowerCase();
  return normalized && normalized !== 'application/octet-stream' ? normalized : null;
}

function extensionOf(fileName: string): string | null {
  const normalized = fileName.trim().toLowerCase();
  const separator = normalized.lastIndexOf('.');
  return separator >= 0 && separator < normalized.length - 1
    ? normalized.slice(separator + 1)
    : null;
}

export function resolveStaticFormat(
  mimeType: string | null | undefined,
  fileName: string,
): StaticFormatAdapter | null {
  const mime = normalizedMime(mimeType);
  if (mime) {
    const byMime = STATIC_FORMAT_ADAPTERS.find((adapter) => adapter.mimeTypes.includes(mime));
    if (byMime) return byMime;
  }
  const extension = extensionOf(fileName);
  return extension
    ? STATIC_FORMAT_ADAPTERS.find((adapter) => adapter.extensions.includes(extension)) ?? null
    : null;
}
