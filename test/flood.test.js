import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FLOOD_LINE, parseNoaaTime, toSeries, parseHilo, computeGap, forecastWindows, highTides,
  getStatus, formatTime, formatClock,
} from '../flood.js';

// All values are synthetic. A tide is a cosine at six-minute steps, peaking at `peakAt`.
const MIN = 60000, HOUR = 3600000, STEP = 6 * MIN, PERIOD = 12.42 * HOUR;
const NOW = Date.UTC(2026, 5, 15, 12, 0); // a June day, Pacific daylight time

const gmt = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const tide = (peakAt, mid = 4, amp = 2.5) => (t) => mid + amp * Math.cos((2 * Math.PI * (t - peakAt)) / PERIOD);
const rows = (fn, from, to) => {
  const out = [];
  for (let t = from; t <= to; t += STEP) out.push({ t: gmt(t), v: fn(t).toFixed(3) });
  return out;
};
// Build the three feeds. `offset` shifts readings from predictions; `lastReading` ends them early.
function feeds({ peakAt, mid, amp, offset = 0, lastReading = NOW, now = NOW }) {
  const fn = tide(peakAt, mid, amp);
  return {
    now,
    predictions: rows(fn, now - 14 * HOUR, now + 50 * HOUR),
    readings: rows((t) => fn(t) + offset, now - 14 * HOUR, lastReading),
    hilo: [
      { t: gmt(peakAt), v: String(fn(peakAt)), type: 'H' },
      { t: gmt(peakAt + PERIOD / 2), v: '0.5', type: 'L' },
    ],
  };
}

test('parseNoaaTime reads GMT strings and toSeries drops empties', () => {
  assert.equal(parseNoaaTime('2026-11-10 08:48'), Date.UTC(2026, 10, 10, 8, 48));
  const s = toSeries([{ t: '2026-11-10 09:00', v: '2' }, { t: '2026-11-10 08:54', v: '' }, { t: '2026-11-10 08:48', v: '1.5' }, { t: 'x', v: '3' }]);
  assert.deepEqual(s.map((p) => p.value), [1.5, 2]);
  assert.deepEqual(toSeries(null), []);
});

test('under the line: NO, nothing expected', () => {
  const s = getStatus(feeds({ peakAt: NOW + 10 * HOUR, mid: 3, amp: 2 }));
  assert.equal(s.state, 'no');
  assert.equal(s.until, null);
  assert.equal(s.mayBeWet, false);
  assert.equal(s.tableOnly, false);
  assert.deepEqual(s.windows, []);
});

test('over the line: YES with the time it drops', () => {
  const s = getStatus(feeds({ peakAt: NOW, mid: 4, amp: 3 }));
  assert.equal(s.state, 'yes');
  assert.ok(s.latest.value >= FLOOD_LINE);
  assert.equal(s.until, s.windows[0].end);
  assert.ok(s.until > NOW);
  assert.equal(s.mayBeWet, false);
});

test('window starts within three hours: SOON, until is the start', () => {
  const s = getStatus(feeds({ peakAt: NOW + 2 * HOUR, mid: 4, amp: 3 }));
  assert.equal(s.state, 'soon');
  assert.equal(s.until, s.windows[0].start);
  assert.ok(s.until - NOW <= 3 * HOUR);
});

test('window more than three hours away: NO with next start', () => {
  const s = getStatus(feeds({ peakAt: NOW + 6 * HOUR, mid: 4, amp: 3 }));
  assert.equal(s.state, 'no');
  assert.equal(s.until, s.windows[0].start);
});

test('just dropped below the line: NO but mayBeWet', () => {
  const s = getStatus(feeds({ peakAt: NOW - 80 * MIN, mid: 4, amp: 2.5 }));
  assert.equal(s.state, 'no');
  assert.ok(s.latest.value < FLOOD_LINE);
  assert.equal(s.mayBeWet, true);
});

test('dropped more than an hour ago: not mayBeWet', () => {
  const s = getStatus(feeds({ peakAt: NOW - 3 * HOUR, mid: 4, amp: 2.5 }));
  assert.equal(s.mayBeWet, false);
});

test('stale latest reading: unknown, table only', () => {
  const s = getStatus(feeds({ peakAt: NOW + 2 * HOUR, mid: 4, amp: 3, lastReading: NOW - 50 * MIN }));
  assert.equal(s.state, 'unknown');
  assert.equal(s.reason, 'stale');
  assert.equal(s.tableOnly, true);
  assert.equal(s.gap, null);
  assert.ok(s.windows.length > 0); // table windows with gap 0
  assert.equal(s.highs.length, 1);
});

test('reading 40 minutes old is still fresh', () => {
  const s = getStatus(feeds({ peakAt: NOW + 10 * HOUR, mid: 3, amp: 2, lastReading: NOW - 40 * MIN }));
  assert.notEqual(s.state, 'unknown');
});

test('empty readings (v "") are skipped, all-empty is unknown', () => {
  const f = feeds({ peakAt: NOW + 10 * HOUR, mid: 3, amp: 2 });
  const lastGood = f.readings[f.readings.length - 5];
  const blanked = f.readings.map((r, i) => (i >= f.readings.length - 4 ? { ...r, v: '' } : r));
  const s = getStatus({ ...f, readings: blanked });
  assert.equal(s.state, 'no');
  assert.equal(s.latest.time, parseNoaaTime(lastGood.t));
  const none = getStatus({ ...f, readings: f.readings.map((r) => ({ ...r, v: '' })) });
  assert.equal(none.state, 'unknown');
  assert.equal(none.reason, 'no-data');
});

test('null or failed fetches: unknown with error, highs only if hilo loaded', () => {
  const f = feeds({ peakAt: NOW + 2 * HOUR, mid: 4, amp: 3 });
  const a = getStatus({ ...f, readings: null });
  assert.equal(a.state, 'unknown');
  assert.equal(a.reason, 'error');
  assert.equal(a.latest, null);
  assert.ok(a.windows.length > 0);
  assert.equal(a.highs.length, 1);
  const b = getStatus({ ...f, predictions: null, hilo: null });
  assert.equal(b.state, 'unknown');
  assert.deepEqual(b.windows, []);
  assert.deepEqual(b.highs, []);
  assert.equal(getStatus({ now: NOW, readings: [], predictions: [], hilo: [] }).state, 'unknown');
});

test('mismatched timestamps are ignored: no matches means no gap', () => {
  const f = feeds({ peakAt: NOW + 2 * HOUR, mid: 4, amp: 3 });
  const shifted = f.readings.map((r) => ({ ...r, t: gmt(parseNoaaTime(r.t) + MIN) }));
  assert.equal(computeGap(toSeries(shifted), toSeries(f.predictions), NOW), null);
  assert.equal(getStatus({ ...f, readings: shifted }).state, 'unknown');
});

test('only exact matches count toward the gap', () => {
  const preds = [{ time: NOW - 12 * MIN, value: 4 }, { time: NOW - 6 * MIN, value: 4 }, { time: NOW, value: 4 }];
  const reads = [{ time: NOW - 12 * MIN, value: 5 }, { time: NOW - 5 * MIN, value: 99 }, { time: NOW, value: 4 }];
  assert.equal(computeGap(reads, preds, NOW), 0.5);
});

test('gap ignores readings older than 12 hours', () => {
  const preds = [{ time: NOW - 13 * HOUR, value: 0 }, { time: NOW, value: 0 }];
  const reads = [{ time: NOW - 13 * HOUR, value: 10 }, { time: NOW, value: 1 }];
  assert.equal(computeGap(reads, preds, NOW), 1);
});

test('gap of zero leaves the table unchanged', () => {
  const f = feeds({ peakAt: NOW + 2 * HOUR, mid: 4, amp: 3 });
  const s = getStatus(f);
  assert.ok(Math.abs(s.gap) < 0.001);
  assert.deepEqual(s.windows.map((w) => w.start), forecastWindows(toSeries(f.predictions), 0, NOW).map((w) => w.start));
});

test('negative gap shrinks the window; positive gap grows it', () => {
  const base = getStatus(feeds({ peakAt: NOW + 2 * HOUR, mid: 4, amp: 3.5 }));
  const dry = getStatus(feeds({ peakAt: NOW + 2 * HOUR, mid: 4, amp: 3.5, offset: -0.8 }));
  const wet = getStatus(feeds({ peakAt: NOW + 2 * HOUR, mid: 4, amp: 3.5, offset: 0.8 }));
  assert.ok(dry.gap < -0.79 && dry.gap > -0.81);
  const dur = (w) => w.end - w.start;
  assert.ok(dur(dry.windows[0]) < dur(base.windows[0]));
  assert.ok(dur(wet.windows[0]) > dur(base.windows[0]));
  assert.ok(dry.windows[0].peak < wet.windows[0].peak);
});

test('window spanning midnight Pacific time', () => {
  const peakAt = Date.UTC(2026, 5, 16, 7, 0); // midnight PDT, Tue 16 June
  const now = peakAt - 4 * HOUR;
  const s = getStatus(feeds({ peakAt, mid: 4, amp: 3, now }));
  const w = s.windows[0];
  assert.ok(w.start < peakAt && w.end > peakAt);
  assert.match(formatTime(w.start), /^Mon /);
  assert.match(formatTime(w.end), /^Tue /);
  assert.equal(formatClock(peakAt), '12:00 AM');
});

test('daylight saving ends 2026-11-01: wall clock is right on both sides', () => {
  const at = (h, m) => Date.UTC(2026, 10, 1, h, m);
  assert.equal(formatClock(at(7, 59)), '12:59 AM'); // PDT
  assert.equal(formatClock(at(8, 30)), '1:30 AM');  // PDT
  assert.equal(formatClock(at(9, 30)), '1:30 AM');  // PST, the repeated hour
  assert.equal(formatClock(at(10, 0)), '2:00 AM');  // PST
  assert.equal(formatClock(at(15, 0)), '7:00 AM');  // PST
  assert.equal(formatClock(Date.UTC(2026, 9, 31, 15, 0)), '8:00 AM'); // PDT
  assert.equal(formatTime(at(10, 0)), 'Sun 2:00 AM');
  // Water over the line 08:30Z to 09:59Z, which straddles the change.
  const preds = [];
  for (let t = at(5, 0); t <= at(20, 0); t += STEP) preds.push({ time: t, value: t >= at(8, 30) && t < at(10, 0) ? 7 : 4 });
  const [w] = forecastWindows(preds, 0, at(6, 0));
  assert.equal(w.start, at(8, 30));
  assert.equal(w.end, at(10, 0));
  assert.equal(formatClock(w.start), '1:30 AM');
  assert.equal(formatClock(w.end), '2:00 AM');
  assert.equal(w.end - w.start, 90 * MIN); // 90 real minutes, 30 on the wall clock
});

test('window still open at the horizon end has a null end', () => {
  const preds = [];
  for (let t = NOW - HOUR; t <= NOW + 50 * HOUR; t += STEP) preds.push({ time: t, value: t > NOW + 40 * HOUR ? 7 : 4 });
  const windows = forecastWindows(preds, 0, NOW);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].end, null);
  assert.equal(windows[0].start, NOW + 40 * HOUR + STEP);
});

test('windows ignore the past and beyond 48 hours', () => {
  const preds = [{ time: NOW - HOUR, value: 7 }, { time: NOW + 49 * HOUR, value: 7 }];
  assert.deepEqual(forecastWindows(preds, 0, NOW), []);
});

test('high tides wet or dry once the gap is applied', () => {
  const hilo = parseHilo([
    { t: gmt(NOW + HOUR), v: '5.9', type: 'H' },
    { t: gmt(NOW + 2 * HOUR), v: '0.2', type: 'L' },
    { t: gmt(NOW + 13 * HOUR), v: '6.0', type: 'H' },
    { t: gmt(NOW - HOUR), v: '7.0', type: 'H' },
    { t: gmt(NOW + 49 * HOUR), v: '7.0', type: 'H' },
  ]);
  assert.deepEqual(highTides(hilo, 0, NOW).map((h) => h.wet), [false, false]);
  const wet = highTides(hilo, 0.4, NOW);
  assert.deepEqual(wet.map((h) => h.wet), [true, true]);
  assert.ok(Math.abs(wet[0].forecast - 6.3) < 1e-9 && wet[0].table === 5.9);
  assert.deepEqual(highTides(hilo, -0.2, NOW).map((h) => h.wet), [false, false]);
  assert.equal(highTides(hilo, null, NOW)[0].forecast, 5.9);
});

test('formatTime defaults and options', () => {
  const ms = Date.UTC(2026, 10, 11, 3, 4);
  assert.equal(formatTime(ms), 'Tue 7:04 PM');
  assert.equal(formatClock(ms), '7:04 PM');
  assert.equal(formatTime(ms, { hour: 'numeric', hour12: false }), '19');
});
