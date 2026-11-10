import { getStatus, formatTime, formatClock, formatRange } from './flood.js?v=3';

const BASE = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter' +
  '?station=9414290&datum=MLLW&units=english&format=json&application=mv-path-flood&time_zone=gmt';
const REFRESH_MS = 5 * 60 * 1000;
const HOUR = 3600000;
const WORDS = { yes: 'YES', soon: 'SOON', no: 'NO', unknown: 'NO DATA' };

const $ = (id) => document.getElementById(id);
let lastRun = 0;
let busy = false;

function stamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

async function load(url, key) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('bad status');
  const json = await res.json();
  if (!json || json.error || !Array.isArray(json[key])) throw new Error('no data');
  return json[key];
}

async function fetchAll(now) {
  const range = `&begin_date=${encodeURIComponent(stamp(now - 14 * HOUR))}&end_date=${encodeURIComponent(stamp(now + 50 * HOUR))}`;
  const results = await Promise.allSettled([
    load(`${BASE}&product=water_level&range=14`, 'data'),
    load(`${BASE}&product=predictions${range}`, 'predictions'),
  ]);
  const [readings, predictions] = results.map((r) => (r.status === 'fulfilled' ? r.value : null));
  return { readings, predictions };
}

function lineFor(s) {
  if (s.state === 'unknown') {
    return s.reason === 'stale'
      ? 'The gauge has not reported lately. Showing the tide table only.'
      : "Can't reach the gauge. Showing the tide table only.";
  }
  if (s.state === 'yes') {
    return s.until == null
      ? 'Water stays over the line for the next two days.'
      : `Water should drop below the line around ${formatClock(s.until)}.`;
  }
  if (s.state === 'soon') return `Water should reach the line around ${formatClock(s.until)}.`;
  if (s.mayBeWet) return 'The tide just dropped. The path may still be wet.';
  return s.until == null
    ? 'Nothing expected over the line in the next 48 hours.'
    : `Next expected over the line ${formatTime(s.until)}.`;
}

const ft = (n) => (n == null || Number.isNaN(n) ? '-' : n.toFixed(2));
const signed = (n) => (n == null || Number.isNaN(n) ? '-' : (n >= 0 ? '+' : '-') + Math.abs(n).toFixed(2));

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Set text only when it changes, so the live region speaks only on news.
function put(id, text) {
  if ($(id).textContent !== text) $(id).textContent = text;
}

function render(s) {
  $('answer').dataset.state = s.state;
  put('answer-word', WORDS[s.state] || WORDS.unknown);
  put('answer-line', lineFor(s));
  $('fig-now').textContent = ft(s.latest && s.latest.value);
  $('fig-line').textContent = ft(s.line);
  $('fig-gap').textContent = signed(s.gap);
  $('next-note').hidden = !s.tableOnly;

  const list = $('floods');
  list.replaceChildren();
  if (!s.windows.length) {
    list.append(el('li', 'none', 'None in the next 48 hours.'));
    return;
  }
  for (const w of s.windows) {
    const li = el('li');
    li.append(el('span', 'when', formatRange(w)), el('span', 'h', ft(w.peak)), el('span', 'unit', 'ft peak'));
    list.append(li);
  }
}

async function refresh() {
  if (busy) return;
  busy = true;
  try {
    const now = Date.now();
    const data = await fetchAll(now);
    const s = getStatus({ ...data, now });
    render(s);
    $('updated').textContent = formatClock(now);
    $('reading').textContent = s.latest ? formatClock(s.latest.time) : '-';
    lastRun = now;
  } catch {
    // Leave the last good view in place.
  } finally {
    busy = false;
  }
}

refresh();
setInterval(refresh, REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - lastRun > REFRESH_MS) refresh();
});
