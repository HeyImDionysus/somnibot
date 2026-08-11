import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dotenvValue } from '../main/vps-env-materializer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const writer = path.join(repoRoot, 'scripts', 'write-production-env.sh');
const restorer = path.join(repoRoot, 'scripts', 'restore-production-env.sh');
const handoffStager = path.join(repoRoot, 'scripts', 'stage-handoff-valkey.sh');
const handoffRestorer = path.join(repoRoot, 'scripts', 'restore-handoff-valkey.sh');
const handoffExporter = path.join(repoRoot, 'scripts', 'export-handoff-valkey.sh');
const maintenanceEnter = path.join(repoRoot, 'scripts', 'enter-runtime-maintenance.sh');
const maintenanceExit = path.join(repoRoot, 'scripts', 'exit-runtime-maintenance.sh');
const healthRecovery = path.join(repoRoot, 'scripts', 'production-health-recover.sh');
const healthRecoveryInstaller = path.join(repoRoot, 'scripts', 'install-production-health-recovery.sh');
const productionCompose = path.join(repoRoot, 'scripts', 'lib', 'production-compose.sh');
const productionComposeConsumers = [
  path.join(repoRoot, 'scripts', 'backup-production-valkey.sh'),
  path.join(repoRoot, 'scripts', 'enter-runtime-maintenance.sh'),
  path.join(repoRoot, 'scripts', 'export-handoff-valkey.sh'),
  path.join(repoRoot, 'scripts', 'production-health-recover.sh'),
  path.join(repoRoot, 'scripts', 'restore-handoff-valkey.sh'),
  path.join(repoRoot, 'scripts', 'restore-production-valkey.sh'),
];

describe('protected VPS environment scripts', () => {
  it('keeps credential input out of SSH shell strings and cleans temp files on every exit', () => {
    const writerSource = readFileSync(writer, 'utf8');
    const restorerSource = readFileSync(restorer, 'utf8');

    expect(writerSource).toContain('cat 9>&- > "$temp_path"');
    expect(writerSource).toContain('trap cleanup EXIT HUP INT TERM');
    expect(writerSource).toContain('rm -f -- "$temp_path" "$backup_temp"');
    expect(writerSource).toContain('mv -f -- "$backup_temp" "${env_path}.rollback"');
    expect(writerSource).toContain('flock -n 9');
    expect(restorerSource).toContain('flock -n 9');
    expect(writerSource).not.toContain('mkdir -- "$lock_dir"');
    expect(restorerSource).not.toContain('mkdir -- "$lock_dir"');
    expect(restorerSource).toContain('mv -f -- "$temp_path" "$env_path"');
  });

  it('keeps automatic health recovery paused throughout an intentional runtime handoff', () => {
    const enterSource = readFileSync(maintenanceEnter, 'utf8');
    const exitSource = readFileSync(maintenanceExit, 'utf8');
    const recoverySource = readFileSync(healthRecovery, 'utf8');

    expect(enterSource).toContain('flock 8');
    expect(enterSource).toContain('> "$maintenance_file.partial"');
    expect(enterSource).toContain('stop bot dashboard');
    expect(enterSource).toContain('production_compose stop');
    expect(exitSource).toContain('flock 8');
    expect(exitSource).toContain('rm -f "$state_dir/maintenance"');
    expect(recoverySource).toContain('if [ -f "$state_dir/maintenance" ]');
  });

  it('keeps every production Compose caller in the isolated project and Funnel override', () => {
    const helperSource = readFileSync(productionCompose, 'utf8');
    const installerSource = readFileSync(healthRecoveryInstaller, 'utf8');

    expect(helperSource).toContain('compose_project_name=somnibot-prod');
    expect(helperSource).toContain('.somnibot/launcher-tailscale-funnel.compose.yml');
    expect(helperSource).toContain('--project-name "$compose_project_name"');
    expect(helperSource).toContain('-f "$compose_override_file"');
    expect(installerSource).toContain('scripts/lib/production-compose.sh');

    for (const script of productionComposeConsumers) {
      const source = readFileSync(script, 'utf8');
      expect(source, script).toContain('. "$deploy_path/scripts/lib/production-compose.sh"');
      expect(source, script).not.toContain('docker compose -f "$compose_file"');
    }
  });

  it('stages and restores handoff snapshots through fixed protected paths', () => {
    const stagerSource = readFileSync(handoffStager, 'utf8');
    const restorerSource = readFileSync(handoffRestorer, 'utf8');
    const exporterSource = readFileSync(handoffExporter, 'utf8');

    expect(stagerSource).toContain('umask 077');
    expect(stagerSource).toContain('cat > "$partial_file"');
    expect(stagerSource).toContain('[ "$header" = "REDIS" ]');
    expect(restorerSource).toContain('sha256sum -c');
    expect(restorerSource).toContain('valkey-check-rdb');
    expect(restorerSource).toContain('valkey-cli --rdb "$recovery_container_file"');
    expect(restorerSource).toContain('sha256sum "$recovery_backup"');
    expect(restorerSource).toContain('stop valkey');
    expect(restorerSource).toContain('docker cp "$snapshot_file" "$container_id:/data/dump.rdb"');
    expect(restorerSource).toContain('docker cp "$recovery_backup" "$container_id:/data/dump.rdb"');
    expect(restorerSource.indexOf('valkey-cli --rdb "$recovery_container_file"'))
      .toBeLessThan(restorerSource.indexOf('docker cp "$snapshot_file" "$container_id:/data/dump.rdb"'));
    expect(restorerSource.indexOf('stop valkey')).toBeLessThan(restorerSource.indexOf(':/data/dump.rdb'));
    expect(exporterSource).toContain('flock 9');
    expect(exporterSource).toContain('valkey-cli --rdb');
    expect(exporterSource).toContain('valkey-check-rdb');
    expect(exporterSource).toContain('cat "$snapshot_file"');
    expect(exporterSource).not.toContain('printf \'%s\\n\' "$snapshot_file"');
  });

  it.skipIf(process.platform === 'win32')('atomically stages binary RDB input and clears stale state on empty input', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'somnibot-handoff-stage-'));
    try {
      const first = spawnSync('sh', [handoffStager, root], {
        input: Buffer.concat([Buffer.from('REDIS0011'), Buffer.from([0, 1, 2, 255])]),
      });
      expect(first.status, first.stderr.toString()).toBe(0);
      expect(readFileSync(path.join(root, '.runtime-handoff', 'valkey.rdb')).subarray(0, 5).toString()).toBe('REDIS');
      expect(statSync(path.join(root, '.runtime-handoff', 'valkey.rdb')).mode & 0o777).toBe(0o600);

      const cleared = spawnSync('sh', [handoffStager, root], { input: Buffer.alloc(0) });
      expect(cleared.status, cleared.stderr.toString()).toBe(0);
      expect(() => statSync(path.join(root, '.runtime-handoff', 'valkey.rdb'))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it.skipIf(process.platform === 'win32')('releases locks after SIGKILL, ignores stale lock files, serializes writers, and restores normally', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'somnibot-vps-env-lock-'));
    const envPath = path.join(root, '.env');
    const lockPath = `${envPath}.write.lock`;
    try {
      writeFileSync(envPath, 'GENERATION=old\n', { mode: 0o600 });

      const heldWriter = spawn('sh', [writer, envPath], {
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      await new Promise(resolve => setTimeout(resolve, 100));

      const concurrent = spawnSync('sh', [writer, envPath], {
        input: 'GENERATION=blocked\n',
        encoding: 'utf8',
      });
      expect(concurrent.status).toBe(75);

      heldWriter.kill('SIGKILL');
      await new Promise<void>((resolve) => {
        heldWriter.once('close', () => resolve());
      });

      writeFileSync(lockPath, 'stale lock file is not a held lock\n');
      const recovered = spawnSync('sh', [writer, envPath], {
        input: 'GENERATION=recovered\n',
        encoding: 'utf8',
      });
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(readFileSync(envPath, 'utf8')).toBe('GENERATION=recovered\n');
      expect(statSync(lockPath).isFile()).toBe(true);
      expect(readdirSync(root).filter((name) => name.includes('.tmp.'))).toEqual([]);

      const restored = spawnSync('sh', [restorer, envPath], { encoding: 'utf8' });
      expect(restored.status, restored.stderr).toBe(0);
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
