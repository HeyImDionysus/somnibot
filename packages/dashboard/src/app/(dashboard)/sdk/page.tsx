import { LicensingPromptGenerator } from '@/components/licensing/licensing-prompt-generator';

export default function SdkPage() {
  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-bold text-discord-text-primary">SomniBot SDK</h1>
        <p className="mt-1 max-w-3xl text-sm text-discord-text-muted">
          Generate a repository-preserving SomniBot licensing integration contract for an AI agent or developer. The SDK reads authoritative Store policy when provided, but never saves or changes products.
        </p>
      </header>
      <LicensingPromptGenerator />
    </div>
  );
}
