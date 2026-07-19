import { defineConfig } from 'vitest/config';
import ts from 'typescript';

const useInProcessTypeScript = process.env.SOMNIBOT_VITEST_IN_PROCESS_TS === '1';

// Restricted Windows runners prohibit esbuild's helper process. This optional
// transform preserves the same TypeScript-to-ESM behavior entirely in-process.
// Bracket notation keeps Vite's SSR define pass from spawning esbuild merely to
// rewrite process.env while retaining the real Node environment at runtime.
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
  esbuild: useInProcessTypeScript ? false : undefined,
  plugins: useInProcessTypeScript ? [inProcessTypeScriptPlugin] : undefined,
  resolve: {
    preserveSymlinks: useInProcessTypeScript,
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    exclude: ['src/__tests__/integration/**'],
    testTimeout: 10_000,
    // V5 Audit §13.3: Removed retry:1. Masking flaky tests prevents root-cause
    // fixes. Tests should be deterministic — mock external dependencies properly
    // instead of retrying on failure.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/__tests__/**', 'src/index.ts'],
    },
  },
});
