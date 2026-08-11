import { describe, expect, it } from 'vitest';
import { lavalinkHealthFromDiagnostics } from '@/lib/lavalink-health';

describe('lavalinkHealthFromDiagnostics', () => {
  it('returns connected when at least one diagnostics node is connected', () => {
    // Given: a diagnostics response with one connected and one disconnected node.
    const diagnostics = {
      success: true,
      data: { lavalink: { nodes: [{ connected: false }, { connected: true }] } },
    };

    // When: the Music page derives the Lavalink health.
    const health = lavalinkHealthFromDiagnostics(diagnostics);

    // Then: it reports a connected node rather than the disconnected sibling.
    expect(health).toEqual({ state: 'connected' });
  });

  it('returns disconnected when configured diagnostics nodes are all disconnected', () => {
    // Given: configured nodes, none of which are connected.
    const diagnostics = {
      success: true,
      data: { lavalink: { nodes: [{ connected: false }] } },
    };

    // When: the Music page derives the Lavalink health.
    const health = lavalinkHealthFromDiagnostics(diagnostics);

    // Then: it does not present the configured node as connected.
    expect(health).toEqual({ state: 'disconnected' });
  });

  it('returns unavailable when diagnostics reports no configured nodes', () => {
    // Given: a successful diagnostics response without Lavalink nodes.
    const diagnostics = { success: true, data: { lavalink: { nodes: [] } } };

    // When: the Music page derives the Lavalink health.
    const health = lavalinkHealthFromDiagnostics(diagnostics);

    // Then: it reports that no node is available.
    expect(health).toEqual({ state: 'unavailable' });
  });

  it('returns unknown when diagnostics is unsuccessful or malformed', () => {
    // Given: diagnostics did not provide a successful node payload.
    const diagnostics = { success: false };

    // When: the Music page derives the Lavalink health.
    const health = lavalinkHealthFromDiagnostics(diagnostics);

    // Then: it does not infer a connection state.
    expect(health).toEqual({ state: 'unknown' });
  });
});
