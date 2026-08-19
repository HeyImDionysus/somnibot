import { LicensingPromptGenerator } from '@/components/licensing/licensing-prompt-generator';

export default function ProjectLicensingPage() {
  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-bold text-discord-text-primary">Project Licensing Prompt</h1>
        <p className="mt-1 max-w-3xl text-sm text-discord-text-muted">
          Attach SomniBot licensing to an already-completed project while preserving its repository, architecture, and behavior. This page never saves or changes Store products.
        </p>
      </header>
      <LicensingPromptGenerator />
    </div>
  );
}
