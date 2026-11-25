const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const mime = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8' };

(async () => {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end('Forbidden'); return;
    }
    fs.readFile(file, (err, body) => {
      if (err) { res.writeHead(404).end('Not found'); return; }
      res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    });
  });
  await new Promise(resolve => server.listen(4173, '127.0.0.1', resolve));

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

  try {
    const response = await page.goto('http://127.0.0.1:4173/', { waitUntil: 'domcontentloaded' });
    assert.equal(response.status(), 200, 'dashboard HTML should load');
    await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Live Sync Active'), null, { timeout: 60000 });
    await page.waitForFunction(() => window.Chart && window.Chart.getChart('trend'), null, { timeout: 30000 });

    assert.equal(await page.title(), 'LifeOS');
    assert.equal(await page.locator('#kpis .card').count(), 4, 'four KPI cards should render');
    assert.ok(await page.locator('#overviewTable table tbody tr').count() > 0, 'overview table should contain records');
    assert.ok(await page.locator('#year option').count() > 1, 'year filter should populate from data');
    assert.ok(await page.evaluate(() => window.Chart.getChart('trend').data.datasets.length > 0), 'overview chart should contain datasets');
    console.log('PASS: dashboard loads, data sync completes, four KPI cards, overview table and chart render');

    await page.locator('#period').selectOption('Quarterly');
    await page.waitForTimeout(250);
    assert.match(await page.locator('#trendTitle').textContent(), /Quarterly/);
    await page.locator('#reset').click();
    await page.locator('#quick button[data-range="7D"]').click();
    assert.ok(await page.locator('#quick button[data-range="7D"]').evaluate(el => el.classList.contains('active')));
    await page.locator('#reset').click();
    console.log('PASS: period selector, reset and 7-day quick filter respond');

    // Verify chart comparison alignment and the sleep-goal reference line against source data.
    const yearLabel = (await page.locator('#year option').nth(1).textContent()).trim();
    await page.locator('#year').selectOption({ label: yearLabel });
    await page.waitForFunction(() => {
      const chart = window.Chart && window.Chart.getChart('trend');
      return chart && chart.data.datasets.some(ds => /previous period$/.test(ds.label)) &&
        chart.data.datasets.some(ds => /target$/.test(ds.label));
    });
    const comparisonCheck = await page.evaluate(async year => {
      const source = await (await fetch('./sheet_data.json')).json();
      const chart = window.Chart.getChart('trend');
      const previous = chart.data.datasets.find(ds => /previous period$/.test(ds.label));
      const target = chart.data.datasets.find(ds => /target$/.test(ds.label));
      const rows = source.daily.filter(row => String(row.Date || '').startsWith((Number(year) - 1) + '-01') &&
        row['Sleep Minutes'] !== '' && row['Sleep Minutes'] !== null && row['Sleep Minutes'] !== undefined);
      return {
        previous: previous.data[0],
        expectedPrevious: rows.reduce((total, row) => total + Number(row['Sleep Minutes']), 0) / 60,
        target: target.data[0],
        januaryDays: new Date(Number(year), 1, 0).getDate()
      };
    }, yearLabel);
    assert.ok(Number.isFinite(comparisonCheck.expectedPrevious) && comparisonCheck.expectedPrevious > 0,
      'previous January should contain source sleep observations');
    assert.ok(Math.abs(comparisonCheck.previous - comparisonCheck.expectedPrevious) < 1e-8,
      'previous-period chart series should align to January of the prior year');
    assert.ok(Math.abs(comparisonCheck.target - comparisonCheck.januaryDays * 8) < 1e-8,
      'January sleep target should equal calendar days multiplied by the daily goal');
    await page.locator('#reset').click();
    console.log('PASS: chart previous-period alignment and sleep target reference line match source data');

    for (const [tab, canvas] of [['daily', 'dailyChart'], ['study', 'studyChart'], ['podcast', 'podcastChart'], ['health', 'healthChart']]) {
      await page.locator('.tab[data-tab="' + tab + '"]').click();
      await page.waitForFunction(id => window.Chart && window.Chart.getChart(id), canvas, { timeout: 15000 });
      assert.ok(await page.locator('#' + tab + 'Table table tbody tr').count() > 0, tab + ' tracker table should render');
    }
    console.log('PASS: all four tracker tabs render charts and data tables');

    // Return to the overview before exercising its table controls; the tracker tabs hide it.
    await page.locator('.tab[data-tab="overview"]').click();
    await page.locator('#overviewTable .tableTools input').waitFor({ state: 'visible' });
    const sleepColumn = page.locator('#overviewTable thead th').nth(1);
    const sortedValues = async () => page.locator('#overviewTable tbody tr').evaluateAll(rows =>
      rows.map(row => Number(row.cells[1].textContent.replace(/,/g, '')))
    );
    await sleepColumn.click();
    const ascending = await sortedValues();
    assert.deepEqual(ascending, [...ascending].sort((a, b) => a - b), 'numeric table columns should sort ascending');
    await sleepColumn.click();
    const descending = await sortedValues();
    assert.deepEqual(descending, [...descending].sort((a, b) => b - a), 'numeric table columns should sort descending');
    assert.ok(await page.locator('#overviewTable td.highCell').count() > 0,
      'conditional formatting should mark the highest numeric value');
    console.log('PASS: table numeric sorting and conditional formatting');
    await page.locator('#overviewTable .tableTools input').fill('no-such-lifeos-row-xyz');
    assert.equal(await page.locator('#overviewTable table tbody tr:visible').count(), 0, 'table search should filter rows');
    await page.locator('#overviewTable .tableTools input').fill('');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#overviewTable .tableTools button').click()
    ]);
    assert.match(download.suggestedFilename(), /overviewTable\.csv/);
    console.log('PASS: table search and CSV export work');

    await page.locator('#theme').click();
    assert.ok(await page.locator('body').evaluate(el => el.classList.contains('light')), 'light theme should activate');
    await page.locator('#theme').click();
    assert.ok(!(await page.locator('body').evaluate(el => el.classList.contains('light'))), 'dark theme should restore');
    await page.locator('#goalButton').click();
    await page.locator('#goalDialog input[name="sleep"]').fill('7.5');
    await page.locator('#goalForm button[type="submit"]').click();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('lifeos.goals')).sleep), 7.5);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Live Sync Active'), null, { timeout: 60000 });
    await page.locator('#goalButton').click();
    assert.equal(await page.locator('#goalDialog input[name="sleep"]').inputValue(), '7.5', 'goal setting should persist after reload');
    await page.locator('#goalCancel').click();
    await page.evaluate(() => localStorage.removeItem('lifeos.goals'));
    console.log('PASS: light/dark theme toggle and saved goal persistence');

    await page.locator('#navToggle').click();
    assert.ok(await page.locator('body').evaluate(el => el.classList.contains('navClosed')), 'sidebar toggle should collapse navigation');
    await page.locator('#navToggle').click();

    // Exercise real phone and tablet viewports in fresh browser contexts.
    for (const viewport of [
      { name: 'small-phone', width: 320, height: 740 },
      { name: 'phone', width: 390, height: 844 },
      { name: 'tablet', width: 768, height: 1024 }
    ]) {
      const mobile = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 });
      const mobileErrors = [];
      mobile.on('pageerror', error => mobileErrors.push(error.message));
      const mobileResponse = await mobile.goto('http://127.0.0.1:4173/', { waitUntil: 'domcontentloaded' });
      assert.equal(mobileResponse.status(), 200, viewport.name + ': dashboard should load');
      await mobile.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Live Sync Active'), null, { timeout: 60000 });
      await mobile.waitForFunction(() => window.Chart && window.Chart.getChart('trend'), null, { timeout: 30000 });

      const layout = await mobile.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        document: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
        cards: getComputedStyle(document.querySelector('#kpis')).gridTemplateColumns,
        nav: document.querySelector('.tabs').getBoundingClientRect().toJSON(),
        header: document.querySelector('.head').getBoundingClientRect().toJSON(),
        chart: document.querySelector('#trend').getBoundingClientRect().toJSON(),
        tableWrap: document.querySelector('#overviewTable').getBoundingClientRect().toJSON()
      }));
      assert.ok(layout.document <= layout.viewport + 1, viewport.name + ': page must not have horizontal overflow (' + layout.document + ' > ' + layout.viewport + ')');
      assert.ok(layout.body <= layout.viewport + 1, viewport.name + ': body must not have horizontal overflow');
      assert.ok(layout.nav.width > 0 && layout.nav.height > 0, viewport.name + ': navigation should remain visible');
      assert.ok(layout.header.width <= layout.viewport + 1, viewport.name + ': header should fit viewport');
      assert.ok(layout.chart.width > 0 && layout.chart.width <= layout.viewport + 1, viewport.name + ': chart should fit viewport');
      assert.ok(layout.tableWrap.width <= layout.viewport + 1, viewport.name + ': table container should fit viewport');
      assert.equal(await mobile.locator('#kpis .card').count(), 4, viewport.name + ': all KPI cards should remain visible');
      await mobile.locator('#period').selectOption('Quarterly');
      assert.match(await mobile.locator('#trendTitle').textContent(), /Quarterly/, viewport.name + ': period filter should remain usable');
      await mobile.locator('#navToggle').click();
      assert.ok(await mobile.locator('body').evaluate(el => el.classList.contains('navClosed')), viewport.name + ': navigation toggle should work');
      await mobile.locator('#navToggle').click();
      await mobile.screenshot({ path: path.join(root, 'artifacts', viewport.name + '.png'), fullPage: true });
      assert.deepEqual(mobileErrors, [], viewport.name + ': no uncaught browser errors');
      await mobile.close();
      console.log('PASS: ' + viewport.name + ' responsive layout, navigation, filters and charts (' + viewport.width + 'px)');
    }
    console.log('MOBILE_RESPONSIVE_TESTS_PASSED');

    await page.screenshot({ path: path.join(root, 'artifacts', 'desktop-dashboard.png'), fullPage: true });
    assert.deepEqual(pageErrors, [], 'page should not throw uncaught JavaScript errors');
    assert.deepEqual(consoleErrors, [], 'browser console should be free of errors');
    console.log('PASS: desktop navigation and zero browser JavaScript/console errors');
    console.log('DESKTOP_BROWSER_TESTS_PASSED');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
