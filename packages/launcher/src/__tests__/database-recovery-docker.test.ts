import { describe, expect, it, vi } from 'vitest';
import { dumpRecoveryArtifact, prepareRecoveryImage } from '../main/database-recovery-docker.js';
import type { RecoveryCommand } from '../main/database-recovery-contract.js';
import type { RecoveryResources } from '../main/database-recovery-resources.js';

const id = `sha256:${'a'.repeat(64)}`;
const containerId = 'b'.repeat(64);
const script = { script: 'printf owned-sql', env: { INCLUDED_SCHEMAS: '*' } };
const resources: RecoveryResources = { image: 'public.ecr.aws/supabase/postgres:15.8.1.085', scripts: { roles: script, schema: script, data: script, historySchema: script, historyData: script } };
const input = { resources, image: { id, volumes: ['/var/lib/postgresql/data'] }, variant: 'data' as const, env: { PGPASSWORD: 'secret-test', PGSSLMODE: 'require' }, directory: '/owned', outputFile: '/owned/data.sql', remainingBytes: 1234 };

describe('owned dump container lifecycle', () => {
  it('requires an already cached image without attempting pull', async () => {
    const run = vi.fn(async () => { throw new Error('not cached'); });
    await expect(prepareRecoveryImage(resources, run)).rejects.toMatchObject({ code: 'cached-image-prerequisite' });
    expect(run.mock.calls).toHaveLength(1);
  });

  it('rejects unexpected image volume declarations', async () => {
    await expect(prepareRecoveryImage(resources, async () => JSON.stringify([id, { '/unexpected': {} }]))).rejects.toMatchObject({ code: 'image-volume-prerequisite' });
  });

  it('runs immutable image with no pull/logs, resource caps and environment-only credentials', async () => {
    const run = vi.fn(async (_command: RecoveryCommand) => '');
    await dumpRecoveryArtifact(input, run);
    const command = run.mock.calls.find(([item]) => item.args[0] === 'run')?.[0];
    expect(command?.args).toEqual(expect.arrayContaining(['--pull=never', '--log-driver=none', '--read-only', '--memory=512m', '--memory-swap=512m', '--cpus=1', '--pids-limit=64', '--env', 'PGPASSWORD', id]));
    expect(JSON.stringify(command?.args)).not.toContain('secret-test');
    expect(command?.env.PGPASSWORD).toBe('secret-test');
    expect(command?.outputFile).toBe('/owned/data.sql');
    expect(command?.outputLimit).toBe(1234);
    expect(command?.args.some((arg) => arg === '--volume' || arg === '-v')).toBe(false);
    expect(run.mock.calls.filter(([item]) => item.args[1] === 'ls')).toHaveLength(3);
  });

  it('reaps only verified owned survivors after dump failure and verifies absence', async () => {
    let name = ''; let survivor = false;
    const run = vi.fn(async (command: RecoveryCommand) => {
      if (command.args[0] === 'run') { name = command.args[command.args.indexOf('--name') + 1] ?? ''; survivor = true; throw new Error('failed dump'); }
      if (command.args[1] === 'ls') return survivor ? containerId : '';
      if (command.args[1] === 'inspect') return JSON.stringify([containerId, id, `/${name}`, name, name, [{ Type: 'tmpfs' }]]);
      if (command.args[1] === 'rm') survivor = false;
      return '';
    });
    await expect(dumpRecoveryArtifact(input, run)).rejects.toThrow('failed dump');
    expect(run.mock.calls.find(([item]) => item.args[1] === 'rm')?.[0].args).toEqual(['container', 'rm', '-fv', containerId]);
    expect(survivor).toBe(false);
  });

  it('refuses cleanup rather than deleting a container with mismatched ownership', async () => {
    let survivor = false;
    const run = vi.fn(async (command: RecoveryCommand) => {
      if (command.args[0] === 'run') survivor = true;
      if (command.args[1] === 'ls') return survivor ? containerId : '';
      if (command.args[1] === 'inspect') return JSON.stringify([containerId, id, '/foreign', 'foreign', 'foreign', []]);
      return '';
    });
    await expect(dumpRecoveryArtifact(input, run)).rejects.toMatchObject({ code: 'owned-container-cleanup-unverified' });
    expect(run.mock.calls.some(([item]) => item.args[1] === 'rm')).toBe(false);
  });
});
