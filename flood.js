// Pure logic for "Is the Mill Valley bike path flooded?" (NOAA SF gauge 9414290).
// Times are epoch ms (UTC). Heights are feet MLLW.
export const FLOOD_LINE = 6.25;
export const GAP_HOURS = 12;
export const STALE_MINUTES = 45;
export const SOON_HOURS = 3;
export const WET_AFTER_MINUTES = 60;
export const FORECAST_HOURS = 48;

const MIN = 60000;
const HOUR = 3600000;
const TIME_ZONE = 'America/Los_Angeles';

// "2026-11-10 08:48" (GMT) -> epoch ms
export function parseNoaaTime(t) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(String(t));
  return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) : NaN;
}

// NOAA rows [{t, v}] -> [{time, value}], dropping empty or unparsable rows, sorted by time.
export function toSeries(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => r && r.v !== '' && r.v != null)
    .map((r) => ({ time: parseNoaaTime(r.t), value: Number(r.v) }))
    .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.value))
    .sort((a, b) => a.time - b.time);
}

// Mean of observed minus predicted at exactly matching timestamps in [now - hours, now]; null if none.
export function computeGap(readings, predictions, now, hours = GAP_HOURS) {
  const predicted = new Map(predictions.map((p) => [p.time, p.value]));
  const diffs = readings
    .filter((r) => r.time >= now - hours * HOUR && r.time <= now && predicted.has(r.time))
    .map((r) => r.value - predicted.get(r.time));
  return diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : null;
}

// Runs where predicted + gap >= line over (now, now + hours].
// end is the first sample back under the line, or null if still over at the horizon.
export function forecastWindows(predictions, gap, now, line = FLOOD_LINE, hours = FORECAST_HOURS) {
  const windows = [];
  let open = null;
  for (const p of predictions) {
    if (p.time <= now || p.time > now + hours * HOUR) continue;
    const height = p.value + gap;
    if (height >= line) {
      if (!open) windows.push((open = { start: p.time, end: null, peak: height, peakTime: p.time }));
      else if (height > open.peak) Object.assign(open, { peak: height, peakTime: p.time });
    } else if (open) {
      open.end = p.time;
      open = null;
    }
  }
  return windows;
}

export function getStatus({ readings, predictions, now }) {
  const obs = toSeries(readings);
  const pred = toSeries(predictions);
  const latest = obs.length ? obs[obs.length - 1] : null;
  const gap = latest && pred.length ? computeGap(obs, pred, now) : null;

  let reason = null;
  if (readings == null || predictions == null) reason = 'error';
  else if (!latest || gap === null) reason = 'no-data';
  else if (now - latest.time > STALE_MINUTES * MIN) reason = 'stale';

  const g = reason ? 0 : gap;
  const windows = forecastWindows(pred, g, now);
  const base = { line: FLOOD_LINE, latest, gap: reason ? null : gap, windows };
  if (reason) {
    return { ...base, state: 'unknown', tableOnly: true, until: null, mayBeWet: false, reason };
  }

  const next = windows[0] ?? null;
  const over = latest.value >= FLOOD_LINE;
  const mayBeWet =
    !over && obs.some((r) => r.value >= FLOOD_LINE && r.time >= now - WET_AFTER_MINUTES * MIN && r.time <= now);
  const soon = next && next.start - now <= SOON_HOURS * HOUR;
  // Over now: the window that holds now starts at the next sample; if the forecast already
  // has the water under the line, it drops by the next forecast sample.
  const holdsNow = next && next.start - now <= 6 * MIN;
  const nextSample = pred.find((p) => p.time > now)?.time ?? null;
  const state = over ? 'yes' : soon ? 'soon' : 'no';
  if (over && holdsNow) next.ongoing = true;
  const until = over ? (holdsNow ? next.end : nextSample) : next ? next.start : null;
  return { ...base, state, tableOnly: false, until, mayBeWet, reason: null };
}

// Intl formatting in Pacific time. Newer ICU puts a narrow no-break space before AM/PM; normalise it.
function fmt(ms, opts) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, ...opts })
    .format(ms)
    .replace(/ /g, ' ');
}

export function formatTime(ms, opts = { weekday: 'short', hour: 'numeric', minute: '2-digit' }) {
  return fmt(ms, opts);
}

export function formatClock(ms) {
  return fmt(ms, { hour: 'numeric', minute: '2-digit' });
}

// A flood window as riders read it: "Tue 9:06 AM to 12:54 PM", "Now to 12:54 PM",
// "Tue 11:30 PM to Wed 1:10 AM", "Tue 9:06 AM onward" when it runs past the forecast.
export function formatRange({ start, end, ongoing }) {
  const from = ongoing ? 'Now' : formatTime(start);
  if (end == null) return `${from} onward`;
  const sameDay = fmt(start, { weekday: 'short' }) === fmt(end, { weekday: 'short' });
  return `${from} to ${sameDay ? formatClock(end) : formatTime(end)}`;
}
