/**
 * V5-Audit §14.1 — ShardingManager entry point.
 *
 * Use this instead of index.ts when the bot exceeds ~2,500 guilds.
 * Discord's gateway requires sharding above that threshold.
 *
 * Usage:
 *   node dist/shard.js          # auto-detect shard count from Discord
 *   TOTAL_SHARDS=4 node dist/shard.js   # manual shard count
 *
 * Each shard spawns a separate process running index.js (the normal bot).
 * State is shared via Supabase + Valkey — no in-memory state to coordinate.
 *
 * See docs/SCALING.md for full deployment guidance.
 */
import { ShardingManager } from 'discord.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@somnibot/shared';

const log = createLogger('ShardManager');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const token = process.env.DISCORD_TOKEN;
if (!token) {
  log.error('DISCORD_TOKEN is required');
  process.exit(1);
}

const totalShards = process.env.TOTAL_SHARDS
  ? parseInt(process.env.TOTAL_SHARDS, 10)
  : 'auto';

const manager = new ShardingManager(path.join(__dirname, 'index.js'), {
  token,
  totalShards,
  // Respect Discord's max concurrency for large bots
  // (Discord tells us via the /gateway/bot endpoint, ShardingManager handles it)
  respawn: true,
});

manager.on('shardCreate', (shard) => {
  log.info(`Shard ${shard.id} launched (PID will be assigned on spawn)`);

  shard.on('ready', () => {
    log.info(`Shard ${shard.id} ready`);
  });

  shard.on('disconnect', () => {
    log.warn(`Shard ${shard.id} disconnected`);
  });

  shard.on('reconnecting', () => {
    log.info(`Shard ${shard.id} reconnecting`);
  });

  shard.on('death', (process) => {
    const exitCode = 'exitCode' in process ? process.exitCode : 'unknown';
    log.error(`Shard ${shard.id} died (exit code: ${exitCode})`);
  });

  shard.on('error', (error) => {
    log.error(`Shard ${shard.id} error: ${error.message}`);
  });
});

log.info(`Starting ShardingManager (totalShards: ${totalShards})`);
manager.spawn().catch((err) => {
  log.error('Failed to spawn shards', { detail: err });
  process.exit(1);
});

// Graceful shutdown — send SIGTERM to all shards
const shutdown = () => {
  log.info('Shutting down all shards...');
  for (const [, shard] of manager.shards) {
    shard.kill();
  }
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
