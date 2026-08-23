import { freezeProject } from '../freeze-project';

export const ELECTRON_PROJECT = freezeProject({
  fixtureId: 'electron-desktop', revision: 1, displayName: 'Focus Board Desktop',
  stack: 'Electron 34 + TypeScript + Vite', projectRoot: 'focus-board-desktop', protectionMode: 'runtime',
  build: { command: 'pnpm build', expectedExitCode: 0, observable: 'dist/main.js and dist/renderer/index.html exist' },
  smoke: { command: 'pnpm test:smoke', expectedExitCode: 0, observable: 'A persisted board reopens with its three columns and cards intact' },
  files: [
    { path: 'package.json', purpose: 'Build and smoke commands', content: '{"name":"focus-board","type":"module","scripts":{"build":"tsc && vite build","test:smoke":"vitest run"}}' },
    { path: 'src/main.ts', purpose: 'Desktop lifecycle and private persistence', content: "import { app, BrowserWindow, ipcMain } from 'electron';\nipcMain.handle('boards:list', async () => loadBoards());\napp.whenReady().then(() => new BrowserWindow({ webPreferences: { preload: 'preload.js' } }).loadFile('dist/renderer/index.html'));" },
    { path: 'src/renderer/board.ts', purpose: 'Completed board behavior', content: "export function moveCard(cardId: string, columnId: string): void { document.dispatchEvent(new CustomEvent('board:move', { detail: { cardId, columnId } })); }" },
  ],
  preservedBehaviors: ['Creates, renames, and deletes boards', 'Persists card moves across a full application restart'],
  activationSurface: { kind: 'window', entrypoint: 'Help > Activate Focus Board', successObservable: 'The activation window closes and premium export becomes enabled', denialObservable: 'The activation window keeps the entered key editable and shows a reason plus retry action' },
  structuralCapabilities: ['premium_export', 'team_board_sync'],
  offlinePolicy: { maximumSeconds: 86400, trustedTimeRequired: true, freshInstallFailsClosed: true },
});
