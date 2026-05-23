import { FlatCompat } from '@eslint/eslintrc';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

/** @type {import('eslint').Linter.Config[]} */
const config = [
  ...compat.extends('next/core-web-vitals'),
  {
    // Register the typescript-eslint plugin so existing
    // eslint-disable comments referencing @typescript-eslint/* rules
    // resolve without error, but don't enable any rules from it.
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
  },
  {
    ignores: ['.next/', 'node_modules/', 'out/'],
  },
];

export default config;
