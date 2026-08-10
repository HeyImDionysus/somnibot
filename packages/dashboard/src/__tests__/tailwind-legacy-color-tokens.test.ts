import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourceFiles = (directory: string): readonly string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = resolve(directory, entry.name);
  if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path);
  return /\.tsx?$/.test(entry.name) ? [path] : [];
});

const legacyColorUtility = /(?:[a-z-]+:)*(?:bg-discord-(?:primary|secondary|tertiary)|[a-z-]+-discord-blurple|[a-z-]+-brand-primary(?:-hover)?)(?:\/[\w.-]+)?/g;

describe('dashboard Tailwind color tokens', () => {
  it('does not retain undefined legacy palette utilities', () => {
    const legacyTokens = sourceFiles(sourceRoot).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(legacyColorUtility)].map(([token]) => `${file}: ${token}`),
    );

    expect(legacyTokens).toEqual([]);
  });
});
