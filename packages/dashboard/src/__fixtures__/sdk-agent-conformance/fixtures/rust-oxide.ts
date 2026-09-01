import { freezeProject } from '../freeze-project';

export const RUST_OXIDE_PROJECT = freezeProject({
  fixtureId: 'rust-oxide-plugin', revision: 1, displayName: 'Harbor Patrol',
  stack: 'C# 12 Oxide/uMod plugin for Rust', projectRoot: 'HarborPatrol', protectionMode: 'runtime',
  build: { command: 'dotnet build HarborPatrol.csproj -c Release', expectedExitCode: 0, observable: 'bin/Release/netstandard2.1/HarborPatrol.dll exists without compiler warnings' },
  smoke: { command: 'dotnet test HarborPatrol.Tests/HarborPatrol.Tests.csproj', expectedExitCode: 0, observable: 'Patrol creation, authorization, and cleanup tests pass' },
  files: [
    { path: 'HarborPatrol.csproj', purpose: 'Deterministic plugin compilation', content: '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>netstandard2.1</TargetFramework><Nullable>enable</Nullable></PropertyGroup></Project>' },
    { path: 'HarborPatrol.cs', purpose: 'Player commands and server hooks', content: 'namespace Oxide.Plugins; public sealed class HarborPatrol { public string CreatePatrol(string playerId, string harborId) => $"patrol:{playerId}:{harborId}"; public bool CanRecall(string ownerId, string actorId) => ownerId == actorId; }' },
    { path: 'HarborPatrol.Tests/PatrolTests.cs', purpose: 'Completed behavior smoke coverage', content: 'public sealed class PatrolTests { [Fact] public void OwnerCanRecall() => Assert.True(new HarborPatrol().CanRecall("1", "1")); }' },
  ],
  preservedBehaviors: ['Authorized players create one patrol at a harbor', 'Only the patrol owner or an administrator can recall it'],
  activationSurface: { kind: 'chat-command', entrypoint: '/harborlicense <key>', successObservable: 'The invoking administrator receives an activation confirmation', denialObservable: 'The command reports the stable denial reason without echoing the key' },
  structuralCapabilities: ['patrol_create', 'patrol_admin_recall'],
  offlinePolicy: { maximumSeconds: 21600, trustedTimeRequired: true, freshInstallFailsClosed: true },
});
