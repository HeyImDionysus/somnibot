import { app } from 'electron';
import { bootstrapLauncher } from './launcher-bootstrap.js';

// Do not inherit a host-provided remote debugging port. On locked-down
// Windows hosts Chromium can fail before the renderer starts while creating
// its Mojo named pipe for that port. Launcher DevTools remain opt-in through
// the application code, so normal startup does not require this switch.
app.commandLine.removeSwitch('remote-debugging-port');

await bootstrapLauncher({
  setAppName: name => app.setName(name),
  loadMain: () => import('./index.js'),
});
