import { app } from 'electron';
import { bootstrapLauncher } from './launcher-bootstrap.js';

await bootstrapLauncher({
  setAppName: name => app.setName(name),
  loadMain: () => import('./index.js'),
});
