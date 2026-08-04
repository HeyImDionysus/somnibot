export function requireSuccessfulMigrations(errors: readonly string[]): void {
  if (errors.length === 0) return;

  throw new Error(`Database migrations failed: ${errors.join('; ')}`);
}
