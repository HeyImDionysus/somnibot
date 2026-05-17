# @somnibot/license-sdk

Universal license validation SDK for SomniBot Commerce. Validate license keys, manage device sessions, and implement heartbeat-based licensing from any platform.

## Features

- **License Validation** — Verify license keys against the SomniBot API
- **Device Sessions** — Automatic multi-device tracking with fingerprinting
- **Heartbeat** — Keep sessions alive with configurable intervals
- **Offline Grace** — Cached results allow offline use within a grace period
- **Auto-cleanup** — Deactivate sessions on app uninstall
- **TypeScript** — Full type definitions included

## Installation

```bash
npm install @somnibot/license-sdk
# or
bun add @somnibot/license-sdk
```

## Quick Start

```typescript
import { SomniLicense } from '@somnibot/license-sdk';

const license = new SomniLicense({
  apiBase: 'https://your-dashboard.vercel.app/api',
  licenseKey: 'SMNI-ABCD-EFGH-JKLM-NPQR',
  productId: 'your-product-uuid',
  deviceFingerprint: 'unique-device-id', // Optional but recommended
  deviceName: 'Windows PC',             // Optional
  appVersion: '1.0.0',                  // Optional
});

// Validate on startup
const result = await license.validate();
if (result.valid) {
  console.log('✅ License valid!');
  console.log('Features:', result.features);
  console.log('Tier:', result.tier);
  // Heartbeat auto-starts if configured
} else {
  console.log('❌ Invalid:', result.error);
}

// On shutdown/uninstall
await license.deactivate();
license.destroy();
```

## API

See [API.md](./API.md) for the full API reference.

## Platform Guides

See [PLATFORMS.md](./PLATFORMS.md) for integration guides for Python, C#, Rust, and more.

## Security

See [SECURITY.md](./SECURITY.md) for best practices on securing your license implementation.
