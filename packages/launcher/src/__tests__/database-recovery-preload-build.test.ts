import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('keeps preload CommonJS compilation from overwriting live ESM recovery modules', () => {
  // Given the actual preload compiler configuration and newly exposed recovery types.
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const config = ts.readConfigFile(path.join(root, 'tsconfig.preload.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  // When TypeScript builds its source graph without emitting files.
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
  const emittedSources = program.getSourceFiles().filter((file) => !file.isDeclarationFile).map((file) => path.basename(file.fileName));
  // Then only preload.ts is an emit candidate, never the live main-process contract.
  expect(emittedSources).toEqual(['preload.ts']);
}, 30_000);
