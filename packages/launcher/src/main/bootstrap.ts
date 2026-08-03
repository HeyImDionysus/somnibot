import { app } from 'electron';
import { bootstrapLauncher } from './launcher-bootstrap.js';
import { removeHostDebugSwitches } from './startup-switch-policy.js';

// Do not inherit host-provided remote debugging controls. On locked-down
// Windows hosts Chromium can fail before the renderer starts while creating
// the Mojo named pipe for these switches. Launcher DevTools remain opt-in
// through the application code, so normal startup does not require them.
removeHostDebugSwitches(app.commandLine);

await bootstrapLauncher({
  setAppName: name => app.setName(name),
  loadMain: () => import('./index.js'),
});
