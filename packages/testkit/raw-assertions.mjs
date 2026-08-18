const SHA_RE = /^[0-9a-f]{40}$/i;

export function captureFleetAssertionRecords(report, candidateSha) {
  const exactSha = typeof candidateSha === 'string' ? candidateSha.trim().toLowerCase() : '';
  if (!SHA_RE.test(exactSha)) {
    throw new Error('Raw fleet assertion capture requires an exact 40-character candidate SHA.');
  }
  const records = report.scenarios.flatMap((scenario) =>
    scenario.classes.flatMap((evidence) =>
      evidence.records.map((record) => ({
        scenario: scenario.scenarioClass,
        scenarioId: scenario.scenarioId,
        assertionClass: evidence.assertionClass,
        channel: record.channel,
        status: record.status,
        promise: record.promise,
        observation: record.observation,
        ...(record.impact ? { impact: record.impact } : {}),
        ...(record.gateReason ? { gateReason: record.gateReason } : {}),
      })),
    ),
  );
  return {
    schemaVersion: 1,
    candidateSha: exactSha,
    domainId: report.domainId,
    records,
  };
}
