import { freezeProject } from '../freeze-project';

export const HOSTED_WEB_PROJECT = freezeProject({
  fixtureId: 'hosted-web-app', revision: 1, displayName: 'Campaign Atlas',
  stack: 'Next.js 15 + React 19 + TypeScript', projectRoot: 'campaign-atlas', protectionMode: 'runtime',
  build: { command: 'pnpm type-check && pnpm build', expectedExitCode: 0, observable: '.next/standalone server output exists' },
  smoke: { command: 'pnpm exec playwright test e2e/campaign.spec.ts', expectedExitCode: 0, observable: 'A campaign survives save, reload, and public preview' },
  files: [
    { path: 'package.json', purpose: 'Hosted build contract', content: '{"name":"campaign-atlas","type":"module","scripts":{"build":"next build","type-check":"tsc --noEmit"},"dependencies":{"next":"15.5.21","react":"19.0.0"}}' },
    { path: 'src/app/campaigns/page.tsx', purpose: 'Completed campaign editor', content: "export function CampaignsPage() { return <main><h1>Campaigns</h1><form action='/api/campaigns'><input name='name' required /><button>Save</button></form></main>; }" },
    { path: 'src/app/api/campaigns/route.ts', purpose: 'Server-authoritative campaign writes', content: "export async function POST(request: Request): Promise<Response> { const form = await request.formData(); return Response.json({ saved: true, name: form.get('name') }); }" },
  ],
  preservedBehaviors: ['Owners create and edit campaign pages', 'Published campaign previews remain readable without an editor session'],
  activationSurface: { kind: 'web-page', entrypoint: '/settings/license', successObservable: 'The settings page shows Active and enables protected server routes', denialObservable: 'The page preserves the entered key and renders the server-provided denial category' },
  structuralCapabilities: ['campaign_publish', 'campaign_custom_domain'],
  offlinePolicy: { maximumSeconds: 900, trustedTimeRequired: true, freshInstallFailsClosed: true },
});
