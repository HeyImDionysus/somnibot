import type { FixtureId } from './schema';

export type ReferenceCommand = {
  readonly executable: string;
  readonly args: readonly string[];
};

export type ReferenceIntegration = {
  readonly files: Readonly<Record<string, string>>;
  readonly compile: ReferenceCommand;
  readonly behavior: ReferenceCommand;
  readonly credentialKind: 'runtime-license-key' | 'server-delivery-secret';
};

const NODE_GATE = `import { readFileSync } from 'node:fs';
const sdk = JSON.parse(readFileSync(new URL('./somnibot-sdk.json', import.meta.url), 'utf8'));
export class LicenseGate {
  #features = new Set(); #offlineUntil = 0; #active = false;
  activate(licenseKey, status, features, offlineUntil) { if (!licenseKey) return false; const policy = sdk.statusPolicy[status]; this.#active = policy?.class === 'live' || policy?.class === 'live_warning'; this.#features = this.#active ? new Set(features) : new Set(); this.#offlineUntil = this.#active ? offlineUntil : 0; return this.#active; }
  canUse(feature) { return this.#active && this.#features.has(feature); }
  networkFailure(now) { return this.#active && now < this.#offlineUntil; }
  revoke() { this.#active = false; this.#features.clear(); this.#offlineUntil = 0; }
  deactivate() { this.revoke(); }
  retry(status, attempt) { return sdk.statusPolicy[status]?.class === 'indeterminate' && attempt < sdk.runtime.retry.maxAttemptsPerOperation; }
  safeMessage(status) { return 'SomniBot licensing: ' + status; }
}`;

function nodeReference(capability: string, surface: string): ReferenceIntegration {
  return {
    files: {
      'license-gate.mjs': NODE_GATE,
      'license-gate.test.mjs': `import test from 'node:test'; import assert from 'node:assert/strict'; import { LicenseGate } from './license-gate.mjs';
test('${surface} licensing lifecycle', () => { const gate = new LicenseGate(); assert.equal(gate.canUse('${capability}'), false); assert.equal(gate.activate(process.env.SOMNI_TEST_LICENSE_KEY, 'active', ['${capability}'], 2000), true); assert.equal(gate.canUse('${capability}'), true); assert.equal(gate.networkFailure(1999), true); assert.equal(gate.networkFailure(2000), false); assert.equal(gate.retry('rate_limited', 1), true); assert.equal(gate.retry('revoked', 1), false); gate.revoke(); assert.equal(gate.canUse('${capability}'), false); gate.deactivate(); assert.doesNotMatch(gate.safeMessage('revoked'), /license[_-]?key|session[_-]?id/i); });`,
    },
    compile: { executable: 'node', args: ['--check', 'license-gate.mjs'] },
    behavior: { executable: 'node', args: ['--test', 'license-gate.test.mjs'] },
    credentialKind: 'runtime-license-key',
  };
}

const PYTHON_REFERENCE: ReferenceIntegration = {
  files: {
    'license_gate.py': `import json
from pathlib import Path
SDK = json.loads(Path(__file__).with_name("somnibot-sdk.json").read_text(encoding="utf-8"))
class LicenseGate:
    def __init__(self): self.active=False; self.features=set(); self.offline_until=0
    def activate(self, license_key, status, features, offline_until):
        if not license_key: return False
        policy=SDK["statusPolicy"].get(status, {}); self.active=policy.get("class") in ("live", "live_warning"); self.features=set(features) if self.active else set(); self.offline_until=offline_until if self.active else 0; return self.active
    def can_use(self, feature): return self.active and feature in self.features
    def network_failure(self, now): return self.active and now < self.offline_until
    def retry(self, status, attempt): return SDK["statusPolicy"].get(status, {}).get("class") == "indeterminate" and attempt < SDK["runtime"]["retry"]["maxAttemptsPerOperation"]
    def deactivate(self): self.active=False; self.features.clear(); self.offline_until=0
    def safe_message(self, status): return f"SomniBot licensing: {status}"`,
    'test_license_gate.py': `import os, unittest
from license_gate import LicenseGate
class GateTest(unittest.TestCase):
    def test_lifecycle(self):
        gate=LicenseGate(); self.assertFalse(gate.can_use("batch_normalize")); self.assertTrue(gate.activate(os.environ["SOMNI_TEST_LICENSE_KEY"], "active", ["batch_normalize"], 2000)); self.assertTrue(gate.can_use("batch_normalize")); self.assertTrue(gate.network_failure(1999)); self.assertFalse(gate.network_failure(2000)); self.assertTrue(gate.retry("rate_limited", 1)); self.assertFalse(gate.retry("revoked", 1)); gate.deactivate(); self.assertFalse(gate.can_use("batch_normalize")); self.assertNotIn("license_key", gate.safe_message("revoked"))
if __name__ == "__main__": unittest.main()`,
  },
  compile: { executable: 'python', args: ['-m', 'py_compile', 'license_gate.py', 'test_license_gate.py'] },
  behavior: { executable: 'python', args: ['-m', 'unittest', '-v', 'test_license_gate.py'] },
  credentialKind: 'runtime-license-key',
};

const GO_REFERENCE: ReferenceIntegration = {
  files: {
    'go.mod': 'module example.com/somnibot-reference\n\ngo 1.25',
    'license_gate.go': `package licensegate
import ("encoding/json"; "os")
type Policy struct { Class string \`json:"class"\` }; type Retry struct { Max int \`json:"maxAttemptsPerOperation"\` }; type SDK struct { Status map[string]Policy \`json:"statusPolicy"\`; Runtime struct { Retry Retry \`json:"retry"\` } \`json:"runtime"\` }
type Gate struct { sdk SDK; active bool; features map[string]bool; offlineUntil int64 }
func Load(path string) (*Gate,error) { b,e:=os.ReadFile(path); if e!=nil{return nil,e}; var sdk SDK; if e=json.Unmarshal(b,&sdk);e!=nil{return nil,e}; return &Gate{sdk:sdk,features:map[string]bool{}},nil }
func (g *Gate) Activate(key,status string, features []string, until int64) bool { if key=="" {return false}; p,ok:=g.sdk.Status[status]; g.active=ok&&(p.Class=="live"||p.Class=="live_warning"); g.features=map[string]bool{}; if g.active { for _,f:=range features { g.features[f]=true }; g.offlineUntil=until }; return g.active }
func (g *Gate) CanUse(f string) bool{return g.active&&g.features[f]}; func(g *Gate) Offline(now int64)bool{return g.active&&now<g.offlineUntil}; func(g *Gate) Retry(s string,a int)bool{return g.sdk.Status[s].Class=="indeterminate"&&a<g.sdk.Runtime.Retry.Max}; func(g *Gate) Deactivate(){g.active=false;g.features=map[string]bool{};g.offlineUntil=0}`,
    'license_gate_test.go': `package licensegate
import ("os";"testing")
func TestLifecycle(t *testing.T){g,e:=Load("somnibot-sdk.json");if e!=nil{t.Fatal(e)};if g.CanUse("depot_export"){t.Fatal("fresh install open")};if !g.Activate(os.Getenv("SOMNI_TEST_LICENSE_KEY"),"active",[]string{"depot_export"},2000)||!g.CanUse("depot_export"){t.Fatal("activation failed")};if !g.Offline(1999)||g.Offline(2000){t.Fatal("offline bound failed")};if !g.Retry("rate_limited",1)||g.Retry("revoked",1){t.Fatal("retry policy failed")};g.Deactivate();if g.CanUse("depot_export"){t.Fatal("deactivation failed")}}`,
  },
  compile: { executable: 'go', args: ['test', '-run', '^$', './...'] },
  behavior: { executable: 'go', args: ['test', '-v', './...'] },
  credentialKind: 'runtime-license-key',
};

const CSHARP_REFERENCE: ReferenceIntegration = {
  files: {
    'HarborPatrol.Reference.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net9.0</TargetFramework><Nullable>enable</Nullable><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>',
    'Program.cs': `using System.Text.Json;
var json=JsonDocument.Parse(File.ReadAllText("somnibot-sdk.json")); var root=json.RootElement; var max=root.GetProperty("runtime").GetProperty("retry").GetProperty("maxAttemptsPerOperation").GetInt32();
var gate=new LicenseGate(root,max); Check(!gate.CanUse("patrol_create")); Check(gate.Activate(Environment.GetEnvironmentVariable("SOMNI_TEST_LICENSE_KEY"),"active",["patrol_create"],2000)); Check(gate.CanUse("patrol_create")); Check(gate.Offline(1999)&&!gate.Offline(2000)); Check(gate.Retry("rate_limited",1)&&!gate.Retry("revoked",1)); gate.Deactivate(); Check(!gate.CanUse("patrol_create")); Console.WriteLine("REFERENCE_BEHAVIOR_PASS");
static void Check(bool value){if(!value)throw new InvalidOperationException("reference behavior failed");}
sealed class LicenseGate(JsonElement sdk,int max){bool active;long until;HashSet<string> features=[];public bool Activate(string? key,string status,string[] grants,long deadline){if(string.IsNullOrEmpty(key))return false;var kind=sdk.GetProperty("statusPolicy").GetProperty(status).GetProperty("class").GetString();active=kind is "live" or "live_warning";features=active?[..grants]:[];until=active?deadline:0;return active;}public bool CanUse(string f)=>active&&features.Contains(f);public bool Offline(long now)=>active&&now<until;public bool Retry(string status,int attempt)=>sdk.GetProperty("statusPolicy").GetProperty(status).GetProperty("class").GetString()=="indeterminate"&&attempt<max;public void Deactivate(){active=false;features.Clear();until=0;}}`,
  },
  compile: { executable: 'dotnet', args: ['build', 'HarborPatrol.Reference.csproj', '--nologo'] },
  behavior: { executable: 'dotnet', args: ['run', '--no-build', '--project', 'HarborPatrol.Reference.csproj'] },
  credentialKind: 'runtime-license-key',
};

const STATIC_DELIVERY_REFERENCE: ReferenceIntegration = {
  files: {
    'delivery.mjs': `import { createHmac } from 'node:crypto'; import { readFileSync } from 'node:fs';
const sdk=JSON.parse(readFileSync(new URL('./somnibot-sdk.json',import.meta.url),'utf8'));
export class StaticDelivery { #used=new Set();
  constructor(secret){if(!secret)throw new Error('delivery secret required');this.secret=secret;if(sdk.project.legacyMode!=='static'||!sdk.rails.downloadableFiles||sdk.rails.runtimeLicensing)throw new Error('static delivery contract required');}
  deliver({token,entitlementRef,expiresAt,now,revoked,master}){if(revoked||now>=expiresAt||this.#used.has(token))throw new Error('delivery unavailable');this.#used.add(token);const mark=createHmac('sha256',this.secret).update(entitlementRef+':'+master).digest('hex').slice(0,16);return {artifact:master+'\\n<!-- delivery:'+mark+' -->',manifest:{entitlementRef,mark,expiresAt}};}
  retry(status,attempt){return status===429&&attempt<3;}
}`,
    'delivery.test.mjs': `import test from 'node:test';import assert from 'node:assert/strict';import {StaticDelivery} from './delivery.mjs';
test('delivery-time protection has no in-project activation',()=>{const delivery=new StaticDelivery(process.env.SOMNI_TEST_DELIVERY_SECRET);const request={token:'once',entitlementRef:'entitlement-test',expiresAt:2000,now:1000,revoked:false,master:'<nav>Notes</nav><button>New note</button>'};const output=delivery.deliver(request);assert.match(output.artifact,/Notes/);assert.doesNotMatch(JSON.stringify(output),/SERVER-DELIVERY-SECRET/);assert.throws(()=>delivery.deliver(request));assert.throws(()=>delivery.deliver({...request,token:'expired',now:2000}));assert.throws(()=>delivery.deliver({...request,token:'revoked',revoked:true}));assert.equal(delivery.retry(429,1),true);assert.equal(delivery.retry(429,3),false);});`,
  },
  compile: { executable: 'node', args: ['--check', 'delivery.mjs'] },
  behavior: { executable: 'node', args: ['--test', 'delivery.test.mjs'] },
  credentialKind: 'server-delivery-secret',
};

export function referenceIntegrationFor(fixtureId: FixtureId): ReferenceIntegration {
  switch (fixtureId) {
    case 'electron-desktop': return nodeReference('premium_export', 'Electron window');
    case 'rust-oxide-plugin': return CSHARP_REFERENCE;
    case 'python-service': return PYTHON_REFERENCE;
    case 'hosted-web-app': return nodeReference('campaign_publish', 'hosted web route');
    case 'command-line-tool': return GO_REFERENCE;
    case 'static-files-site': return STATIC_DELIVERY_REFERENCE;
  }
}
