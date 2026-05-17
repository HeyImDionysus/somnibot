/**
 * Automation rate limiting via Valkey.
 * §20.6 of the architecture doc.
 */
import type Valkey from 'iovalkey';
import { AUTOMATION_LIMITS } from '@somnibot/shared';

const PREFIX = 'auto:rl:';

export class AutomationRateLimiter {
  constructor(private valkey: Valkey) {}

  /**
   * Check if a user has exceeded the per-minute fire limit.
   * Returns true if the action is allowed.
   */
  async allowFire(guildId: string, userId: string): Promise<boolean> {
    const key = `${PREFIX}fire:${guildId}:${userId}`;
    const count = await this.valkey.incr(key);
    if (count === 1) {
      await this.valkey.expire(key, 60);
    }
    return count <= AUTOMATION_LIMITS.MAX_FIRES_PER_USER_PER_MINUTE;
  }

  /**
   * Check DM cooldown per user per automation.
   * Returns true if sending a DM is allowed.
   */
  async allowDM(guildId: string, automationId: string, userId: string): Promise<boolean> {
    const key = `${PREFIX}dm:${guildId}:${automationId}:${userId}`;
    const exists = await this.valkey.exists(key);
    if (exists) return false;
    await this.valkey.setex(key, AUTOMATION_LIMITS.DM_COOLDOWN_SECONDS, '1');
    return true;
  }

  /**
   * Custom per-automation rate limit.
   */
  async allowCustom(
    guildId: string,
    automationId: string,
    userId: string,
    maxFires: number,
    windowSeconds: number,
  ): Promise<boolean> {
    const key = `${PREFIX}custom:${guildId}:${automationId}:${userId}`;
    const count = await this.valkey.incr(key);
    if (count === 1) {
      await this.valkey.expire(key, windowSeconds);
    }
    return count <= maxFires;
  }
}
