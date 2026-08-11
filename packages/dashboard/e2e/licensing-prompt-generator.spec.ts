import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { extractLicensingPromptEnvelope } from '../src/lib/store/licensing-prompt';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test('owner generates and reuses a stateless project licensing prompt', async ({ page }) => {
  const writes: string[] = [];
  await page.route('**/api/**', async (route) => {
    if (route.request().method() !== 'GET') writes.push(route.request().method());
    await route.fulfill({ json: { success: true, data: [] } });
  });

  await page.goto('/project-licensing');
  await expect(page.getByRole('heading', { name: 'Project Licensing Prompt' })).toBeVisible();
  await expect(page.getByText('Nothing on this page is saved.')).toBeVisible();
  await expect(page.getByRole('button', { name: /save/i })).toHaveCount(0);
  await expect(page.getByLabel(/Store product ID/i)).toHaveCount(0);
  await expect(page.getByLabel('SomniBot API base')).toHaveCount(0);
  await expect(page.getByLabel(/Discord benefits/i)).toHaveCount(0);
  await expect(page.getByText('Set automatically from this dashboard deployment')).toBeVisible();

  const copyButton = page.getByRole('button', { name: 'Copy prompt' });
  await expect(copyButton).toBeDisabled();
  await page.getByLabel('Project name').fill('Universal Asset Kit');
  await page.getByLabel('Project description').fill('A reusable set of documents, source templates, images, audio, and future downloadable formats.');
  await page.getByRole('radio', { name: /static/i }).click();
  await page.getByLabel('Output formats').fill('PDF, PNG, SVG, ZIP, HTML, CSS, WAV, and future project files');
  await expect(copyButton).toBeEnabled();

  const prompt = await page.locator('section[aria-labelledby="generated-prompt-heading"] pre').innerText();
  expect(extractLicensingPromptEnvelope(prompt)).toMatchObject({
    mode: 'static',
    project: {
      name: 'Universal Asset Kit',
      apiBase: `${new URL(page.url()).origin}/api`,
    },
    dynamicPolicy: null,
    staticPolicy: { outputFormats: 'PDF, PNG, SVG, ZIP, HTML, CSS, WAV, and future project files' },
  });
  await copyButton.click();
  await expect(page.getByRole('button', { name: 'Prompt copied' })).toBeVisible();
  expect(writes).toEqual([]);

  const evidence = process.env.LICENSING_PROMPT_EVIDENCE_DIR
    ?? path.resolve(process.cwd(), '../../.omo/evidence/project-licensing/visual');
  await mkdir(evidence, { recursive: true });
  for (const viewport of [
    { width: 1280, height: 900, name: 'desktop' },
    { width: 768, height: 900, name: 'tablet' },
    { width: 375, height: 812, name: 'mobile' },
  ]) {
    await page.setViewportSize(viewport);
    await page.locator('#main-content').evaluate((element) => element.scrollTo({ top: 0 }));
    await expect(page.getByRole('heading', { name: 'Project Licensing Prompt' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Project Licensing Prompt' })).toBeInViewport();
    const overflow = await page.locator('#main-content').evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
    await writeFile(path.join(evidence, `prompt-generator-${viewport.name}.png`), await page.screenshot());
  }
  await page.setViewportSize({ width: 375, height: 812 });
  await page.locator('section[aria-labelledby="generated-prompt-heading"]').scrollIntoViewIfNeeded();
  await writeFile(path.join(evidence, 'prompt-generator-mobile-preview.png'), await page.screenshot());

  await page.reload();
  await expect(page.getByLabel('Project name')).toHaveValue('');
  await expect(page.getByRole('radio', { name: /dynamic/i })).toBeChecked();
  expect(writes).toEqual([]);
});
