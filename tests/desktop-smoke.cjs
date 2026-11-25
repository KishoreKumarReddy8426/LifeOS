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
    const file = path.resolve(root, '.' + pathname);
    if (!file.startsWith(root + path.sep) && file !== path.join(root, 'index.html')) {
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

    for (const [tab, canvas] of [['daily', 'dailyChart'], ['study', 'studyChart'], ['podcast', 'podcastChart'], ['health', 'healthChart']]) {
      await page.locator('.tab[data-tab="' + tab + '"]').click();
      await page.waitForFunction(id => window.Chart && window.Chart.getChart(id), canvas, { timeout: 15000 });
      assert.ok(await page.locator('#' + tab + 'Table table tbody tr').count() > 0, tab + ' tracker table should render');
    }
    console.log('PASS: all four tracker tabs render charts and data tables');

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
