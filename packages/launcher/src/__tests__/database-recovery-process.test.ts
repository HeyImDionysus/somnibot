import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnFixture = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnFixture }));
import { runRecoveryCommand } from '../main/database-recovery-process.js';

class ChildFixture extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 43120;
  readonly kill = vi.fn();
  constructor(stdin: Writable = new PassThrough()) { super(); this.stdin = stdin; }
}
class ControlledInput extends Writable {
  readonly chunks: Buffer[] = [];
  private releaseWrite: (() => void) | null = null;
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    this.chunks.push(Buffer.from(chunk));
    this.releaseWrite = callback;
  }
  release() {
    const callback = this.releaseWrite;
    this.releaseWrite = null;
    callback?.();
  }
}
let child: ChildFixture;
const directories: string[] = [];
beforeEach(() => { child = new ChildFixture(); spawnFixture.mockReset().mockReturnValue(child); vi.spyOn(process, 'kill').mockReturnValue(true); });
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('bounded recovery process adapter', () => {
  it('streams SQL to its private file and resolves only after file completion', async () => {
    // Given one private, empty, exclusively created artifact and a fake child.
    const directory = await mkdtemp(path.join(os.tmpdir(), 'somnibot-stream-test-')); directories.push(directory);
    const outputFile = path.join(directory, 'data.sql'); await writeFile(outputFile, '', { flag: 'wx', mode: 0o600 });
    const pending = runRecoveryCommand({ tool: 'docker', args: [], env: {}, directory, outputFile, outputLimit: 64 });
    await vi.waitFor(() => expect(spawnFixture).toHaveBeenCalledTimes(1));
    // When stdout reaches EOF and the owned child exits successfully.
    child.stdout.end('SELECT 1;'); child.emit('close', 0);
    // Then SQL is on disk, not returned as a buffered string.
    await expect(pending).resolves.toBe('');
    expect(await readFile(outputFile, 'utf8')).toBe('SELECT 1;');
  });

  it('refuses a SQL chunk beyond the remaining aggregate artifact budget', async () => {
    // Given a private output with only four bytes of permitted remaining budget.
    const directory = await mkdtemp(path.join(os.tmpdir(), 'somnibot-stream-test-')); directories.push(directory);
    const outputFile = path.join(directory, 'data.sql'); await writeFile(outputFile, '', { flag: 'wx', mode: 0o600 });
    const pending = runRecoveryCommand({ tool: 'docker', args: [], env: {}, directory, outputFile, outputLimit: 4 });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'artifact-size-limit' });
    await vi.waitFor(() => expect(spawnFixture).toHaveBeenCalledTimes(1));
    // When an oversized chunk arrives and the fake owned child closes.
    child.stdout.end('12345'); child.emit('close', 1);
    // Then the chunk is not written and no artifact success can escape.
    await assertion; expect(await readFile(outputFile, 'utf8')).toBe('');
  });

  it('passes credentials only in scoped environment and returns bounded stdout', async () => {
    // Given a mocked native child and a password-free command.
    const pending = runRecoveryCommand({ tool: 'psql', args: ['--dbname', 'postgresql://postgres@db.target.supabase.co:5432/postgres'], env: { PGPASSWORD: 'transient-secret' } });
    // When that owned child succeeds.
    child.stdout.emit('data', Buffer.from('result'));
    child.emit('close', 0);
    // Then only its output is returned and no password is in argv.
    await expect(pending).resolves.toBe('result');
    expect(spawnFixture.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ shell: false, windowsHide: true, env: expect.objectContaining({ PGPASSWORD: 'transient-secret' }) }));
    expect(JSON.stringify(spawnFixture.mock.calls[0]?.[1])).not.toContain('transient-secret');
  });

  it('streams bounded snapshot input through stdin without placing SQL in argv', async () => {
    // Given immutable verified SQL bytes and a child that accepts stdin.
    const input = Buffer.from('SELECT 1;\n');
    const chunks: Buffer[] = [];
    child.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    const pending = runRecoveryCommand({ tool: 'psql', args: ['--file', '-'], env: {}, input });
    // When the input stream reaches EOF and the child exits successfully.
    await vi.waitFor(() => expect(child.stdin.writableEnded).toBe(true));
    child.emit('close', 0);
    // Then backpressured stdin receives the snapshot and argv contains no SQL.
    await expect(pending).resolves.toBe('');
    expect(Buffer.concat(chunks)).toEqual(input);
    expect(spawnFixture.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }));
    expect(JSON.stringify(spawnFixture.mock.calls[0]?.[1])).not.toContain('SELECT 1');
  });

  it('waits for controlled stdin backpressure to release after child close', async () => {
    // Given a child stdin that accepts bytes but defers its write callback.
    const stdin = new ControlledInput();
    child = new ChildFixture(stdin);
    spawnFixture.mockReturnValue(child);
    const input = Buffer.from('SELECT controlled;\n');
    const pending = runRecoveryCommand({ tool: 'psql', args: ['--file', '-'], env: {}, input });
    await vi.waitFor(() => expect(stdin.chunks).toHaveLength(1));
    let settled = false;
    void pending.finally(() => { settled = true; });
    // When the child closes before the pending write is released.
    child.emit('close', 0);
    await Promise.resolve();
    // Then the adapter remains pending until release and resolves with the exact bytes delivered.
    expect(settled).toBe(false);
    stdin.release();
    await expect(pending).resolves.toBe('');
    expect(Buffer.concat(stdin.chunks)).toEqual(input);
  });

  it('reports client input failure when stdin fails before a zero exit', async () => {
    // Given snapshot input whose child stdin fails independently of process exit.
    const stdin = new ControlledInput();
    child = new ChildFixture(stdin);
    spawnFixture.mockReturnValue(child);
    const pending = runRecoveryCommand({ tool: 'psql', args: ['--file', '-'], env: {}, input: Buffer.from('SELECT 1;') });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'client-input-failed' });
    await vi.waitFor(() => expect(stdin.chunks).toHaveLength(1));
    // When stdin fails and the child otherwise reports success.
    stdin.destroy(new Error('input failed'));
    child.emit('close', 0);
    // Then the adapter refuses the incomplete restore input.
    await assertion;
  });

  it('preserves a known target refusal when the child closes stdin early', async () => {
    // Given a restore child that rejects the target before consuming all snapshot bytes.
    const pending = runRecoveryCommand({ tool: 'psql', args: ['--file', '-'], env: {}, input: Buffer.alloc(1024, 'x') });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'recovery_target_must_be_unused' });
    // When stderr reports the known refusal and the child closes early.
    child.stderr.end('recovery_target_must_be_unused');
    child.stdin.destroy(new Error('early close'));
    child.emit('close', 1);
    // Then input-stream failure does not mask the safe refusal code.
    await assertion;
  });

  it('reports a missing executable without echoing native error details', async () => {
    // Given a missing client error carrying sensitive native text.
    const pending = runRecoveryCommand({ tool: 'psql', args: [], env: {} });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'missing-client-prerequisite', message: 'missing-client-prerequisite' });
    // When spawn fails.
    child.emit('error', Object.assign(new Error('password=secret'), { code: 'ENOENT' }));
    // Then the stable prerequisite code is the only exposed error.
    await assertion;
  });

  it('terminates only its owned child tree at the timeout boundary', async () => {
    // Given a mocked native child that never exits on its own.
    vi.useFakeTimers();
    const pending = runRecoveryCommand({ tool: 'psql', args: [], env: {} });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'client-timeout' });
    // When the exact bounded timeout expires and the owned tree closes.
    await vi.advanceTimersByTimeAsync(180_000);
    child.emit('close', 1);
    // Then the refusal reflects timeout, with no unscoped process kill.
    await assertion;
    if (process.platform === 'win32') expect(spawnFixture.mock.calls[1]?.[1]).toEqual(['/PID', '43120', '/T', '/F']);
    else expect(process.kill).toHaveBeenCalledWith(-43120, 'SIGKILL');
  });

  it('stops oversized output without returning any sensitive stderr', async () => {
    // Given a mocked client exceeding the combined output cap.
    const pending = runRecoveryCommand({ tool: 'psql', args: [], env: {} });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'client-output-limit' });
    // When its stderr crosses the cap and the owned tree closes.
    child.stderr.emit('data', Buffer.alloc(1024 * 1024 + 1, 'x'));
    child.emit('close', 1);
    // Then the output-limit refusal is emitted rather than raw output.
    await assertion;
  });
});
