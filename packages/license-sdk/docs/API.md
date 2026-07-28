# API Reference

## `SomniLicense` Class

### Constructor

```typescript
new SomniLicense(config: SomniLicenseConfig)
```

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `apiBase` | `string` | ✅ | — | Dashboard API base URL |
| `licenseKey` | `string` | ✅ | — | SMNI-format license key |
| `productId` | `string` | ✅ | — | Product UUID |
| `deviceFingerprint` | `string` | — | — | Unique device identifier |
| `deviceName` | `string` | — | — | Human-readable device name |
| `appVersion` | `string` | — | — | App version string |
| `cacheTtlMs` | `number` | — | `60000` | Cache duration (ms) |
| `offlineGraceMs` | `number` | — | `86400000` | Offline grace period (ms) |

### Methods

#### `validate(): Promise<ValidationResponse>`

Validates the license key against the API. Returns cached result if within TTL.

**Response:**
```typescript
{
  valid: boolean;
  status: string;         // 'active', 'expired', 'revoked', 'invalid', 'offline_grace', 'network_error', 'superseded', 'destroyed'
  entitlement_id?: string;
  features?: string[];    // Product feature flags
  tier?: string | null;   // License tier
  customer_discord_id?: string;
  customer_name?: string;
  expires_at?: string | null;
  session_id?: string | null;
  heartbeat_interval_seconds?: number;
  retryable?: boolean;    // true when the failure is a service fault, not a verdict
  error?: string;
}
```

#### `heartbeat(): Promise<HeartbeatResponse>`

Sends a keepalive for the current session. Auto-called when heartbeat interval is configured.

If the network is unavailable, returns `{ valid: true, status: 'offline' }` as long as
the offline grace period hasn't expired. Once the grace window lapses, returns
`{ valid: false, status: 'offline_grace_expired' }` and stops the heartbeat timer.

**Response:**
```typescript
{
  valid: boolean;
  status: string;  // 'active', 'offline', 'offline_grace_expired', 'superseded', ...
  next_heartbeat_seconds: number;
  retryable?: boolean;
  error?: string;
}
```

### Verdicts vs. "we don't know"

`valid: false` covers two very different situations, and the SDK keeps them apart.

**Verdicts** — `revoked`, `expired`, `suspended`, `invalid_key`,
`over_device_limit`, `session_invalidated`. The licence server determined this
from data it read. Terminal: the cache is cleared and heartbeats stop. Your app
should stop too.

**Indeterminate** — `service_unavailable`, `rate_limited`, `superseded`, plus
any HTTP 5xx, any 429, and any response whose body is not parseable JSON (a
proxy error page). The server could **not** determine the status, or the SDK
discarded a stale completion because a newer definitive result already won;
neither says the customer is invalid. Non-terminal: the SDK keeps its cached
validation, keeps the heartbeat timer running, and rides the normal
offline-grace window, so a transient fault self-heals. These statuses are
exported as `INDETERMINATE_STATUSES` (with the predicate
`isIndeterminateResponse`).

`superseded` is generated only by the SDK; the licence server never returns it.
It has `retryable: true` and means the operation's result was ignored because
newer authoritative state was already applied. Callers can distinguish it from
a server verdict, keep using the SDK's current state, and retry if they still
need a fresh result.

```typescript
import { INDETERMINATE_STATUSES } from '@somnibot/license-sdk';

const res = await license.validate();
if (!res.valid && INDETERMINATE_STATUSES.includes(res.status)) {
  // Do not lock the user out and do not show a "licence revoked" message —
  // this is our outage, not their problem. Retry later.
}
```

While the SDK is running on cache during such a fault, `validate()` reports
`status: 'offline_grace'` and `heartbeat()` reports `status: 'offline'` — the
same statuses used for a plain network outage, because it is the same situation
from the licence's point of view.

#### `deactivate(): Promise<DeactivateResponse>`

Deactivates the current device session, freeing a device slot.

`validate()` and `deactivate()` share an invocation-ordered lifecycle queue. If
they overlap, the later call does not inspect cached/session state or dispatch
its request until the earlier call settles. This keeps API commit order aligned
with caller order even when validation reactivates the same server-side session
row. A failed deactivation preserves the session and still releases the queue.
Heartbeats continue independently under the session/terminal safeguards.

After `destroy()` this returns `{ success: false, error: 'SomniLicense instance has been destroyed' }`
without making a network request.

**Response:**
```typescript
{
  success: boolean;
  error?: string;
}
```

#### `isValid(): boolean`

Check if there's a cached valid result that hasn't expired.

#### `getFeatures(): string[]`

Get the cached features list.

#### `getTier(): string | null`

Get the cached license tier.

#### `getSessionId(): string | null`

Get the current session ID.

#### `destroy(): void`

Permanently dispose the instance: clear cached/session state, stop heartbeat
timers, ignore in-flight completions, and block future network operations.
Subsequent `validate()`/`heartbeat()` calls return terminal `destroyed`
responses. Create a new `SomniLicense` instance to start licensing again.

---

## REST API Endpoints

### `POST /api/license/validate`

Validate a license key and optionally register a device session.

**Request Body:**
```json
{
  "license_key": "SMNI-XXXX-XXXX-XXXX-XXXX",
  "product_id": "uuid",
  "device_fingerprint": "string (required when device limits are enabled)",
  "device_name": "string (optional)",
  "app_version": "string (optional)"
}
```

### `POST /api/license/heartbeat`

Keep a session alive.

**Request Body:**
```json
{
  "session_id": "uuid",
  "license_key": "SMNI-XXXX-XXXX-XXXX-XXXX"
}
```

### `POST /api/license/deactivate`

Deactivate a session.

**Request Body:**
```json
{
  "session_id": "uuid",
  "license_key": "SMNI-XXXX-XXXX-XXXX-XXXX"
}
```
