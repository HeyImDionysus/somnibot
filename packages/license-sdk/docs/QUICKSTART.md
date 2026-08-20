# Quick Start Guide

## 1. Get Your License Key

After purchasing a product through SomniBot's store, you'll receive an `SMNI-XXXX-XXXX-XXXX-XXXX` format key via DM or email.

## 2. Integrate in Your App

The key is already bound to the purchaser's Discord account. Its first
successful validation from the product activates it; no separate Discord
command is required.

### TypeScript / JavaScript

```bash
npm install @somnibot/license-sdk
```

```typescript
import { SomniLicense } from '@somnibot/license-sdk';

const license = new SomniLicense({
  apiBase: process.env.SOMNIBOT_API_URL!,
  licenseKey: process.env.LICENSE_KEY!,
  productId: process.env.PRODUCT_ID!,
  deviceFingerprint: getDeviceId(), // your device ID logic
});

const { valid, features } = await license.validate();
```

### Python

```python
import requests

def validate_license(key: str, product_id: str) -> dict:
    r = requests.post(f"{API_BASE}/license/validate", json={
        "license_key": key,
        "product_id": product_id,
        "device_fingerprint": get_machine_id(),
    })
    return r.json()
```

### C# / .NET

```csharp
var client = new HttpClient();
var response = await client.PostAsJsonAsync($"{apiBase}/license/validate", new {
    license_key = key,
    product_id = productId,
    device_fingerprint = GetDeviceId()
});
var result = await response.Content.ReadFromJsonAsync<ValidationResult>();
```

## 3. Implement Heartbeat (Optional)

If the product requires periodic validation, the validate response will include `heartbeat_interval_seconds`. The TypeScript SDK handles this automatically. For other languages, send a POST to `/api/license/heartbeat` at the specified interval.

## 4. Clean Up on Shutdown

Always deactivate your session when your app closes to free device slots:

```typescript
await license.deactivate();
license.destroy();
```
