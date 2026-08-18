import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';

const SHA_RE = /^[0-9a-f]{40}$/i;
const MANIFEST_RE = /^(?:fleet-)?shard-[1-4]\.json$/;
const SYNTHETIC_RE = /(?:synthetic|mock(?:ed)?|fake|fixture)/i;
const REAL_SENSOR_RE = /(?:discord|dashboard|paypal|launcher|supabase|postgres(?:ql)?|database|\bdb\b|\brls\b|audit|valkey|redis|lavalink|tailscale|https?|webhook|process|ssh|caddy|files?system)/i;

export function fail(message) {
  throw new Error(message);
}

export function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`could not read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function candidateSha(value, label) {
  const sha = requireString(value, label);
  if (!SHA_RE.test(sha)) fail(`${label} must be an exact 40-character candidate SHA`);
  return sha.toLowerCase();
}

export function gateKey(domainId, scenario, assertionClass) {
  return `${domainId}\0${scenario}\0${assertionClass}`;
}

export function collectGatedKeys(manifestDirectory, expectedSha) {
  if (!existsSync(manifestDirectory)) fail(`manifest directory does not exist: ${manifestDirectory}`);
  const files = readdirSync(manifestDirectory).filter((file) => MANIFEST_RE.test(file)).sort();
  if (files.length !== 4) fail(`expected exactly four shard manifests, found ${files.length}`);
  const expectedShards = new Set(['1/4', '2/4', '3/4', '4/4']);
  const seenShards = new Set();
  const gated = new Map();
  for (const file of files) {
    const manifest = readJson(path.join(manifestDirectory, file), file);
    if (manifest?.schemaVersion !== 2) fail(`unsupported manifest schema in ${file}`);
    if (candidateSha(manifest.candidateSha, `${file} candidateSha`) !== expectedSha) {
      fail(`${file} candidate SHA does not match expected candidate`);
    }
    const shard = requireString(manifest.shard, `${file} shard`);
    if (!expectedShards.has(shard) || seenShards.has(shard)) {
      fail(`manifests must contain one each of shards 1/4 through 4/4 (invalid or duplicate ${shard})`);
    }
    seenShards.add(shard);
    if (!Array.isArray(manifest.results)) fail(`${file} is missing results`);
    for (const result of manifest.results) {
      const domainId = requireString(result?.id, `${file} result id`);
      const gates = Array.isArray(result?.gates) ? result.gates : [];
      if (Number.isInteger(result?.gated) && result.gated !== gates.length) {
        fail(`${file}/${domainId} gate inventory does not match its gated count`);
      }
      for (const gate of gates) {
        const scenario = requireString(gate?.scenario, `${file}/${domainId} gate scenario`);
        const assertionClass = requireString(gate?.class ?? gate?.assertionClass, `${file}/${domainId} gate assertionClass`);
        const key = gateKey(domainId, scenario, assertionClass);
        if (gated.has(key)) fail(`duplicate GATED key in fleet manifests: ${domainId}/${scenario}/${assertionClass}`);
        gated.set(key, { domainId, scenario, assertionClass });
      }
    }
  }
  if (seenShards.size !== expectedShards.size) fail('manifests must contain one each of shards 1/4 through 4/4');
  return gated;
}

function portableArtifactTarget(artifactRoot, artifactPath, label) {
  const portablePath = requireString(artifactPath, `${label} artifact path`);
  const normalized = path.posix.normalize(portablePath);
  if (
    portablePath.includes('\\')
    || path.posix.isAbsolute(portablePath)
    || normalized !== portablePath
    || normalized === '.'
    || normalized.startsWith('../')
    || /^[a-z]:/i.test(portablePath)
  ) {
    fail(`${label} artifact path must be a normalized portable relative path`);
  }
  const root = path.resolve(artifactRoot);
  const target = path.resolve(root, ...portablePath.split('/'));
  if (!target.startsWith(`${root}${path.sep}`)) {
    fail(`${label} artifact path must remain under its artifact root`);
  }
  return { portablePath, target };
}

function remainsUnderRoot(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function verifiedArtifactFile(artifactRoot, portablePath, target, label) {
  const root = path.resolve(artifactRoot);
  if (!existsSync(root)) fail(`${label} artifact root does not exist: ${root}`);
  const realRoot = realpathSync(root);
  let cursor = root;
  for (const segment of portablePath.split('/')) {
    cursor = path.join(cursor, segment);
    if (!existsSync(cursor)) fail(`${label} artifact file does not exist: ${portablePath}`);
    if (lstatSync(cursor).isSymbolicLink()) {
      fail(`${label} artifact path must not contain symlinks: ${portablePath}`);
    }
  }
  const targetStat = lstatSync(target);
  if (!targetStat.isFile()) fail(`${label} artifact file does not exist: ${portablePath}`);
  const realTarget = realpathSync(target);
  if (!remainsUnderRoot(realRoot, realTarget)) {
    fail(`${label} artifact real path must remain under its artifact root`);
  }
  return realTarget;
}

function assertSafeOutputPath(outputRoot, portablePath, target) {
  const root = path.resolve(outputRoot);
  mkdirSync(root, { recursive: true });
  let cursor = root;
  for (const segment of portablePath.split('/')) {
    cursor = path.join(cursor, segment);
    if (!existsSync(cursor)) break;
    if (lstatSync(cursor).isSymbolicLink()) {
      fail(`output artifact path must not contain symlinks: ${portablePath}`);
    }
  }
  const realRoot = realpathSync(root);
  const existingAncestor = existsSync(target) ? target : path.dirname(target);
  if (existsSync(existingAncestor)) {
    const realAncestor = realpathSync(existingAncestor);
    if (realAncestor !== realRoot && !remainsUnderRoot(realRoot, realAncestor)) {
      fail(`output artifact real path must remain under its artifact root: ${portablePath}`);
    }
  }
}

export function validateObservationEntry(entry, options) {
  const label = requireString(options?.label, 'observation label');
  const artifactRoot = requireString(options?.artifactRoot, `${label} artifact root`);
  const sensor = requireString(entry?.sensor, `${label} sensor`);
  const observation = requireString(
    entry?.observedResult ?? entry?.observation ?? entry?.result ?? entry?.observed,
    `${label} observed result`,
  );
  const observedAt = requireString(entry?.observedAt, `${label} observedAt`);
  if (new Date(observedAt).toISOString() !== observedAt) {
    fail(`${label} observedAt must be a canonical ISO-8601 timestamp`);
  }
  const artifact = entry?.artifact;
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    fail(`${label} artifact must be a content-addressed artifact object`);
  }
  const expectedHash = requireString(artifact.sha256, `${label} artifact sha256`).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedHash)) fail(`${label} artifact sha256 must be 64 hexadecimal characters`);
  const { portablePath, target } = portableArtifactTarget(artifactRoot, artifact.path, label);
  const sourcePath = verifiedArtifactFile(artifactRoot, portablePath, target, label);
  const actualHash = createHash('sha256').update(readFileSync(sourcePath)).digest('hex');
  if (actualHash !== expectedHash) fail(`${label} artifact SHA-256 mismatch: ${portablePath}`);
  if (!REAL_SENSOR_RE.test(sensor)) fail(`ledger sensor is not a recognized real fleet sensor: ${sensor}`);
  if (SYNTHETIC_RE.test(sensor) || SYNTHETIC_RE.test(observation) || SYNTHETIC_RE.test(portablePath)) {
    fail(`synthetic/mock/fake/fixture evidence is not accepted for ${label}`);
  }
  return {
    proof: {
      sensor,
      observation,
      observedAt,
      artifact: { path: portablePath, sha256: expectedHash },
    },
    sourcePath,
  };
}

export function copyObservationArtifacts(observations, outputRoot) {
  const byPath = new Map();
  for (const observation of observations) {
    const artifact = observation.proof.artifact;
    const existing = byPath.get(artifact.path);
    if (existing && existing.proof.artifact.sha256 !== artifact.sha256) {
      fail(`conflicting artifact hashes for ${artifact.path}`);
    }
    byPath.set(artifact.path, observation);
  }
  for (const observation of byPath.values()) {
    const artifact = observation.proof.artifact;
    const { target } = portableArtifactTarget(outputRoot, artifact.path, artifact.path);
    if (target === observation.sourcePath) continue;
    assertSafeOutputPath(outputRoot, artifact.path, target);
    if (existsSync(target)) {
      verifiedArtifactFile(outputRoot, artifact.path, target, artifact.path);
      const existingHash = createHash('sha256').update(readFileSync(target)).digest('hex');
      if (existingHash !== artifact.sha256) fail(`output artifact collision: ${artifact.path}`);
      continue;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    assertSafeOutputPath(outputRoot, artifact.path, target);
    copyFileSync(observation.sourcePath, target);
    verifiedArtifactFile(outputRoot, artifact.path, target, artifact.path);
  }
}
