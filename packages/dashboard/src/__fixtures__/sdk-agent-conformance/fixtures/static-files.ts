import { freezeProject } from '../freeze-project';

export const STATIC_FILES_PROJECT = freezeProject({
  fixtureId: 'static-files-site', revision: 1, displayName: 'Trail Notes',
  stack: 'Static HTML, CSS, and browser JavaScript', projectRoot: 'trail-notes-static', protectionMode: 'delivery-time',
  build: { command: 'node --check src/app.js', expectedExitCode: 0, observable: 'Browser JavaScript parses without syntax errors' },
  smoke: { command: 'node scripts/smoke.mjs', expectedExitCode: 0, observable: 'Static navigation targets and manifest files exist' },
  files: [
    { path: 'index.html', purpose: 'Completed static user surface', content: '<!doctype html><html><body><nav><a href="#notes">Notes</a></nav><main id="notes"><button id="new-note">New note</button></main><script type="module" src="src/app.js"></script></body></html>' },
    { path: 'src/app.js', purpose: 'Local note creation behavior', content: "const button = document.querySelector('#new-note'); button?.addEventListener('click', () => localStorage.setItem('trail-note', 'created'));" },
    { path: 'scripts/smoke.mjs', purpose: 'Static artifact smoke check', content: "import { readFile } from 'node:fs/promises'; const html = await readFile('index.html', 'utf8'); if (!html.includes('src/app.js')) process.exit(1);" },
  ],
  preservedBehaviors: ['Visitors navigate to the notes section without a page load', 'Creating a note persists it in browser storage'],
  activationSurface: { kind: 'web-page', entrypoint: 'SomniBot customer portal delivery', successObservable: 'An entitled customer receives the protected static artifact without an in-project license prompt', denialObservable: 'The portal explains why delivery is unavailable without exposing an unprotected master artifact' },
  structuralCapabilities: ['licensed_artifact_delivery'],
  offlinePolicy: null,
});
