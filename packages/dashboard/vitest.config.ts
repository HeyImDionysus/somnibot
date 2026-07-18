import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const configDir = path.dirname(fileURLToPath(import.meta.url));
const useInProcessTypeScript = process.env.SOMNIBOT_VITEST_IN_PROCESS_TS === '1';

// Vite's SSR define pass invokes esbuild whenever it sees process.env. Express
// the identical Node lookup with bracket notation in the restricted runner so
// the define pass is a no-op and the real environment remains observable.
const preserveProcessEnvironment: ts.TransformerFactory<ts.SourceFile> = (context) => {
  const isProcessReference = (node: ts.Expression): boolean => {
    if (ts.isIdentifier(node)) return node.text === 'process';
    return ts.isPropertyAccessExpression(node)
      && node.name.text === 'process'
      && ts.isIdentifier(node.expression)
      && (node.expression.text === 'global' || node.expression.text === 'globalThis');
  };
  const visit = (node: ts.Node): ts.VisitResult<ts.Node> => {
    if (ts.isPropertyAccessExpression(node)
      && node.name.text === 'env'
      && isProcessReference(node.expression)) {
      return ts.factory.createElementAccessExpression(
        ts.factory.createIdentifier('process'),
        ts.factory.createStringLiteral('env'),
      );
    }
    return ts.visitEachChild(node, visit, context);
  };
  return (sourceFile) => ts.visitNode(sourceFile, visit) as ts.SourceFile;
};

const inProcessTypeScriptPlugin = {
  name: 'somnibot:in-process-typescript',
  enforce: 'pre' as const,
  transform(source: string, id: string) {
    const file = id.split('?', 1)[0];
    if (!file || file.includes('/node_modules/') || !/\.[cm]?tsx?$/.test(file)) {
      return null;
    }
    const result = ts.transpileModule(source, {
      fileName: file,
      transformers: { before: [preserveProcessEnvironment] },
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
        isolatedModules: true,
        sourceMap: true,
      },
    });
    return {
      code: result.outputText,
      map: result.sourceMapText ? JSON.parse(result.sourceMapText) : null,
    };
  },
};

export default defineConfig({
  // The standard Vite/esbuild path remains the default. Restricted Windows
  // runners can opt into an equivalent in-process TS transpile because they
  // prohibit every child process, including esbuild's helper binary.
  esbuild: useInProcessTypeScript ? false : undefined,
  plugins: useInProcessTypeScript ? [inProcessTypeScriptPlugin] : undefined,
  test: {
    environment: 'node',
    globals: true,
    include: ['src/__tests__/**/*.test.ts'],
    exclude: ['src/__tests__/smoke/**'],
    // V5 Audit §13.1: Coverage gate for dashboard — matches the CI threshold.
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/**/*.d.ts'],
      thresholds: {
        statements: 70,
      },
    },
  },
  resolve: {
    // Keep test resolution inside Node/Vite. On Windows, Vite's default
    // realpath optimization shells out to `net use`; that is unnecessary for
    // this workspace and prevents tests in restricted, non-networked runners.
    preserveSymlinks: useInProcessTypeScript,
    alias: {
      '@': path.resolve(configDir, 'src'),
    },
  },
});
