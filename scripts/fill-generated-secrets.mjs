/**
 * Fill the machine-generated secrets in a freshly created .env.
 *
 * Setup used to print "generate each with: openssl rand -hex 32" and leave the
 * operator to it — four times, before anything would boot. That is busywork on
 * mac/Linux and a dead end on Windows, which does not ship openssl at all, so
 * following scripts/setup.bat exactly could not produce a working .env.
 *
 * None of these values are a choice the operator makes: they are random bytes.
 * Node is already a hard prerequisite of setup, so generate them here and leave
 * only the genuinely human fields (tokens, URLs) to be pasted in.
 *
 * Existing values are never overwritten — re-running setup must not invalidate
 * sessions or lock the bot out of a Lavalink container that already has the old
 * password baked in.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * key → byte length (hex output is twice this).
 *
 * Every secret the docs told the operator to produce with `openssl rand -hex`.
 * Kept in one place so a value cannot be documented as self-generated in
 * DEPLOYMENT.md or CREDENTIAL_ROTATION.md while nothing actually generates it.
 */
const GENERATED = {
  CSRF_SECRET: 32,
  NEXTAUTH_SECRET: 32,
  WEBHOOK_REPLAY_SECRET: 32,
  DOWNLOAD_SIGNING_SECRET: 32,
  LAVALINK_PASSWORD: 16,
  VALKEY_PASSWORD: 16,
};

/** Placeholder text from .env.example that must not be treated as a real value. */
function isPlaceholder(value) {
  const v = value.trim();
  if (!v) return true;
  return /^(generate|paste|your|change|replace|<|xxx)/i.test(v);
}

const envPath = process.argv[2] ?? '.env';
if (!existsSync(envPath)) {
  console.error(`  ⚠️  ${envPath} not found — skipping secret generation.`);
  process.exit(0);
}

let text = readFileSync(envPath, 'utf8');
const filled = [];

for (const [key, bytes] of Object.entries(GENERATED)) {
  const line = new RegExp(`^${key}=(.*)$`, 'm');
  const match = line.exec(text);
  const secret = randomBytes(bytes).toString('hex');

  if (match) {
    if (!isPlaceholder(match[1])) continue; // already set by the operator
    text = text.replace(line, `${key}=${secret}`);
  } else {
    text += `${text.endsWith('\n') ? '' : '\n'}${key}=${secret}\n`;
  }
  filled.push(key);
}

if (filled.length > 0) {
  writeFileSync(envPath, text);
  console.log(`  ✅ Generated ${filled.length} secret(s): ${filled.join(', ')}`);
} else {
  console.log('  ✅ Secrets already set — left unchanged');
}
