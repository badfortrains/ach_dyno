import { test, expect } from '@playwright/test';

test('records demo samples, exports CSV, and recovers the local run after reload', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/', { waitUntil: 'domcontentloaded' }); await expect(page.getByRole('heading', { name: 'Every rep tells a story.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start recording' })).toBeDisabled();
  await page.getByRole('button', { name: 'Try demo' }).click();
  await expect(page.getByRole('button', { name: 'Start recording' })).toBeEnabled();
  await page.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByRole('button', { name: 'Stop recording' })).toBeEnabled();
  await page.waitForTimeout(1250);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.getByText('Demo · local', { exact: true })).toBeVisible();
  await expect(page.getByText('Local backup failed', { exact: false })).toHaveCount(0);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV', exact: false }).click();
  expect((await download).suggestedFilename()).toMatch(/calf-dyno-left.*csv/);
  await page.screenshot({ path: `test-results/${info.project.name}-recorded.png`, fullPage: true });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Demo · local', { exact: true })).toBeVisible();
  await page.getByRole('table').getByRole('button').first().click({ timeout: 5000 });
  await expect(page.getByText('Recorded force trace', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('recovers an interrupted recording from its last committed checkpoint', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' }); await page.getByRole('button', { name: 'Try demo' }).click();
  await expect(page.getByRole('button', { name: 'Start recording' })).toBeEnabled();
  await page.getByRole('button', { name: 'Start recording' }).click();
  await page.waitForTimeout(1300);
  page.on('dialog', dialog => dialog.accept()); await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Demo · local', { exact: true })).toBeVisible();
  await page.getByRole('table').getByRole('button').first().click({ timeout: 5000 });
  await expect(page.getByText('Recovered from last local checkpoint', { exact: false })).toBeVisible();
});

test('rejects invalid device addresses and provides a connection diagnostic page', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' }); await page.getByLabel('Device hostname or IP address').fill('example.com');
  await page.getByRole('button', { name: 'Connect device', exact: false }).click();
  await expect(page.getByRole('alert')).toContainText('private LAN IPv4');
  await page.goto('/connectivity', { waitUntil: 'domcontentloaded' }); await expect(page.getByRole('heading', { name: 'Test your local connection.' })).toBeVisible();
  await page.getByLabel('Device hostname or LAN IPv4 address').fill('ws://user:password@calf-dyno.local');
  await page.getByRole('button', { name: 'Connect & test' }).click();
  await expect(page.getByLabel('Connection diagnostics')).toContainText('Enter a .local hostname');
});

test('exercises device commands and preserves a run across socket loss and reconnect', async ({ page }) => {
  const status = { type: 'status', protocol: 1, bootId: 12, hostname: 'calf-dyno', ip: '192.168.1.42',
    uptimeMs: 1000, adcReady: true, calibrated: true, hasTare: true, busy: false,
    otaActive: false, otaEnabled: true, sampleRateHz: 20 };
  await page.route('http://calf-dyno.local/status', route => route.fulfill({ json: status }));
  let link: import('@playwright/test').WebSocketRoute | undefined;
  let connections = 0, sequence = 0;
  const intervals = new Set<ReturnType<typeof setInterval>>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  await page.routeWebSocket('ws://calf-dyno.local:81/', ws => {
    connections++; link = ws;
    ws.onMessage(data => {
      if (typeof data !== 'string') return;
      const command = JSON.parse(data);
      if (command.type === 'status') ws.send(JSON.stringify(status));
      if (command.type === 'tare') {
        ws.send(JSON.stringify({ ...status, busy: true }));
        const timer = setTimeout(() => {
          ws.send(JSON.stringify({ type: 'ack', id: command.id, ok: true, message: 'Sensor updated and saved to flash.' }));
          ws.send(JSON.stringify(status));
        }, 100);
        timers.add(timer);
      }
    });
    const interval = setInterval(() => ws.send(JSON.stringify({ type: 'sample', bootId: 12, seq: ++sequence,
      ms: sequence * 50, raw: 10000, forceN: 145.5 })), 50);
    intervals.add(interval);
    ws.onClose(() => { clearInterval(interval); intervals.delete(interval); });
  });
  try {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Connect device', exact: false }).click();
    await expect(page.getByRole('button', { name: 'Start recording' })).toBeEnabled();
    await page.getByRole('button', { name: 'Zero sensor', exact: false }).click();
    await expect(page.getByRole('status')).toContainText('Sensor updated and saved');
    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.getByRole('button', { name: 'Stop recording' })).toBeVisible();
    await page.waitForTimeout(300);
    for (const interval of intervals) clearInterval(interval); intervals.clear();
    link!.close({ code: 1001, reason: 'Simulated power loss' });
    await expect(page.getByRole('status')).toContainText('Device connection lost');
    await expect(page.getByText('Local backup', { exact: true })).toBeVisible();
    await expect(page.getByText('Connected', { exact: true })).toBeVisible();
    expect(connections).toBeGreaterThanOrEqual(2);
    await expect(page.getByRole('button', { name: 'Stop recording' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  } finally {
    for (const interval of intervals) clearInterval(interval);
    for (const timer of timers) clearTimeout(timer);
  }
});

test('explains the initial calibration lock and enables calibration after an unloaded tare', async ({ page }) => {
  const status = { type: 'status', protocol: 1, bootId: 34, hostname: 'calf-dyno', ip: '192.168.1.42',
    uptimeMs: 1000, adcReady: true, calibrated: false, hasTare: false, busy: false,
    otaActive: false, otaEnabled: true, sampleRateHz: 20 };
  await page.route('http://calf-dyno.local/status', route => route.fulfill({ json: status }));
  let calibratedMass: number | undefined;
  await page.routeWebSocket('ws://calf-dyno.local:81/', ws => {
    const sendStatus = () => ws.send(JSON.stringify(status));
    let sequence = 0;
    const sendSample = () => ws.send(JSON.stringify({ type: 'sample', bootId: 34, seq: ++sequence,
      ms: 1000 + sequence * 50, raw: 12345, forceN: status.calibrated ? 49.03325 : null }));
    ws.onMessage(data => {
      if (typeof data !== 'string') return;
      const command = JSON.parse(data);
      if (command.type === 'status') { sendStatus(); sendSample(); }
      else if (command.type === 'tare' || command.type === 'calibrate') {
        ws.send(JSON.stringify({ ...status, busy: true }));
        if (command.type === 'tare') status.hasTare = true;
        else { calibratedMass = command.massKg; status.calibrated = true; }
        ws.send(JSON.stringify({ type: 'ack', id: command.id, ok: true, message: 'Sensor updated and saved to flash.' }));
        sendStatus(); sendSample();
      }
    });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Connect device', exact: false }).click();
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  await page.getByText('Sensor calibration & connection help', { exact: true }).click();
  const panel = page.locator('details.calibration');
  const calibrate = panel.getByRole('button', { name: 'Calibrate', exact: true });
  await expect(calibrate).toBeDisabled();
  await expect(panel.locator('#calibration-reason')).toContainText('First unload the cell');
  await panel.getByRole('button', { name: 'Zero sensor', exact: false }).click();
  await expect(calibrate).toBeEnabled();
  await page.getByLabel('Known mass (kg)').fill('0');
  await expect(calibrate).toBeDisabled();
  await expect(panel.locator('#calibration-reason')).toContainText('greater than 0');
  await page.getByLabel('Known mass (kg)').fill('5');
  await calibrate.click();
  await expect(page.getByRole('button', { name: 'Start recording' })).toBeEnabled();
  expect(calibratedMass).toBe(5);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
});
