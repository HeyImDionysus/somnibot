'use client';

import Image from 'next/image';

export interface DiscordEmbedPreviewField {
  name: string;
  value: string;
  inline: boolean;
}

export interface DiscordEmbedPreviewData {
  title?: string | null;
  description?: string | null;
  color?: number | string | null;
  fields?: DiscordEmbedPreviewField[] | null;
  imageUrl?: string | null;
  thumbnailUrl?: string | null;
  footerText?: string | null;
  authorName?: string | null;
  authorIconUrl?: string | null;
  includeTimestamp?: boolean;
}

function previewColor(color: DiscordEmbedPreviewData['color'], fallback: string): string {
  if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) return color;
  if (typeof color === 'number' && Number.isInteger(color) && color >= 0 && color <= 0xffffff) {
    return `#${color.toString(16).padStart(6, '0')}`;
  }
  return fallback;
}

export function DiscordEmbedPreview({
  embed,
  fallbackColor = '#5865f2',
  footerSuffix,
  emptyMessage = 'This embed has no visible content yet.',
}: {
  embed: DiscordEmbedPreviewData;
  fallbackColor?: string;
  footerSuffix?: string | null;
  emptyMessage?: string;
}) {
  const fields = embed.fields ?? [];
  const hasContent = Boolean(
    embed.authorName ||
    embed.title ||
    embed.description ||
    fields.length ||
    embed.imageUrl ||
    embed.thumbnailUrl ||
    embed.footerText ||
    footerSuffix,
  );
  const footerParts = [embed.footerText, footerSuffix].filter(Boolean) as string[];

  return (
    <div
      className="overflow-hidden rounded-input"
      style={{ borderLeft: `4px solid ${previewColor(embed.color, fallbackColor)}` }}
      data-testid="discord-embed-preview"
    >
      <div className="relative bg-discord-bg-floating p-4">
        {embed.authorName && (
          <div className="mb-2 flex items-center gap-2">
            {embed.authorIconUrl && (
              <Image
                src={embed.authorIconUrl}
                alt=""
                width={24}
                height={24}
                unoptimized
                className="h-6 w-6 rounded-full"
                onError={(event) => {
                  event.currentTarget.style.display = 'none';
                }}
              />
            )}
            <span className="text-xs font-medium text-discord-text-primary">{embed.authorName}</span>
          </div>
        )}

        {embed.title && (
          <p className="mb-1 text-base font-semibold text-discord-accent">{embed.title}</p>
        )}

        {embed.description && (
          <p className="mb-2 whitespace-pre-wrap text-sm text-discord-text-secondary">
            {embed.description}
          </p>
        )}

        {fields.length > 0 && (
          <div className="mt-2 grid grid-cols-3 gap-2">
            {fields.map((field, index) => (
              <div key={`${field.name}-${index}`} className={field.inline ? 'col-span-1' : 'col-span-3'}>
                <p className="text-xs font-semibold text-discord-text-primary">{field.name || '\u200b'}</p>
                <p className="whitespace-pre-wrap text-sm text-discord-text-secondary">
                  {field.value || '\u200b'}
                </p>
              </div>
            ))}
          </div>
        )}

        {embed.imageUrl && (
          <Image
            src={embed.imageUrl}
            alt=""
            width={500}
            height={300}
            unoptimized
            className="mt-3 h-auto max-w-full rounded"
            onError={(event) => {
              event.currentTarget.style.display = 'none';
            }}
          />
        )}

        {(footerParts.length > 0 || embed.includeTimestamp) && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-discord-text-muted">
            {footerParts.map((part, index) => (
              <span key={`${part}-${index}`} className="contents">
                {(index > 0 || embed.includeTimestamp) && index > 0 && <span>•</span>}
                <span>{part}</span>
              </span>
            ))}
            {footerParts.length > 0 && embed.includeTimestamp && <span>•</span>}
            {embed.includeTimestamp && <span>{new Date().toLocaleDateString()}</span>}
          </div>
        )}

        {embed.thumbnailUrl && (
          <div className="absolute right-4 top-4">
            <Image
              src={embed.thumbnailUrl}
              alt=""
              width={64}
              height={64}
              unoptimized
              className="h-16 w-16 rounded"
              onError={(event) => {
                event.currentTarget.style.display = 'none';
              }}
            />
          </div>
        )}

        {!hasContent && (
          <p className="text-sm text-discord-text-muted">{emptyMessage}</p>
        )}
      </div>
    </div>
  );
}
