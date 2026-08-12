import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GuildConfigSaveCoordinator,
  GuildConfigSaveError,
  saveGuildConfigWithReadback,
  type GuildConfigPatch,
  type GuildConfigReadback,
} from './guild-config-save';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('saveGuildConfigWithReadback', () => {
  it('returns the authoritative server-normalized value', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        config: { economy_daily_loss_limit: 100 },
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const config = await saveGuildConfigWithReadback({ economy_daily_loss_limit: 101 });

    expect(config.economy_daily_loss_limit).toBe(100);
  });

  it('attaches an authoritative readback when the PATCH is rejected', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        config: { economy_daily_loss_limit: 7200, economy_lottery_ticket_price: 125 },
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(saveGuildConfigWithReadback({ economy_daily_loss_limit: 6000 })).rejects.toMatchObject({
      confirmedConfig: { economy_daily_loss_limit: 7200, economy_lottery_ticket_price: 125 },
    });
  });
});

describe('GuildConfigSaveCoordinator', () => {
  it('serializes concurrent saves without publishing an older state over a newer edit', async () => {
    const calls: GuildConfigPatch[] = [];
    let releaseFirst = (): void => undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const saveOperation = async (patch: GuildConfigPatch): Promise<GuildConfigReadback> => {
      calls.push(patch);
      if (calls.length === 1) await firstGate;
      return calls.length === 1
        ? { economy_daily_loss_limit: 5000, economy_lottery_ticket_price: 100 }
        : { economy_daily_loss_limit: 5000, economy_lottery_ticket_price: 125 };
    };
    const coordinator = new GuildConfigSaveCoordinator(saveOperation);

    const older = coordinator.save({ economy_daily_loss_limit: 5000 });
    const newer = coordinator.save({ economy_lottery_ticket_price: 125 });
    await Promise.resolve();
    expect(calls).toEqual([{ economy_daily_loss_limit: 5000 }]);

    releaseFirst();
    await expect(newer).resolves.toEqual({
      status: 'confirmed',
      config: { economy_daily_loss_limit: 5000, economy_lottery_ticket_price: 125 },
    });
    await expect(older).resolves.toEqual({ status: 'superseded' });
    expect(calls).toEqual([
      { economy_daily_loss_limit: 5000 },
      { economy_lottery_ticket_price: 125 },
    ]);
  });

  it('suppresses an older failure after a newer request has been queued', async () => {
    let attempt = 0;
    let rejectFirst = (): void => undefined;
    const firstGate = new Promise<void>((_, reject) => {
      rejectFirst = () => reject(new GuildConfigSaveError('older request failed'));
    });
    const saveOperation = async (): Promise<GuildConfigReadback> => {
      attempt += 1;
      if (attempt === 1) await firstGate;
      return { economy_daily_loss_limit: 7000 };
    };
    const coordinator = new GuildConfigSaveCoordinator(saveOperation);

    const older = coordinator.save({ economy_daily_loss_limit: 6000 });
    const newer = coordinator.save({ economy_daily_loss_limit: 7000 });
    rejectFirst();

    await expect(older).resolves.toEqual({ status: 'superseded' });
    await expect(newer).resolves.toEqual({
      status: 'confirmed',
      config: { economy_daily_loss_limit: 7000 },
    });
  });

  it('restores the older confirmed readback only after the newer save fails', async () => {
    let attempt = 0;
    const saveOperation = async (): Promise<GuildConfigReadback> => {
      attempt += 1;
      if (attempt === 2) throw new GuildConfigSaveError('newer request failed');
      return { economy_daily_loss_limit: 6000 };
    };
    const coordinator = new GuildConfigSaveCoordinator(saveOperation);

    const older = coordinator.save({ economy_daily_loss_limit: 6000 });
    const newer = coordinator.save({ economy_daily_loss_limit: 7000 });

    await expect(older).resolves.toEqual({
      status: 'confirmed',
      config: { economy_daily_loss_limit: 6000 },
    });
    await expect(newer).rejects.toThrow('newer request failed');
  });

  it('returns the authoritative recovery state when the latest save fails', async () => {
    const recovered = { economy_daily_loss_limit: 7200, economy_lottery_ticket_price: 125 };
    const coordinator = new GuildConfigSaveCoordinator(async () => {
      throw new GuildConfigSaveError('save failed', recovered);
    });

    await expect(coordinator.save({ economy_daily_loss_limit: 6000 })).resolves.toEqual({
      status: 'failed',
      config: recovered,
    });
  });
});
