import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { extractLicensingPromptEnvelope } from '../src/lib/store/licensing-prompt';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test('owner generates and reuses a stateless project licensing prompt', async ({ page }) => {
  const writes: string[] = [];
  const clientErrors: string[] = [];
  page.on('pageerror', (error) => clientErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') clientErrors.push(message.text());
  });
  await page.route('**/api/**', async (route) => {
    if (route.request().method() !== 'GET') writes.push(route.request().method());
    await route.fulfill({ json: { success: true, data: [] } });
  });

  await page.goto('/sdk');
  await expect(page.getByRole('heading', { name: 'SomniBot SDK' })).toBeVisible();
  await expect(page.getByText('Nothing is saved on the server.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: /save/i })).toHaveCount(0);
  await expect(page.getByLabel(/Store product ID/i)).toHaveCount(0);
  await expect(page.getByLabel('SomniBot API base')).toHaveCount(0);
  await expect(page.getByLabel(/Discord benefits/i)).toHaveCount(0);
  await expect(page.getByLabel(/current Discord membership/i)).toHaveCount(0);
  await expect(page.getByText('Set automatically from this dashboard deployment')).toBeVisible();
  await expect(page.getByText('Private integration context', { exact: true })).toBeVisible();
  await expect(page.getByText(/Do not include license keys, customer data, or provider secrets/)).toBeVisible();
  await expect(page.getByRole('group', { name: 'Integration rails' })).toBeVisible();
  for (const rail of ['Runtime licensing', 'Protected downloads', 'Hosted access', 'Discord roles', 'Signed updates']) {
    await expect(page.getByRole('checkbox', { name: rail })).toBeVisible();
  }
  await expect(page.getByRole('checkbox', { name: 'Runtime licensing' })).toBeChecked();
  for (const rail of ['Protected downloads', 'Hosted access', 'Discord roles', 'Signed updates']) {
    await page.getByRole('checkbox', { name: rail }).check();
  }
  await expect(page.getByRole('checkbox', { name: 'Runtime licensing' })).toBeChecked();
  expect(clientErrors).toEqual([]);

  const copyButton = page.getByRole('button', { name: 'Copy SDK contract' });
  await expect(copyButton).toBeDisabled();
  await page.getByLabel('Project name').fill('Universal Asset Kit');
  await page.getByLabel('Completed project context').fill('A reusable set of documents, source templates, images, audio, and future downloadable formats.');
  await page.getByRole('button', { name: 'Add capability' }).click();
  await page.getByLabel('Capability key 1').fill('premium.exports');
  await page.getByLabel('Capability name 1').fill('Premium exports');
  await page.getByLabel('Behavioral meaning 1').fill('Allows customers to export premium formats.');
  await page.getByLabel('Controlled functionality 1').fill('Premium PDF and SVG export actions.');
  await page.getByLabel('Granting plans 1').fill('pro: Pro, studio: Studio');
  await page.getByLabel('Unavailable behavior 1').fill('Keep editing available and disable only premium export actions.');
  await page.getByLabel('Dependency keys 1').fill('core.editor');
  await page.getByRole('button', { name: 'Add capability' }).click();
  await page.getByLabel('Capability key 2').fill('core.editor');
  await page.getByLabel('Capability name 2').fill('Core editor');
  await page.getByLabel('Behavioral meaning 2').fill('Allows customers to edit project documents.');
  await page.getByLabel('Controlled functionality 2').fill('Core project editing operations.');
  await page.getByLabel('Unavailable behavior 2').fill('Keep project files readable and refuse edit operations.');
  await page.getByRole('radio', { name: /static/i }).click();
  await page.getByLabel('Output formats').fill('PDF, PNG, SVG, ZIP, HTML, CSS, WAV, and future project files');
  await expect(copyButton).toBeEnabled();

  await expect(page.getByRole('button', { name: 'AGENT.md' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'CONFORMANCE.md' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'license-api.openapi.json' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'somnibot-sdk.json' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy selected file' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Download selected file' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Download SDK bundle' })).toBeEnabled();
  await page.getByRole('button', { name: 'AGENT.md' }).click();
  await page.getByRole('button', { name: 'Copy selected file' }).click();
  await expect(page.getByRole('button', { name: 'Selected file copied' })).toBeVisible();
  const selectedDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download selected file' }).click();
  expect((await selectedDownloadPromise).suggestedFilename()).toBe('AGENT.md');
  const bundleDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download SDK bundle' }).click();
  expect((await bundleDownloadPromise).suggestedFilename()).toBe('somnibot-sdk-bundle.json');

  const completeContract = page.getByText('Inspect complete copy contract', { exact: true });
  await completeContract.click();
  const promptPreview = page.locator('section[aria-labelledby="generated-prompt-heading"] details pre');
  await expect(promptPreview).toBeVisible();
  const prompt = await promptPreview.innerText();
  expect(extractLicensingPromptEnvelope(prompt)).toMatchObject({
    mode: 'static',
    project: {
      name: 'Universal Asset Kit',
      apiBase: `${new URL(page.url()).origin}/api`,
    },
    dynamicPolicy: null,
    staticPolicy: { outputFormats: 'PDF, PNG, SVG, ZIP, HTML, CSS, WAV, and future project files' },
    rails: {
      runtimeLicensing: true,
      downloadableFiles: true,
      hostedAccess: true,
      discordRoles: true,
      updates: true,
    },
  });
  await copyButton.click();
  await expect(page.getByRole('button', { name: 'SDK contract copied' })).toBeVisible();
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
    await expect(page.getByRole('heading', { name: 'SomniBot SDK' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'SomniBot SDK' })).toBeInViewport();
    const overflow = await page.locator('#main-content').evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
    const pageOverflow = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(pageOverflow.scrollWidth).toBeLessThanOrEqual(pageOverflow.clientWidth);
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
