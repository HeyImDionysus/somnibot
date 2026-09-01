import { expect, test, type Page, type Route } from '@playwright/test';

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function installCsrfApi(page: Page) {
  await page.route('**/api/csrf', (route) => fulfillJson(route, { token: 'admin-safety-csrf-token' }));
}

test.describe('Dashboard admin mutation safety', () => {
  test.setTimeout(120_000);

  test('confirms a queue replay, preserves the target on failure, and reads back success', async ({ page }, testInfo) => {
    await installCsrfApi(page);
    const item = {
      id: 'queue-17',
      action: 'grant_role',
      payload: { memberId: 'member-42' },
      error_message: 'Discord was unavailable',
      retry_count: 3,
      max_retries: 3,
      original_id: 'action-12',
      failed_at: '2030-01-01T12:00:00.000Z',
      acknowledged: false,
      acknowledged_at: null,
      retried: false,
      retried_at: null,
    };
    let rejectReplay = true;
    let reflectReplay = false;
    let replayRequest: unknown;

    await page.route('**/api/action-queue**', async (route) => {
      if (route.request().method() === 'POST') {
        replayRequest = route.request().postDataJSON();
        if (rejectReplay) {
          await fulfillJson(route, { success: false, error: 'Discord is still unavailable. Retry after checking bot health.' }, 503);
          return;
        }
        if (reflectReplay) item.retried = true;
        await fulfillJson(route, { success: true });
        return;
      }
      await fulfillJson(route, {
        success: true,
        data: {
          items: [item],
          pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
        },
      });
    });

    await page.goto('/action-queue');
    await page.getByRole('button', { name: 'Replay grant_role queue item' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('queue-17');
    await expect(dialog).toContainText('repeat the original action’s side effects');
    await dialog.getByRole('button', { name: 'Replay action' }).click();

    await expect(page.getByText('Discord is still unavailable. Retry after checking bot health.', { exact: true })).toBeVisible();
    await expect(dialog).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('action-queue-replay-error.png'), fullPage: true });
    rejectReplay = false;
    await dialog.getByRole('button', { name: 'Replay action' }).click();
    await expect(page.getByText(/authoritative readback/)).toBeVisible();
    await expect(dialog).toBeVisible();
    reflectReplay = true;
    await dialog.getByRole('button', { name: 'Replay action' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('table').getByText('Retried', { exact: true })).toBeVisible();
    expect(replayRequest).toEqual({ action: 'retry', ids: ['queue-17'] });
  });

  test('makes EXTRA_RESOURCE adoption explicit and confirms authoritative drift readback', async ({ page }, testInfo) => {
    await installCsrfApi(page);
    const config = {
      sync_enabled: true,
      sync_interval_minutes: 15,
      sync_auto_repair: false,
      sync_auto_repair_everyone: true,
    };
    const extraResource = {
      type: 'EXTRA_RESOURCE',
      severity: 'warning',
      entityType: 'channel',
      entityName: 'community-chat',
      entityDiscordId: 'channel-99',
      description: 'A Discord channel exists outside desired state.',
      suggestedAction: 'accept',
    };
    let driftItems = [extraResource];
    let syncActionRequest: unknown;

    await page.route('**/api/sync/status', (route) => fulfillJson(route, {
      success: true,
      data: {
        config,
        lastSyncAt: '2030-01-01T12:00:00.000Z',
        driftDetected: driftItems.length > 0,
        driftItems,
      },
    }));
    await page.route('**/api/sync/action', async (route) => {
      syncActionRequest = route.request().postDataJSON();
      driftItems = [];
      await fulfillJson(route, { success: true });
    });

    await page.goto('/sync');
    await page.getByRole('button', { name: 'Accept (adopt)' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Adopt “community-chat”');
    await expect(dialog).toContainText('preserves the existing Discord resource');
    await page.screenshot({ path: testInfo.outputPath('sync-extra-resource-confirmation.png'), fullPage: true });
    await dialog.getByRole('button', { name: 'Adopt resource' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('heading', { name: 'Server In Sync' })).toBeVisible();
    expect(syncActionRequest).toEqual({ action: 'accept', driftItem: extraResource });
  });

  test('shows field-level moderation errors and preserves rejected infraction input', async ({ page }, testInfo) => {
    await installCsrfApi(page);
    await page.route('**/api/moderation/infractions**', async (route) => {
      if (route.request().method() === 'POST') {
        await fulfillJson(route, { success: false, error: 'The member ID must be a Discord snowflake.' }, 400);
        return;
      }
      await fulfillJson(route, { success: true, data: [], total: 0 });
    });

    await page.goto('/moderation/infractions');
    await page.getByRole('button', { name: '+ Manual Infraction' }).click();
    await page.getByRole('button', { name: 'Record in History' }).click();
    await expect(page.getByText('Enter the member’s Discord ID.')).toBeVisible();
    await expect(page.getByText('Enter a reason for the moderation history.')).toBeVisible();

    const member = page.getByRole('textbox', { name: 'Member Discord ID', exact: true });
    const reason = page.getByRole('textbox', { name: 'Reason' });
    await member.fill('not-a-snowflake');
    await reason.fill('Historical warning supplied by staff');
    await page.getByRole('button', { name: 'Record in History' }).click();
    await expect(page.getByText('The member ID must be a Discord snowflake.').first()).toBeVisible();
    await expect(member).toHaveValue('not-a-snowflake');
    await expect(member).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#manual-infraction-member-error')).toHaveText('The member ID must be a Discord snowflake.');
    await expect(reason).toHaveValue('Historical warning supplied by staff');
    await page.screenshot({ path: testInfo.outputPath('moderation-infraction-field-errors.png'), fullPage: true });
  });

  test('confirms the exact workflow before permanently discarding it', async ({ page }, testInfo) => {
    await installCsrfApi(page);
    const queueItem = {
      id: 'workflow-dlq-4',
      event_type: 'license.delivery.failed',
      source: 'paypal-webhook',
      payload: { orderId: 'order-7' },
      error_message: 'License delivery timed out',
      error_stack: null,
      retry_count: 5,
      max_retries: 5,
      status: 'exhausted',
      first_failed_at: '2030-01-01T12:00:00.000Z',
      last_retry_at: null,
      resolved_at: null,
      resolved_by: null,
      resolution_note: null,
      created_at: '2030-01-01T12:00:00.000Z',
    };
    let queue = [queueItem];
    let discardRequest: unknown;

    await page.route('**/api/workflows/events?*', (route) => fulfillJson(route, { success: true, data: [] }));
    await page.route('**/api/workflows/dead-letter?*', (route) => fulfillJson(route, {
      success: true,
      data: queue,
      summary: { total: queue.length, pending: 0, retrying: 0, exhausted: queue.length, resolved: 0, discarded: 0 },
    }));
    await page.route('**/api/workflows/dead-letter', async (route) => {
      discardRequest = route.request().postDataJSON();
      queue = [];
      await fulfillJson(route, { success: true });
    });

    await page.goto('/workflows');
    await page.getByRole('button', { name: /Dead Letter Queue/ }).click();
    await page.getByRole('button', { name: /license.delivery.failed/ }).click();
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('license.delivery.failed');
    await expect(dialog).toContainText('cannot be replayed from here');
    await page.screenshot({ path: testInfo.outputPath('workflow-discard-confirmation.png'), fullPage: true });
    await dialog.getByRole('button', { name: 'Discard workflow' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByText('Dead letter queue is empty. All events processed successfully.')).toBeVisible();
    expect(discardRequest).toEqual({ id: 'workflow-dlq-4', action: 'discard', note: 'Manually discarded' });
  });

  test('keeps an admin undo dialog open until authoritative readback succeeds', async ({ page }, testInfo) => {
    await installCsrfApi(page);
    const change = {
      id: 'change-22',
      actor_id: 'owner-1',
      action: 'moderation.rule_updated',
      target_type: 'auto-mod rule',
      target_id: 'rule-8',
      description: 'Raised spam threshold',
      before_state: { threshold: 5 },
      after_state: { threshold: 10 },
      is_undoable: true,
      is_undone: false,
      undone_at: null,
      undone_by: null,
      undo_change_id: null,
      blast_radius: 'medium',
      requires_confirmation: true,
      created_at: '2030-01-01T12:00:00.000Z',
    };
    let changes = [change];

    await page.route('**/api/admin-changes?*', (route) => fulfillJson(route, { success: true, data: changes }));
    await page.route('**/api/admin-changes', async (route) => {
      expect(route.request().postDataJSON()).toEqual({ action: 'undo', id: 'change-22' });
      changes = [{ ...change, is_undoable: false, is_undone: true, undone_at: '2030-01-01T12:10:00.000Z' }];
      await fulfillJson(route, { success: true });
    });

    await page.goto('/admin-changes');
    await page.getByRole('button', { name: 'Undo change: Raised spam threshold' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('auto-mod rule rule-8');
    await expect(dialog).toContainText('recorded before-state');
    await page.screenshot({ path: testInfo.outputPath('admin-change-undo-confirmation.png'), fullPage: true });
    await dialog.getByRole('button', { name: 'Undo change' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByText('undone', { exact: true })).toBeVisible();
  });

  test('names the diagnostic webhook replay target and duplicate-delivery consequence', async ({ page }, testInfo) => {
    await installCsrfApi(page);
    await page.route('**/api/alerts?*', (route) => fulfillJson(route, { success: true, data: { alerts: [] } }));
    await page.route('**/api/diagnostics', (route) => fulfillJson(route, {
      success: true,
      data: {
        guidedMode: false,
        thresholds: { memoryRssMb: 512, wsPingMs: 500, webhookErrorRate: 0.25 },
        snapshotIntervalMs: 60_000,
        bot: { online: true, uptimeSeconds: 3600, memoryRssMb: 180, memoryHeapMb: 120, wsPing: 42, guildMemberCount: 12, activeVoiceConnections: 0, snapshotAt: '2030-01-01T12:00:00.000Z', staleSecs: 5 },
        lavalink: { nodes: [] },
        valkey: { connected: true, memoryMb: 8 },
        supabase: { healthy: true },
        webhooks: { total: 1, success: 0, error: 1, duplicate: 0, pending: 0 },
        sync: { lastSync: null, lastSyncDetails: null, lastDrift: null, lastDriftDetails: null },
        automations: { activeCount: 0 },
        scheduledMessages: { activeCount: 0 },
        dlq: { pendingCount: 0 },
        healthMetrics: {},
      },
    }));
    await page.route('**/api/webhooks?*', (route) => fulfillJson(route, {
      success: true,
      data: [{
        event_id: 'webhook-13',
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        processed_at: '2030-01-01T12:00:00.000Z',
        payload: {},
        result: 'error',
        error_details: 'Delivery failed',
        replayed_at: null,
        replay_count: 2,
      }],
      pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
    }));

    await page.goto('/diagnostics');
    await page.getByRole('button', { name: 'Replay PAYMENT.CAPTURE.COMPLETED webhook webhook-13' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('webhook-13');
    await expect(dialog).toContainText('repeat external side effects');
    await page.screenshot({ path: testInfo.outputPath('diagnostics-webhook-replay-confirmation.png'), fullPage: true });
  });

  test('persists diagnostics guided mode through its scoped API and renders the readback', async ({ page }, testInfo) => {
    await installCsrfApi(page);
    let guidedMode = true;
    let patchBody: unknown = null;
    const diagnosticsData = () => ({
      guidedMode,
      thresholds: { memoryRssMb: 512, wsPingMs: 500, webhookErrorRate: 0.25 },
      snapshotIntervalMs: 60_000,
      bot: { online: true, uptimeSeconds: 3600, memoryRssMb: 180, memoryHeapMb: 120, wsPing: 42, guildMemberCount: 12, activeVoiceConnections: 0, snapshotAt: '2030-01-01T12:00:00.000Z', staleSecs: 5 },
      lavalink: { nodes: [] },
      valkey: { connected: true, memoryMb: 8 },
      supabase: { healthy: true },
      webhooks: { total: 0, success: 0, error: 0, duplicate: 0, pending: 0 },
      sync: { lastSync: null, lastSyncDetails: null, lastDrift: null, lastDriftDetails: null },
      automations: { activeCount: 0 },
      scheduledMessages: { activeCount: 0 },
      dlq: { pendingCount: 0 },
      healthMetrics: {},
    });
    await page.route('**/api/alerts?*', (route) => fulfillJson(route, { success: true, data: { alerts: [] } }));
    await page.route('**/api/webhooks?*', (route) => fulfillJson(route, {
      success: true,
      data: [],
      pagination: { page: 1, pageSize: 25, total: 0, totalPages: 0 },
    }));
    await page.route('**/api/diagnostics', async (route) => {
      if (route.request().method() === 'PATCH') {
        patchBody = route.request().postDataJSON();
        guidedMode = false;
      }
      await fulfillJson(route, { success: true, data: diagnosticsData() });
    });

    await page.goto('/diagnostics');
    const guidedToggle = page.getByRole('checkbox', { name: 'Explain these numbers' });
    await expect(guidedToggle).toBeChecked();
    await guidedToggle.uncheck();

    await expect.poll(() => patchBody).toEqual({ diagnostics_guided_mode: false });
    await expect(guidedToggle).not.toBeChecked();
    await page.screenshot({ path: testInfo.outputPath('diagnostics-guided-mode-readback.png'), fullPage: true });
  });

  test('prevents duplicate alert acknowledgement and rejects a stale active-alert readback', async ({ page }) => {
    await installCsrfApi(page);
    const alert = {
      id: 'alert-7',
      alert_type: 'memory_high',
      severity: 'warning',
      title: 'Memory pressure',
      message: 'Memory is above the configured threshold.',
      acknowledged: false,
      resolved: false,
      created_at: '2030-01-01T12:00:00.000Z',
    };
    let patchRequests = 0;
    await page.route('**/api/alerts**', async (route) => {
      if (route.request().method() === 'PATCH') {
        patchRequests += 1;
        await fulfillJson(route, { success: true });
        return;
      }
      await fulfillJson(route, { success: true, data: { alerts: [alert] } });
    });
    await page.route('**/api/diagnostics', (route) => fulfillJson(route, {
      success: true,
      data: {
        guidedMode: false,
        thresholds: { memoryRssMb: 512, wsPingMs: 500, webhookErrorRate: 0.25 },
        snapshotIntervalMs: 60_000,
        bot: { online: true, uptimeSeconds: 3600, memoryRssMb: 600, memoryHeapMb: 120, wsPing: 42, guildMemberCount: 12, activeVoiceConnections: 0, snapshotAt: '2030-01-01T12:00:00.000Z', staleSecs: 5 },
        lavalink: { nodes: [] },
        valkey: { connected: true, memoryMb: 8 },
        supabase: { healthy: true },
        webhooks: { total: 0, success: 0, error: 0, duplicate: 0, pending: 0 },
        sync: { lastSync: null, lastSyncDetails: null, lastDrift: null, lastDriftDetails: null },
        automations: { activeCount: 0 },
        scheduledMessages: { activeCount: 0 },
        dlq: { pendingCount: 0 },
        healthMetrics: {},
      },
    }));
    await page.route('**/api/webhooks?*', (route) => fulfillJson(route, {
      success: true,
      data: [],
      pagination: { page: 1, pageSize: 25, total: 0, totalPages: 0 },
    }));

    await page.goto('/diagnostics');
    await page.getByRole('button', { name: 'Acknowledge' }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByRole('button', { name: 'Acknowledge alert' }).evaluate((button) => {
      button.click();
      button.click();
    });
    await expect.poll(() => patchRequests).toBe(1);
    await expect(dialog).toBeVisible();
    await expect(page.getByText(/alert remains in the authoritative active list/)).toBeVisible();
  });

  test('names the moderation rule before deletion', async ({ page }, testInfo) => {
    await installCsrfApi(page);
    const rule = {
      id: 'rule-delete-9',
      name: 'Repeated invite links',
      type: 'invite_filter',
      enabled: true,
      config: { allowOwnServer: false },
      action: 'delete',
      mute_duration_minutes: null,
      exempt_roles: [],
      exempt_channels: [],
      log_to_mod_channel: true,
      sync_to_discord: false,
      priority: 0,
      created_at: '2030-01-01T12:00:00.000Z',
    };
    let deleteRequests = 0;
    await page.route('**/api/moderation/rules**', async (route) => {
      if (route.request().method() === 'DELETE') {
        deleteRequests += 1;
        await fulfillJson(route, { success: true });
        return;
      }
      await fulfillJson(route, { success: true, data: [rule] });
    });

    await page.goto('/moderation/rules');
    await page.getByRole('button', { name: 'Delete Repeated invite links' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Repeated invite links');
    await expect(dialog).toContainText('stop protecting the server immediately');
    await dialog.getByRole('button', { name: 'Delete Rule' }).evaluate((button) => {
      button.click();
      button.click();
    });
    await expect.poll(() => deleteRequests).toBe(1);
    await expect(dialog).toBeVisible();
    await expect(page.getByText(/rule still appears in the authoritative readback/).first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('moderation-rule-delete-confirmation.png'), fullPage: true });
  });

  test('fails closed when a successful rule list payload is malformed', async ({ page }) => {
    await installCsrfApi(page);
    await page.route('**/api/moderation/rules**', (route) => fulfillJson(route, {
      success: true,
      data: [{ id: 42, name: 'Malformed rule' }],
    }));

    await page.goto('/moderation/rules');
    await expect(page.getByText('The auto-mod service returned an invalid readback. Retry from this page.')).toBeVisible();
    await expect(page.getByRole('button', { name: /Delete Malformed rule/ })).toHaveCount(0);
  });
});
