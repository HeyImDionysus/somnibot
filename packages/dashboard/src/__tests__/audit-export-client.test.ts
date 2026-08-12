import { describe, expect, it, vi } from 'vitest';

import { downloadAuditExport, type AuditExportFilters } from '@/lib/audit-export';

const filters: AuditExportFilters = {
  category: '',
  search: '',
  dateFrom: '',
  dateTo: '',
};

describe('audit export client', () => {
  it('clicks a retained browser download link when the export response succeeds', async () => {
    const clickDownload = vi.fn();
    const revokeUrl = vi.fn();
    const schedule = vi.fn((task: () => void) => task());
    const result = await downloadAuditExport('csv', filters, {
      request: vi.fn(async () => new Response('timestamp,action', { status: 200 })),
      createUrl: vi.fn(() => 'blob:audit-export'),
      revokeUrl,
      clickDownload,
      schedule,
    });

    expect(result).toEqual({ ok: true });
    expect(clickDownload).toHaveBeenCalledWith('blob:audit-export', expect.stringMatching(/^audit-log-.*\.csv$/));
    expect(revokeUrl).toHaveBeenCalledWith('blob:audit-export');
  });

  it('returns the API error for an unsuccessful export without clicking a download', async () => {
    const clickDownload = vi.fn();
    const result = await downloadAuditExport('json', filters, {
      request: vi.fn(async () => Response.json({ error: 'Audit export is unavailable.' }, { status: 503 })),
      createUrl: vi.fn(() => 'blob:should-not-exist'),
      revokeUrl: vi.fn(),
      clickDownload,
      schedule: vi.fn(),
    });

    expect(result).toEqual({ ok: false, error: 'Audit export is unavailable.' });
    expect(clickDownload).not.toHaveBeenCalled();
  });
});
