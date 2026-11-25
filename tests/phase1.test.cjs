'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const inlineScripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1]).filter(source => source.trim());
assert.equal(inlineScripts.length, 1, 'expected one inline dashboard script');
const dashboardSource = inlineScripts[0];
const data = JSON.parse(fs.readFileSync(path.join(root, 'sheet_data.json'), 'utf8'));

function createHarness() {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        id, value: '', innerHTML: '', textContent: '', style: {}, dataset: {},
        classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
        append() {}, after() {}, addEventListener() {}, getContext() { return {}; },
        tBodies: [], close() {}, showModal() {}
      });
    }
    return elements.get(id);
  }
  const document = {
    getElementById: element,
    querySelectorAll() { return []; },
    createElement(tag) { return element('created-' + tag); },
    body: element('body')
  };
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [2026, 10, 25])); }
    static now() { return new Date(2026, 10, 25).getTime(); }
  }
  const instrumented = dashboardSource.replace(/\nload\(\);\s*$/, `
globalThis.__lifeosTest = {
  setData(d) { data = d; filters(); },
  setFilter(y = '', q = '', m = '') {
    quickRange = '';
    $('year').value = y; $('quarter').value = q; $('month').value = m;
  },
  setQuick(q) {
    quickRange = q;
    $('year').value = ''; $('quarter').value = ''; $('month').value = '';
  },
  filtered, comparison, goalDays, podcastTarget, selectedBounds, priorBounds,
  metricValue, date, kpiValues, rows, sum,
  getGoals() { return goals; }
};`);
  assert.notEqual(instrumented, dashboardSource, 'test harness must replace the page startup call');
  const sandbox = {
    document, window: {},
    localStorage: { getItem() { return null; }, setItem() {} },
    Chart: class {},
    Date: FixedDate
  };
  new vm.Script(dashboardSource, { filename: 'index.html' });
  vm.runInNewContext(instrumented, sandbox, { filename: 'index.html' });
  const api = sandbox.__lifeosTest;
  api.setData(data);
  return api;
}

test('dashboard script parses and the real calculation functions load', () => {
  assert.equal(typeof createHarness().comparison, 'function');
});

test('ISO dates parse and blank dates remain unassigned', () => {
  const api = createHarness();
  assert.equal(api.date({ Date: '2026-02-28' }).toISOString().slice(0, 10), '2026-02-28');
  assert.equal(api.date({ Date: '' }), null);
});

test('minutes convert to hours and blank metric observations stay missing', () => {
  const api = createHarness();
  assert.equal(api.metricValue({ 'Sleep Minutes': 90 }, 'sleep'), 1.5);
  assert.equal(api.metricValue({ Steps: '' }, 'steps'), null);
  assert.equal(api.metricValue({ Steps: 0 }, 'steps'), 0);
});

test('All Years retains undated daily rows; dated filters exclude them', () => {
  const api = createHarness();
  const all = api.filtered('daily');
  assert.ok(all.some(row => !api.date(row)), 'fixture should exercise un-dated source rows');
  api.setFilter('2026', '', '11');
  assert.ok(api.filtered('daily').every(row => {
    const d = api.date(row);
    return d && d.getFullYear() === 2026 && d.getMonth() === 10;
  }));
});

test('month goal duration and podcast target use calendar days', () => {
  const api = createHarness();
  api.setFilter('2026', '', '11');
  assert.equal(api.goalDays(), 25);
  assert.ok(Math.abs(api.podcastTarget() - (31 * 25 / 30)) < 1e-9);
});

test('All Years plus month supports current-year chart bounds and YoY goals', () => {
  const api = createHarness();
  api.setFilter('', '', '11');
  const bounds = api.selectedBounds();
  assert.equal(bounds[0].getFullYear(), 2026);
  assert.equal(bounds[0].getMonth(), 10);
  assert.equal(api.goalDays(), 25);
  assert.ok(Math.abs(api.podcastTarget() - (31 * 25 / 30)) < 1e-9);
  assert.match(api.comparison()[0].detail, /Nov 2025/);
});

test('All Years plus quarter aligns elapsed days to the previous quarter', () => {
  const api = createHarness();
  api.setFilter('', 'Q4', '');
  assert.equal(api.goalDays(), 56);
  const previous = api.priorBounds(api.selectedBounds());
  assert.equal(previous[0].getMonth(), 6);
  assert.equal(previous[1].getMonth(), 7);
  assert.equal(previous[1].getDate(), 26);
});

test('quick 7-day comparison uses two adjacent seven-day windows', () => {
  const api = createHarness();
  api.setQuick('7D');
  const current = api.selectedBounds();
  const previous = api.priorBounds(current);
  assert.equal((current[1] - current[0]) / 86400000, 7);
  assert.equal((previous[1] - previous[0]) / 86400000, 7);
  assert.equal(+previous[1], +current[0]);
});

test('lifetime All Years does not invent a dated goal period', () => {
  const api = createHarness();
  api.setFilter();
  assert.equal(api.goalDays(), null);
  assert.equal(api.selectedBounds(), null);
});

test('step average excludes missing observations but includes recorded zero days', () => {
  const api = createHarness();
  api.setData({
    daily: [{ Date: '2026-11-25', 'Sleep Minutes': 60 }],
    study: [],
    podcast: [],
    health: [
      { Date: '2026-11-25', Steps: 10000 },
      { Date: '2026-11-24', Steps: '' },
      { Date: '2026-11-23', Steps: 0 }
    ]
  });
  const kpis = api.kpiValues(api.rows('daily'), api.rows('study'), api.rows('podcast'), api.rows('health'));
  assert.equal(kpis[2], 5000);
});

test('zero previous-period baseline produces N/A percentage rather than division by zero', () => {
  const api = createHarness();
  api.setData({
    daily: [
      { Date: '2026-11-25', 'Sleep Minutes': 60 },
      { Date: '2026-10-25', 'Sleep Minutes': 0 }
    ],
    study: [], podcast: [], health: []
  });
  api.setFilter('2026', '', '11');
  const sleep = api.comparison()[0];
  assert.equal(sleep.current, 1);
  assert.equal(sleep.previous, 0);
  assert.equal(sleep.change, null);
});

test('All Years plus quarter compares with the immediately preceding quarter', () => {
  const api = createHarness();
  api.setData({
    daily: [
      { Date: '2026-10-01', 'Sleep Minutes': 120 },
      { Date: '2026-07-01', 'Sleep Minutes': 60 },
      { Date: '2025-10-01', 'Sleep Minutes': 30 }
    ],
    study: [], podcast: [], health: []
  });
  api.setFilter('', 'Q4', '');
  const sleep = api.comparison()[0];
  assert.equal(sleep.current, 2);
  assert.equal(sleep.previous, 1);
  assert.match(sleep.detail, /Jul 2026/);
  assert.doesNotMatch(sleep.detail, /Oct 2025/);
});


test('All Years plus month chart comparison uses the same month last year', () => {
  const api = createHarness();
  api.setFilter('', '', '11');
  const current = api.selectedBounds();
  const previous = api.priorBounds(current);
  assert.equal(previous[0].getFullYear(), 2025);
  assert.equal(previous[0].getMonth(), 10);
  assert.equal(previous[1].getFullYear(), 2025);
  assert.equal(previous[1].getMonth(), 10);
  assert.equal(previous[1].getDate(), 26);
});

test('month and quarter filters without a year scope data to the current year', () => {
  const api = createHarness();
  api.setData({
    daily: [
      { Date: '2026-11-01', 'Sleep Minutes': 60 },
      { Date: '2025-11-01', 'Sleep Minutes': 120 },
      { Date: '2026-10-01', 'Sleep Minutes': 180 }
    ],
    study: [], podcast: [], health: []
  });
  api.setFilter('', '', '11');
  assert.deepEqual(api.filtered('daily').map(r => r.Date), ['2026-11-01']);
  api.setFilter('', 'Q4', '');
  assert.deepEqual(api.filtered('daily').map(r => r.Date), ['2026-11-01', '2026-10-01']);
});
