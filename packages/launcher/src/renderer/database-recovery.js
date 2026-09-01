(() => {
  const backup = document.getElementById('database-backup');
  const rehearse = document.getElementById('database-rehearse');
  const status = document.getElementById('database-recovery-status');
  const target = document.getElementById('database-recovery-target');
  const password = document.getElementById('database-recovery-password');
  const template = document.getElementById('database-recovery-template');
  const confirmation = document.getElementById('database-recovery-confirmation');
  let backupId = null;
  let busy = false;
  rehearse.disabled = true;

  async function initialize() {
    try {
      const retained = await window.somnibot.getRetainedDatabaseBackup();
      if (!backupId && retained) {
        backupId = retained.backupId;
        rehearse.disabled = false;
        status.textContent = `Verified retained backup from ${retained.capturedAt} is available for isolated rehearsal.`;
      } else if (!backupId) {
        status.textContent = 'No verified retained backup is currently available. Capture a backup to enable isolated rehearsal.';
      }
    } catch {
      status.textContent = 'No verified retained backup is currently available. Capture a backup to enable isolated rehearsal.';
    }
  }

  async function run(operation) {
    if (busy) return;
    busy = true;
    backup.disabled = true;
    rehearse.disabled = true;
    status.textContent = 'Running the approved database operation. Keep this window open.';
    try {
      const result = await operation();
      if (result.status === 'backed-up' && result.backupId) backupId = result.backupId;
      status.textContent = result.message;
    } catch {
      status.textContent = 'Database recovery could not complete. No success has been verified; review credentials and prerequisites before retrying.';
    } finally {
      password.value = '';
      busy = false;
      backup.disabled = false;
      rehearse.disabled = !backupId;
    }
  }

  backup.addEventListener('click', () => run(() => window.somnibot.backupDatabase()));
  rehearse.addEventListener('click', () => {
    if (!backupId || busy) return;
    if (!target.value.trim() || !password.value || !confirmation.value.trim()) {
      status.textContent = 'Enter the isolated target project URL, password, and exact project reference confirmation.';
      target.focus();
      return;
    }
    const request = { backupId, projectUrl: target.value.trim(), password: password.value,
      template: template.value.trim(), confirmation: confirmation.value.trim() };
    void run(() => window.somnibot.rehearseDatabase(request));
  });
  void initialize();
})();
