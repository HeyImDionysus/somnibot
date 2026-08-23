import { freezeProject } from '../freeze-project';

export const PYTHON_PROJECT = freezeProject({
  fixtureId: 'python-service', revision: 1, displayName: 'Receipt Normalizer',
  stack: 'Python 3.13 + FastAPI + Pydantic v2', projectRoot: 'receipt-normalizer', protectionMode: 'runtime',
  build: { command: 'uv run basedpyright && uv run python -m compileall src', expectedExitCode: 0, observable: 'Strict type checking and bytecode compilation complete without errors' },
  smoke: { command: 'uv run pytest -q', expectedExitCode: 0, observable: 'Upload normalization and duplicate-receipt behavior tests pass' },
  files: [
    { path: 'pyproject.toml', purpose: 'Locked Python application and test commands', content: '[project]\nname="receipt-normalizer"\nrequires-python=">=3.13"\ndependencies=["fastapi","pydantic"]\n[tool.pytest.ini_options]\ntestpaths=["tests"]' },
    { path: 'src/receipts/api.py', purpose: 'Completed HTTP surface', content: 'from fastapi import FastAPI\nfrom pydantic import BaseModel\napp = FastAPI()\nclass Receipt(BaseModel):\n    merchant: str\n    total_cents: int\n@app.post("/normalize")\ndef normalize(receipt: Receipt) -> Receipt:\n    return receipt' },
    { path: 'tests/test_api.py', purpose: 'Behavioral smoke test', content: 'def test_normalize_preserves_total(client):\n    response = client.post("/normalize", json={"merchant":"Cafe","total_cents":1250})\n    assert response.json()["total_cents"] == 1250' },
  ],
  preservedBehaviors: ['Normalizes valid receipt uploads into typed JSON', 'Rejects malformed or negative receipt totals without persistence'],
  activationSurface: { kind: 'http-route', entrypoint: 'POST /license/activate', successObservable: 'Returns activated=true and the capability identifiers', denialObservable: 'Returns a typed non-secret denial with an appropriate HTTP status' },
  structuralCapabilities: ['batch_normalize', 'export_normalized_csv'],
  offlinePolicy: { maximumSeconds: 3600, trustedTimeRequired: true, freshInstallFailsClosed: true },
});
