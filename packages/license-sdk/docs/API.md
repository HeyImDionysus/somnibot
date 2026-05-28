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
  status: string;         // 'active', 'expired', 'revoked', 'invalid', 'offline_grace', 'network_error'
  entitlement_id?: string;
  features?: string[];    // Product feature flags
  tier?: string | null;   // License tier
  customer_discord_id?: string;
  customer_name?: string;
  expires_at?: string | null;
  session_id?: string | null;
  heartbeat_interval_seconds?: number;
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
  status: string;  // 'active', 'offline', 'offline_grace_expired', ...
  next_heartbeat_seconds: number;
}
```

#### `deactivate(): Promise<DeactivateResponse>`

Deactivates the current device session, freeing a device slot.

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

Clean up heartbeat timers. Call before disposing the instance.

---

## REST API Endpoints

### `POST /api/license/validate`

Validate a license key and optionally register a device session.

**Request Body:**
```json
{
  "license_key": "SMNI-XXXX-XXXX-XXXX-XXXX",
  "product_id": "uuid",
  "device_fingerprint": "string (optional)",
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
