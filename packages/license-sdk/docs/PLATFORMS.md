# Platform Integration Guides

The SomniBot license API is a standard REST API — integrate from any language.

---

## Python

```python
import hashlib
import uuid
import requests

class SomniLicense:
    def __init__(self, api_base: str, license_key: str, product_id: str):
        self.api_base = api_base.rstrip('/')
        self.license_key = license_key
        self.product_id = product_id
        self.session_id = None
        self.device_fingerprint = str(uuid.getnode())

    def validate(self) -> dict:
        r = requests.post(f"{self.api_base}/license/validate", json={
            "license_key": self.license_key,
            "product_id": self.product_id,
            "device_fingerprint": self.device_fingerprint,
        }, timeout=10)
        data = r.json()
        if data.get("valid"):
            self.session_id = data.get("session_id")
        return data

    def heartbeat(self) -> dict:
        if not self.session_id:
            return {"valid": False, "status": "no_session"}
        r = requests.post(f"{self.api_base}/license/heartbeat", json={
            "session_id": self.session_id,
            "license_key": self.license_key,
        }, timeout=10)
        return r.json()

    def deactivate(self) -> dict:
        if not self.session_id:
            return {"success": True}
        r = requests.post(f"{self.api_base}/license/deactivate", json={
            "session_id": self.session_id,
            "license_key": self.license_key,
        }, timeout=10)
        self.session_id = None
        return r.json()
```

### Usage
```python
license = SomniLicense(
    api_base="https://dash.example.com/api",
    license_key="SMNI-XXXX-XXXX-XXXX-XXXX",
    product_id="your-product-uuid",
)

result = license.validate()
if result["valid"]:
    print("Licensed!", result.get("features"))
```

---

## C# / .NET

```csharp
using System.Net.Http.Json;

public class SomniLicense : IDisposable
{
    private readonly HttpClient _http = new();
    private readonly string _apiBase;
    private readonly string _key;
    private readonly string _productId;
    private string? _sessionId;

    public SomniLicense(string apiBase, string key, string productId)
    {
        _apiBase = apiBase.TrimEnd('/');
        _key = key;
        _productId = productId;
    }

    public async Task<ValidationResult> ValidateAsync()
    {
        var resp = await _http.PostAsJsonAsync($"{_apiBase}/license/validate", new
        {
            license_key = _key,
            product_id = _productId,
            device_fingerprint = Environment.MachineName,
        });
        var result = await resp.Content.ReadFromJsonAsync<ValidationResult>();
        if (result?.Valid == true) _sessionId = result.SessionId;
        return result!;
    }

    public async Task DeactivateAsync()
    {
        if (_sessionId == null) return;
        await _http.PostAsJsonAsync($"{_apiBase}/license/deactivate", new
        {
            session_id = _sessionId,
            license_key = _key,
        });
        _sessionId = null;
    }

    public void Dispose() => _http.Dispose();
}

public record ValidationResult(
    bool Valid,
    string Status,
    string[]? Features,
    string? Tier,
    string? SessionId,
    int? HeartbeatIntervalSeconds
);
```

---

## Rust

```rust
use reqwest::Client;
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
struct ValidateRequest {
    license_key: String,
    product_id: String,
    device_fingerprint: Option<String>,
}

#[derive(Deserialize, Debug)]
pub struct ValidationResponse {
    pub valid: bool,
    pub status: String,
    pub features: Option<Vec<String>>,
    pub tier: Option<String>,
    pub session_id: Option<String>,
    pub heartbeat_interval_seconds: Option<u32>,
    pub error: Option<String>,
}

pub struct SomniLicense {
    client: Client,
    api_base: String,
    key: String,
    product_id: String,
    session_id: Option<String>,
}

impl SomniLicense {
    pub fn new(api_base: &str, key: &str, product_id: &str) -> Self {
        Self {
            client: Client::new(),
            api_base: api_base.trim_end_matches('/').to_string(),
            key: key.to_string(),
            product_id: product_id.to_string(),
            session_id: None,
        }
    }

    pub async fn validate(&mut self) -> Result<ValidationResponse, reqwest::Error> {
        let resp: ValidationResponse = self.client
            .post(format!("{}/license/validate", self.api_base))
            .json(&ValidateRequest {
                license_key: self.key.clone(),
                product_id: self.product_id.clone(),
                device_fingerprint: Some(hostname::get().unwrap().to_string_lossy().to_string()),
            })
            .send()
            .await?
            .json()
            .await?;

        if resp.valid {
            self.session_id = resp.session_id.clone();
        }
        Ok(resp)
    }
}
```

---

## General REST Integration

For any language, the API is three endpoints:

1. `POST /api/license/validate` — Validate key & register device
2. `POST /api/license/heartbeat` — Keep session alive
3. `POST /api/license/deactivate` — Release device slot

All accept and return JSON. No authentication headers needed — the license key itself is the credential.
