import { describe, expect, it, vi } from 'vitest';
import { observeRecoveryRuntime } from '../main/database-recovery-runtime.js';

const query = { tool: 'psql' as const, args: ['--command', 'identity SQL'], env: {} };
const runtime = { lifecycle: 'ready', version: '1.0.0', exactSha: 'a'.repeat(40), bootId: '11111111-1111-4111-8111-111111111111', migrationHead: '20260831135000_test.sql', configurationGeneration: 3, deploymentProfile: 'vps-single-guild' };

describe('recovery runtime observation', () => {
  it('preserves unknown when the source has no matching observed runtime', async () => {
    // Given a query returning no current boot/health join.
    const run = vi.fn(async () => 'null');
    // When the runtime observation is read.
    const result = await observeRecoveryRuntime(query, '123456789012345678', run);
    // Then no packaged or guessed identity substitutes for it.
    expect(result).toBeNull();
  });

  it('parses only the shared runtime contract and strips unrelated payload fields', async () => {
    // Given a real contract-shaped observation plus extraneous source content.
    const run = vi.fn(async () => JSON.stringify({ ...runtime, secret: 'untrusted-extra' }));
    // When the observation crosses the client boundary.
    const result = await observeRecoveryRuntime(query, '123456789012345678', run);
    // Then only shared runtime identity survives.
    expect(result).toEqual(runtime);
  });

  it('rejects malformed runtime metadata rather than minting proof', async () => {
    // Given a source row with a claimed non-SHA deployment identity.
    const run = vi.fn(async () => JSON.stringify({ ...runtime, exactSha: 'not-a-sha' }));
    // When the observation is parsed.
    // Then it is a refusal, not verified deployed provenance.
    await expect(observeRecoveryRuntime(query, '123456789012345678', run)).rejects.toMatchObject({ code: 'runtime-identity-invalid' });
  });
});
