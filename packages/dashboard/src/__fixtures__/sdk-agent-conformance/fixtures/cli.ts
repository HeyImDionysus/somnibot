import { freezeProject } from '../freeze-project';

export const CLI_PROJECT = freezeProject({
  fixtureId: 'command-line-tool', revision: 1, displayName: 'Depot Inspector',
  stack: 'Go 1.25 + Cobra', projectRoot: 'depot-inspector', protectionMode: 'runtime',
  build: { command: 'go test ./... && go build -o dist/depot ./cmd/depot', expectedExitCode: 0, observable: 'dist/depot exists and the Go race-safe tests pass' },
  smoke: { command: './dist/depot inspect testdata/depot.json', expectedExitCode: 0, observable: 'Prints the stable package count and exits zero' },
  files: [
    { path: 'go.mod', purpose: 'Pinned CLI module', content: 'module example.com/depot-inspector\n\ngo 1.25' },
    { path: 'cmd/depot/main.go', purpose: 'Completed command surface', content: 'package main\nimport ("fmt"; "os")\nfunc main() { if len(os.Args) < 3 || os.Args[1] != "inspect" { os.Exit(2) }; fmt.Println("packages=3") }' },
    { path: 'testdata/depot.json', purpose: 'Deterministic smoke input', content: '{"packages":["alpha","beta","gamma"]}' },
  ],
  preservedBehaviors: ['Inspect prints a deterministic package summary', 'Invalid commands return a nonzero exit code without modifying the depot file'],
  activationSurface: { kind: 'terminal-prompt', entrypoint: 'depot activate', successObservable: 'Prints Activated without printing the key or session id', denialObservable: 'Prints the denial category to stderr and exits nonzero' },
  structuralCapabilities: ['depot_export', 'depot_policy_scan'],
  offlinePolicy: { maximumSeconds: 43200, trustedTimeRequired: true, freshInstallFailsClosed: true },
});
