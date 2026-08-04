import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(import.meta.dirname, '..', 'app', '(dashboard)', 'store', 'page.tsx'), 'utf8');

describe('store free product form', () => {
  it('offers free type and forces zero price', () => {
    expect(source).toContain("<option value=\"free\">Free</option>");
    expect(source).toContain("form.type === 'free' ? 0");
    expect(source).toContain("e.target.value === 'free' ? '0.00'");
  });
});
