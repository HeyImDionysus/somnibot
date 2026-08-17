import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LAVALINK_VERSION,
  LAVALINK_YOUTUBE_PLUGIN_VERSION,
} from '../main/lavalink-version';

const DAVE_CAPABLE_LAVALINK_VERSION = '4.2.2';
const DAVE_CAPABLE_LAVALINK_IMAGE =
  `ghcr.io/lavalink-devs/lavalink:${DAVE_CAPABLE_LAVALINK_VERSION}`;

describe('Lavalink runtime policy', () => {
  it('pins every Compose runtime to the DAVE-capable Lavalink release', () => {
    // Given the Compose files used by local and production deployments.
    const composeFiles = [
      new URL('../../../../docker-compose.yml', import.meta.url),
      new URL('../../../../docker-compose.prod.yml', import.meta.url),
    ];

    // When each runtime configuration is inspected.
    const composeSources = composeFiles.map(file => readFileSync(file, 'utf8'));

    // Then every Lavalink service uses the release that supports Discord DAVE voice sessions.
    expect(LAVALINK_VERSION).toBe(DAVE_CAPABLE_LAVALINK_VERSION);
    for (const source of composeSources) {
      expect(source).toContain(`image: ${DAVE_CAPABLE_LAVALINK_IMAGE}`);
    }
  });

  it('pins Compose playback to the supported external YouTube source', () => {
    // Given the Lavalink configuration shared by local and production Compose.
    const source = readFileSync(
      new URL('../../../../services/lavalink/application.yml', import.meta.url),
      'utf8',
    );

    // When its source policy is inspected, then it uses the supported plugin and clients.
    expect(LAVALINK_YOUTUBE_PLUGIN_VERSION).toBe('1.18.2');
    expect(source).toContain(`youtube-plugin:${LAVALINK_YOUTUBE_PLUGIN_VERSION}`);
    expect(source).toContain('      youtube: false');
    expect(source).toContain('      http: false');
    expect(source).not.toContain('TVHTML5EMBEDDED');
  });
});
