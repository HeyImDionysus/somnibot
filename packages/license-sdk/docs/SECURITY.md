# Security Best Practices

## License Key Security

### Never Store Plaintext Keys on the Server

SomniBot stores only SHA-256 hashes of license keys — the plaintext key is never saved in the database. This means:

- A database breach does not expose customer keys
- Keys are only visible when first issued (in the DM/receipt)
- Lookup is done by hashing the provided key and comparing hashes

### Client-Side Key Storage

- Store the key encrypted if possible (OS keychain, encrypted config file)
- Never hardcode keys in source code
- Use environment variables for CI/CD or server deployments

## Device Fingerprinting

Device fingerprints should be:

- **Unique per device** — different on every machine
- **Stable** — same across app restarts
- **Not spoofable** — combine multiple hardware identifiers

Good fingerprint sources:
- Machine UUID / Hardware ID
- MAC address hash
- Disk serial + CPU ID hash
- For mobile: device ID provided by the OS

## API Security

### Rate Limiting

The validation API enforces rate limits per key and per IP. Avoid calling validate more than once per minute from the same device.

### Session Management

- Each active session uses a device slot
- Max devices per key is configurable per product
- When the limit is reached, the oldest session is evicted
- Always call `deactivate()` when your app shuts down to free slots

### Network Security

- All API calls should use HTTPS
- The SDK validates SSL certificates by default
- In development, you can use HTTP with localhost only

### Certificate Pinning (Recommended for High-Value Products)

For maximum supply-chain protection, pin the server's TLS certificate or its public key in your client integration. This prevents MITM attacks even if a Certificate Authority is compromised.

**Node.js / Electron:**
```ts
import { createHash } from 'crypto';
import https from 'https';

const PINNED_FINGERPRINT = 'sha256/YOUR_SERVER_CERT_FINGERPRINT_HERE';

const agent = new https.Agent({
  checkServerIdentity: (_host, cert) => {
    const fingerprint = `sha256/${createHash('sha256').update(cert.raw).digest('base64')}`;
    if (fingerprint !== PINNED_FINGERPRINT) {
      throw new Error('Certificate pinning failed — possible MITM attack');
    }
    return undefined;
  },
});

// Pass `agent` to your fetch/http calls to the license API
```

**Mobile / Desktop:**
- **Android:** Use `network-security-config` with `<pin-set>` directives
- **iOS:** Use `NSAppTransportSecurity` with certificate pinning via `URLSessionDelegate`
- **Electron:** Use the Node.js approach above in the main process

**Key rotation:** When rotating your server certificate, update the pinned fingerprint in your next client release. Consider pinning both the current and next certificate during the transition period to avoid breaking existing installations.

## Anti-Tampering

For high-value products:

1. **Require heartbeat** — Configure short heartbeat intervals (60–300s)
2. **Check features server-side** — Don't trust client-side feature flag caching alone
3. **Require Discord guild membership** — Ensures the user is in your Discord server
4. **Use the tier system** — Gate functionality by license tier

## Incident Response

If a key is compromised:

1. Revoke the key in the dashboard (Licenses page)
2. All active sessions are immediately terminated
3. Issue a new key via the customer detail page
4. The old key hash remains in the database for audit trail
