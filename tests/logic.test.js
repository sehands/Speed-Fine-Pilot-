import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateFine,
  calculatePenaltyView,
  evaluateConditionalSpeed,
  parseNumericSpeed,
  parseSpeedValue,
  parseTimeRangeCondition
} from '../logic.js';

test('parses numeric and mph speed values', () => {
  assert.equal(parseNumericSpeed('50').value, 50);
  assert.equal(parseNumericSpeed('30 mph').value, 48);
  assert.equal(parseNumericSpeed('signals').kind, 'unknown');
  assert.equal(parseNumericSpeed('none').kind, 'unlimited');
});

test('parses German default tokens from any OSM speed field', () => {
  assert.deepEqual(parseSpeedValue('DE:urban'), {
    kind:'numeric', value:50, area:'urban', source:'Deutsches Standardlimit innerorts'
  });
  assert.deepEqual(parseSpeedValue('DE:rural'), {
    kind:'numeric', value:100, area:'rural', source:'Deutsches Standardlimit außerorts'
  });
  assert.equal(parseSpeedValue('DE:zone30').value, 30);
  assert.equal(parseSpeedValue('DE:motorway').kind, 'unlimited');
});

test('evaluates weekday and overnight conditions deterministically', () => {
  const mondayMorning = new Date(2026, 8, 7, 8, 0);
  const mondayEvening = new Date(2026, 8, 7, 18, 0);
  const fridayLate = new Date(2026, 8, 11, 23, 0);
  assert.equal(parseTimeRangeCondition('Mo-Fr 07:00-17:00', mondayMorning), true);
  assert.equal(parseTimeRangeCondition('Mo-Fr 07:00-17:00', mondayEvening), false);
  assert.equal(parseTimeRangeCondition('Fr-Su 22:00-06:00', fridayLate), true);
  assert.equal(parseTimeRangeCondition('wet', mondayMorning), null);
});

test('activates supported conditional speeds and flags unsupported conditions', () => {
  const mondayMorning = new Date(2026, 8, 7, 8, 0);
  assert.equal(evaluateConditionalSpeed('30 @ (Mo-Fr 07:00-17:00)', mondayMorning).active.value, 30);
  assert.equal(evaluateConditionalSpeed('80 @ (wet)', mondayMorning).active, null);
  assert.match(evaluateConditionalSpeed('80 @ (wet)', mondayMorning).note, /Zusatzschild prüfen/);
});

test('keeps official passenger-car fine thresholds at their boundaries', () => {
  assert.deepEqual(calculateFine(10, 'urban'), {max:10,fine:30,points:0,ban:0,areaUsed:'urban'});
  assert.deepEqual(calculateFine(11, 'urban'), {max:15,fine:50,points:0,ban:0,areaUsed:'urban'});
  assert.deepEqual(calculateFine(21, 'urban'), {max:25,fine:115,points:1,ban:0,areaUsed:'urban'});
  assert.deepEqual(calculateFine(31, 'urban'), {max:40,fine:260,points:2,ban:1,areaUsed:'urban'});
  assert.deepEqual(calculateFine(40, 'rural'), {max:40,fine:200,points:1,ban:0,areaUsed:'rural'});
  assert.deepEqual(calculateFine(41, 'rural'), {max:50,fine:320,points:2,ban:1,areaUsed:'rural'});
});

test('returns an urban/rural range when the area is unknown', () => {
  const result = calculatePenaltyView(21, 'unknown');
  assert.equal(result.range.urban.fine, 115);
  assert.equal(result.range.rural.fine, 100);
  assert.equal(result.primary.fine, 115);
});
