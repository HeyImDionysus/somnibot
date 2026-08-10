export type AuditExportFormat = 'csv' | 'json';

export interface AuditExportFilters {
  readonly category: string;
  readonly search: string;
  readonly dateFrom: string;
  readonly dateTo: string;
}

interface AuditExportResponse {
  readonly ok: boolean;
  readonly status: number;
  blob(): Promise<Blob>;
  json(): Promise<unknown>;
}

export interface AuditExportClient {
  request(url: string): Promise<AuditExportResponse>;
  createUrl(blob: Blob): string;
  revokeUrl(url: string): void;
  clickDownload(url: string, filename: string): void;
  schedule(task: () => void): void;
}

type AuditExportResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

function exportFailureMessage(body: unknown, status: number): string {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const error = body.error;
    if (typeof error === 'string' && error.length > 0) return error;
  }
  return `Could not export audit logs (${status}).`;
}

export function buildAuditExportUrl(format: AuditExportFormat, filters: AuditExportFilters): string {
  const params = new URLSearchParams({ export: 'true', format });
  if (filters.category) params.set('category', filters.category);
  if (filters.search) params.set('search', filters.search);
  if (filters.dateFrom) params.set('dateFrom', new Date(filters.dateFrom).toISOString());
  if (filters.dateTo) params.set('dateTo', new Date(`${filters.dateTo}T23:59:59`).toISOString());
  return `/api/audit?${params}`;
}

function browserAuditExportClient(): AuditExportClient {
  return {
    request: (url) => fetch(url),
    createUrl: (blob) => URL.createObjectURL(blob),
    revokeUrl: (url) => URL.revokeObjectURL(url),
    clickDownload: (url, filename) => {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    },
    schedule: (task) => { setTimeout(task, 0); },
  };
}

export async function downloadAuditExport(
  format: AuditExportFormat,
  filters: AuditExportFilters,
  client: AuditExportClient = browserAuditExportClient(),
): Promise<AuditExportResult> {
  const response = await client.request(buildAuditExportUrl(format, filters));
  if (!response.ok) {
    try {
      return { ok: false, error: exportFailureMessage(await response.json(), response.status) };
    } catch {
      return { ok: false, error: `Could not export audit logs (${response.status}).` };
    }
  }

  const url = client.createUrl(await response.blob());
  const filename = `audit-log-${new Date().toISOString().slice(0, 10)}.${format}`;
  client.clickDownload(url, filename);
  client.schedule(() => client.revokeUrl(url));
  return { ok: true };
}
