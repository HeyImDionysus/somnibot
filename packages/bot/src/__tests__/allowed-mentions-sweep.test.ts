/**
 * Mass-ping guard: every channel send that carries `content` must declare
 * `allowedMentions`.
 *
 * THE RISK THIS CLOSES: several sends interpolate owner-authored templates or
 * user-supplied text straight into `content` — the welcome message, an
 * achievement name, a giveaway announcement, a starboard header. Without an
 * explicit `allowedMentions`, Discord honours whatever is in the string, so a
 * template containing `@everyone` turned every single join into a server-wide
 * ping.
 *
 * The rule is NOT "never mention anyone" — a welcome greeting pinging the new
 * member, or a giveaway pinging its winners, is the entire point. It is
 * "declare the intent": `parse: ['users']` where a member ping is wanted,
 * `parse: []` where nothing should ping. Either is fine; silence is not.
 *
 * This is a source-shape test rather than a behavioural one because the failure
 * mode is a MISSING option — there is nothing to observe at runtime until it
 * has already pinged a whole server.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Find `.send({ ... content: ... })` / `.edit({ ... })` calls whose options
 * object carries `content` but no `allowedMentions`.
 *
 * Deliberately conservative: it only inspects a bounded window after the call
 * so a nested unrelated object cannot mask a missing option, and it ignores
 * interaction replies (ephemeral, already scoped to the invoker).
 */
function unguardedSends(source: string): string[] {
  const hits: string[] = [];
  const call = /\.(send|edit)\(\{/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(source)) !== null) {
    // Walk to the matching close brace so the window is the actual options object.
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') depth--;
      i++;
    }
    const options = source.slice(m.index, i);
    if (!/\bcontent\s*:/.test(options)) continue;
    if (/allowedMentions/.test(options)) continue;
    hits.push(options.slice(0, 90).replace(/\s+/g, ' '));
  }
  return hits;
}

describe('allowedMentions coverage', () => {
  it('every content-bearing channel send declares its mention intent', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const source = readFileSync(file, 'utf8');
      for (const hit of unguardedSends(source)) {
        offenders.push(`${path.relative(SRC, file)}: ${hit}`);
      }
    }

    expect(
      offenders,
      'These sends interpolate text into content without declaring allowedMentions. '
      + "Add { parse: ['users'] } if a member ping is intended, or { parse: [] } if nothing should ping:\n"
      + offenders.join('\n'),
    ).toEqual([]);
  });

  it('the surfaces that ping a member on purpose still do', () => {
    // Guard against someone "fixing" this test by blanket-disabling mentions,
    // which would silently break the welcome greeting and giveaway winners.
    const welcome = readFileSync(path.join(SRC, 'features', 'welcome', 'welcome-service.ts'), 'utf8');
    expect(welcome).toMatch(/allowedMentions:\s*\{\s*parse:\s*\['users'\]\s*\}/);

    const giveaway = readFileSync(path.join(SRC, 'features', 'giveaways', 'giveaway-manager.ts'), 'utf8');
    expect(giveaway).toMatch(/allowedMentions:\s*\{\s*parse:\s*\['users'\]\s*\}/);
  });

  it('the starboard pings nobody — it is a record, not a notification', () => {
    const starboard = readFileSync(path.join(SRC, 'features', 'starboard', 'index.ts'), 'utf8');
    const guards = starboard.match(/allowedMentions:\s*\{\s*parse:\s*\[\]\s*\}/g) ?? [];
    // Both the create and the edit path.
    expect(guards.length).toBeGreaterThanOrEqual(2);
  });
});
