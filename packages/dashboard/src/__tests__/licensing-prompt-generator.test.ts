import { describe, expect, it } from 'vitest';
import {
  buildLicensingPromptEnvelope,
  extractLicensingPromptEnvelope,
  PROJECT_SURFACE_COVERAGE,
  renderLicensingPrompt,
  type LicensingPromptDraft,
} from '@/lib/store/licensing-prompt';

const dynamicDraft: LicensingPromptDraft = {
  mode: 'dynamic',
  projectName: 'Server Sentinel',
  projectContext: 'A Rust plugin loaded by a dedicated game server.',
  productId: '',
  apiBase: 'https://somnibot.example/api',
  billingModel: 'subscription',
  plansAndFeatures: 'Standard grants alerts; Pro grants alerts and automation.',
  featureFlags: 'alerts, automation, alerts',
  outputFormats: '',
  installationIdentity: 'One installation is one game-server deployment.',
  maxInstallations: 3,
  heartbeatSeconds: 300,
  offlineGraceSeconds: 86_400,
};

describe('licensing prompt generator contract', () => {
  it('preserves a dynamic project configuration in the machine-readable envelope', () => {
    // Given a free-form project that does not come from a fixed catalogue
    // When the prompt envelope is built
    const envelope = buildLicensingPromptEnvelope(dynamicDraft);

    // Then every owner-controlled licensing decision remains explicit
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      mode: 'dynamic',
      project: {
        name: 'Server Sentinel',
        context: 'A Rust plugin loaded by a dedicated game server.',
        productId: null,
      },
      billing: {
        model: 'subscription',
        plansAndFeatures: 'Standard grants alerts; Pro grants alerts and automation.',
      },
      dynamicPolicy: {
        installationIdentity: 'One installation is one game-server deployment.',
        maxInstallations: 3,
        heartbeatSeconds: 300,
        offlineGraceSeconds: 86_400,
        featureFlags: ['alerts', 'automation'],
      },
      staticPolicy: null,
    });
  });

  it('accepts free billing and normalizes older version-one envelopes without feature flags', () => {
    const freeEnvelope = buildLicensingPromptEnvelope({
      ...dynamicDraft,
      billingModel: 'free',
      featureFlags: '',
    });

    expect(freeEnvelope.billing.model).toBe('free');
    expect(freeEnvelope.dynamicPolicy?.featureFlags).toEqual([]);

    const legacyPrompt = renderLicensingPrompt(freeEnvelope).replace(
      ',\n    "featureFlags": []',
      '',
    );
    expect(extractLicensingPromptEnvelope(legacyPrompt).dynamicPolicy?.featureFlags).toEqual([]);
  });

  it('rejects policy values that the Store cannot save', () => {
    expect(() => buildLicensingPromptEnvelope({ ...dynamicDraft, maxInstallations: 101 })).toThrow();
    expect(() => buildLicensingPromptEnvelope({ ...dynamicDraft, offlineGraceSeconds: 604_801 })).toThrow();
  });

  it('round-trips the structured envelope embedded in the copied prompt', () => {
    // Given a complete owner configuration
    const envelope = buildLicensingPromptEnvelope(dynamicDraft);

    // When the reusable prompt is rendered and parsed
    const copiedPrompt = renderLicensingPrompt(envelope);
    const parsed = extractLicensingPromptEnvelope(copiedPrompt);

    // Then an AI or developer receives the exact configuration without prose inference
    expect(parsed).toEqual(envelope);
  });

  it('keeps Store fulfillment configuration out of generated project prompts', () => {
    const dynamicPrompt = renderLicensingPrompt(buildLicensingPromptEnvelope(dynamicDraft));
    const staticPrompt = renderLicensingPrompt(buildLicensingPromptEnvelope({
      ...dynamicDraft,
      mode: 'static',
      outputFormats: 'PDF and PNG',
    }));

    for (const prompt of [dynamicPrompt, staticPrompt]) {
      expect(prompt).not.toMatch(/Discord benefit/i);
      expect(prompt).not.toMatch(/role ids?/i);
      expect(prompt).not.toMatch(/channel ids?/i);
    }
  });

  it('routes static projects without inventing dynamic runtime policy', () => {
    // Given a static product with several unrelated output formats
    const staticDraft: LicensingPromptDraft = {
      ...dynamicDraft,
      mode: 'static',
      projectName: 'Creator Asset Collection',
      projectContext: 'A collection containing CAD models, audio presets, HTML templates, and PDFs.',
      outputFormats: 'STEP, STL, WAV, HTML, CSS, PDF, and ZIP',
    };

    // When the prompt envelope is built
    const envelope = buildLicensingPromptEnvelope(staticDraft);

    // Then only the static delivery contract is active
    expect(envelope.mode).toBe('static');
    expect(envelope.dynamicPolicy).toBeNull();
    expect(envelope.staticPolicy).toEqual({
      outputFormats: 'STEP, STL, WAV, HTML, CSS, PDF, and ZIP',
    });
  });

  it('covers broad project surfaces without exposing them as selectable project types', () => {
    // Given the built-in adaptation coverage used by both prompt bases
    const dynamicIds = PROJECT_SURFACE_COVERAGE.dynamic.map(({ id }) => id);
    const staticIds = PROJECT_SURFACE_COVERAGE.static.map(({ id }) => id);

    // Then common and unusual project families are represented structurally
    expect(dynamicIds).toEqual(expect.arrayContaining([
      'native-applications',
      'games-mods-and-plugins',
      'browser-and-hosted-software',
      'libraries-source-and-extensions',
      'automation-data-and-embedded-systems',
    ]));
    expect(staticIds).toEqual(expect.arrayContaining([
      'documents-and-publications',
      'images-design-and-fonts',
      'audio-video-and-timelines',
      'models-cad-and-game-assets',
      'source-templates-archives-and-data',
    ]));
  });
});
