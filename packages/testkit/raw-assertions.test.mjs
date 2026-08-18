import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureFleetAssertionRecords } from './raw-assertions.mjs';

const candidateSha = 'a'.repeat(40);

test('retains every raw PASS and GATED assertion facet with candidate binding', () => {
  const report = {
    domainId: 'example-domain',
    scenarios: [{
      scenarioClass: 'DEF',
      scenarioId: 'example-def',
      classes: [{
        assertionClass: 'audit',
        status: 'GATED',
        records: [
          { assertionClass: 'audit', channel: 'audit-row', status: 'PASS', promise: 'first', observation: 'real row one' },
          { assertionClass: 'audit', channel: 'audit-row', status: 'GATED', promise: 'second', observation: 'GATED-PENDING', gateReason: 'live readback required' },
        ],
      }],
    }],
  };

  const result = captureFleetAssertionRecords(report, candidateSha);

  assert.equal(result.candidateSha, candidateSha);
  assert.equal(result.domainId, 'example-domain');
  assert.equal(result.records.length, 2);
  assert.deepEqual(result.records.map((record) => record.status), ['PASS', 'GATED']);
});

test('rejects an unbound candidate when capturing assertion records', () => {
  assert.throws(
    () => captureFleetAssertionRecords({ domainId: 'example', scenarios: [] }, 'local'),
    /exact 40-character candidate SHA/,
  );
});
