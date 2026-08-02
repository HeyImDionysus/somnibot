import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dotenvValue } from '../main/vps-env-materializer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const writer = path.join(repoRoot, 'scripts', 'write-production-env.sh');
const restorer = path.join(repoRoot, 'scripts', 'restore-production-env.sh');

describe('protected VPS environment scripts', () => {
  it('keeps credential input out of SSH shell strings and cleans temp files on every exit', () => {
    const writerSource = readFileSync(writer, 'utf8');
    const restorerSource = readFileSync(restorer, 'utf8');

    expect(writerSource).toContain('cat > "$temp_path"');
    expect(writerSource).toContain('trap cleanup EXIT HUP INT TERM');
    expect(writerSource).toContain('rm -f -- "$temp_path" "$backup_temp"');
    expect(writerSource).toContain('mv -f -- "$backup_temp" "${env_path}.rollback"');
    expect(restorerSource).toContain('mv -f -- "$temp_path" "$env_path"');
  });

  it.skipIf(process.platform === 'win32')('atomically writes, backs up, restores, and cleans failed writes', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'somnibot-vps-env-'));
    const envPath = path.join(root, '.env');
    try {
      writeFileSync(envPath, 'GENERATION=old\n', { mode: 0o600 });
      const writeResult = spawnSync('sh', [writer, envPath], {
        input: 'GENERATION=new\n',
        encoding: 'utf8',
      });
      expect(writeResult.status, writeResult.stderr).toBe(0);
      expect(readFileSync(envPath, 'utf8')).toBe('GENERATION=new\n');
      expect(readFileSync(`${envPath}.rollback`, 'utf8')).toBe('GENERATION=old\n');
      expect(statSync(envPath).mode & 0o777).toBe(0o600);

      const restoreResult = spawnSync('sh', [restorer, envPath], { encoding: 'utf8' });
      expect(restoreResult.status, restoreResult.stderr).toBe(0);
      expect(readFileSync(envPath, 'utf8')).toBe('GENERATION=old\n');

      const fakeBin = path.join(root, 'fake-bin');
      mkdirSync(fakeBin);
      const fakeMv = path.join(fakeBin, 'mv');
      writeFileSync(fakeMv, '#!/bin/sh\nexit 1\n');
      chmodSync(fakeMv, 0o700);
      const failedWrite = spawnSync('sh', [writer, envPath], {
        input: 'PARTIAL=secret\n',
        encoding: 'utf8',
        env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}` },
      });
      expect(failedWrite.status).not.toBe(0);
      expect(readdirSync(root).filter((name) => name.includes('.tmp.'))).toEqual([]);
      expect(readFileSync(envPath, 'utf8')).toBe('GENERATION=old\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.env.SOMNIBOT_DOCKER_ENV_PROOF === '1')('round-trips special characters through the Docker Compose env parser', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'somnibot-compose-env-'));
    const original = "back\\slash'quote$dollar#hash and spaces";
    try {
      writeFileSync(path.join(root, '.env'), `CREDENTIAL=${dotenvValue(original)}\n`);
      writeFileSync(path.join(root, 'compose.yml'), [
        'services:',
        '  proof:',
        '    image: scratch',
        '    environment:',
        '      - CREDENTIAL',
        '',
      ].join('\n'));
      const result = spawnSync('docker', [
        'compose', '--env-file', '.env', '-f', 'compose.yml', 'config', '--format', 'json',
      ], { cwd: root, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      const parsed = JSON.parse(result.stdout) as { services: { proof: { environment: { CREDENTIAL: string } } } };
      expect(parsed.services.proof.environment.CREDENTIAL.replace(/\$\$/g, '$')).toBe(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
