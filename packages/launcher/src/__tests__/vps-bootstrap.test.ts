import { describe, expect, it } from 'vitest';
import {
  SOMNIBOT_REPOSITORY_REF,
  SOMNIBOT_REPOSITORY_URL,
  VPS_BOOTSTRAP_SCRIPT,
  VPS_PREFLIGHT_SCRIPT,
  VPS_RUNTIME_BOOTSTRAP_SCRIPT,
} from '../main/vps-bootstrap';

describe('VPS first-time bootstrap contract', () => {
  it('pins the authoritative repository and release ref', () => {
    expect(SOMNIBOT_REPOSITORY_URL).toBe('https://github.com/HeyImDionysus/somnibot.git');
    expect(SOMNIBOT_REPOSITORY_REF).toMatch(/^[0-9a-f]{40}$/);
    expect(VPS_BOOTSTRAP_SCRIPT).toContain(SOMNIBOT_REPOSITORY_URL);
    expect(VPS_BOOTSTRAP_SCRIPT).toContain(SOMNIBOT_REPOSITORY_REF);
  });

  it('checks a fresh parent path and host prerequisites without mutating the VPS', () => {
    expect(VPS_PREFLIGHT_SCRIPT).toContain('test -w "$parent_dir"');
    expect(VPS_PREFLIGHT_SCRIPT).toContain('command -v git');
    expect(VPS_PREFLIGHT_SCRIPT).toContain('docker compose version');
    expect(VPS_PREFLIGHT_SCRIPT).not.toContain('git clone');
    expect(VPS_PREFLIGHT_SCRIPT).not.toContain('mkdir -p');
  });

  it('uses a fixed, idempotent Ubuntu/Debian runtime bootstrap contract', () => {
    expect(VPS_RUNTIME_BOOTSTRAP_SCRIPT).toContain('ubuntu|debian');
    expect(VPS_RUNTIME_BOOTSTRAP_SCRIPT).toContain('apt-get update');
    expect(VPS_RUNTIME_BOOTSTRAP_SCRIPT).toContain('docker.io');
    expect(VPS_RUNTIME_BOOTSTRAP_SCRIPT).toContain('docker-compose-v2');
    expect(VPS_RUNTIME_BOOTSTRAP_SCRIPT).toContain('runtime_packages="$runtime_packages git"');
    expect(VPS_RUNTIME_BOOTSTRAP_SCRIPT).toContain('command -v git');
    expect(VPS_RUNTIME_BOOTSTRAP_SCRIPT).toContain('systemctl enable --now docker');
    expect(VPS_RUNTIME_BOOTSTRAP_SCRIPT).toContain('usermod -aG docker');
    expect(VPS_RUNTIME_BOOTSTRAP_SCRIPT).not.toContain('DISCORD_TOKEN');
    expect(VPS_RUNTIME_BOOTSTRAP_SCRIPT).not.toContain('PAYPAL_CLIENT_SECRET');
  });

  it('refuses unsafe or dirty targets before checkout replacement', () => {
    expect(VPS_BOOTSTRAP_SCRIPT).toContain('deployment path contains unsupported characters');
    expect(VPS_BOOTSTRAP_SCRIPT).toContain('refusing an unapproved SomniBot repository URL');
    expect(VPS_BOOTSTRAP_SCRIPT).toContain('deployment path is not empty and is not a SomniBot git checkout; refusing to overwrite it');
    expect(VPS_BOOTSTRAP_SCRIPT).toContain('deployment checkout origin is not the authoritative SomniBot repository');
    expect(VPS_BOOTSTRAP_SCRIPT).toContain('deployment checkout has local changes; refusing to overwrite them');
    expect(VPS_BOOTSTRAP_SCRIPT).toContain('git -C "$deploy_path" checkout --detach --force');
  });
});
