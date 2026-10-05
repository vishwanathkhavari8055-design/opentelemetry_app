/**
 * ResourceUsageView is Settings → Resources: CPU, Memory, Disk and NFS from one
 * GET /infrastructure/utilization. Guarded here: the first load shows every
 * card as loading; each card prints its backend-supplied scope, headline and
 * percentage; byte cards caption the bar with FREE space while limit cards
 * caption headroom (or "over limit"); an unavailable tile prints its reason,
 * never zeros; a stale reading is flagged; a transport failure raises a banner;
 * the refresh button bypasses the server cache; and the screen polls every 20s
 * but not while the tab is hidden, re-reading when it becomes visible again.
 */
import '../../../support/dom.mjs';
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch } from '../../../support/fetch.mjs';

const React = (await import('react')).default;
const {
  render, screen, fireEvent, cleanup, waitFor, act,
} = await import('@testing-library/react');
const { default: ResourceUsageView } = await import('../../../../src/components/resources/ResourceUsageView.jsx');

const h = React.createElement;
const GB = 1024 ** 3;

const ITEMS = [
  {
    kind: 'CPU', available: true, usedPercent: 41, detail: '2.05 / 5 cores', scope: 'tiotopenobserve pods', lastSeenAgoSec: 30,
  },
  {
    kind: 'MEMORY', available: true, usedPercent: 118.4, detail: '5.9 / 5 GiB', scope: 'tiotopenobserve pods', lastSeenAgoSec: 300,
  },
  {
    kind: 'DISK', available: true, usedPercent: 80, usedBytes: 80 * GB, freeBytes: 20 * GB, totalBytes: 100 * GB,
    scope: 'real filesystems', detail: '3 nodes', lastSeenAgoSec: 3900, lastSeen: '2026-09-25T10:00:00Z',
  },
  { kind: 'NFS_STORAGE', available: false, message: 'kubelet volume stream missing' },
];

let restore = () => {};
let errSpy;
afterEach(() => {
  cleanup();
  restore();
  restore = () => {};
  errSpy?.mock.restore();
  errSpy = undefined;
  mock.timers.reset();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});

const mount = (answer, props = {}) => {
  const stub = stubFetch([[/\/infrastructure\/utilization/, answer]]);
  restore = stub.restore;
  render(h(ResourceUsageView, props));
  return stub;
};
const card = (title) => screen.getByRole('heading', { name: title }).closest('section');

describe('ResourceUsageView', () => {
  it('shows every card loading on the first read', async () => {
    mount({ items: ITEMS });
    assert.ok(screen.getByRole('heading', { name: 'Resources' }));
    assert.equal(screen.getAllByText('Loading…').length, 4);
    await waitFor(() => assert.equal(screen.queryAllByText('Loading…').length, 0));
  });

  it('prints each card from its own tile, scope and captions included', async () => {
    mount({ items: ITEMS });
    await waitFor(() => assert.ok(card('CPU').textContent.includes('2.05 / 5 cores')));

    const cpu = card('CPU').textContent;
    assert.match(cpu, /tiotopenobserve pods/);
    assert.match(cpu, /41\.0%/);
    assert.match(cpu, /59\.0% headroom/);
    assert.match(cpu, /Reading just now/);

    const mem = card('Memory').textContent;
    assert.match(mem, /118\.4%/);
    assert.match(mem, /over limit by 18\.4%/);
    assert.match(mem, /Reading 5 min old/);
    // The bar is clamped even though the figure is not.
    const bar = card('Memory').querySelector('progress');
    assert.equal(bar.getAttribute('aria-valuenow'), '100');

    const disk = card('Disk').textContent;
    assert.match(disk, /20\.00 GB free of 100\.00 GB/);
    assert.match(disk, /Used80\.00 GB/);
    assert.match(disk, /Capacityused \+ free100\.00 GB/);
    assert.match(disk, /Reading 1h 5m old — collector has gone quiet · 3 nodes/);
    assert.match(card('Disk').querySelector('.rs-headline-pct').className, /is-warn/);

    // Unavailable: the reason, not dashes.
    assert.match(card('NFS Storage').textContent, /kubelet volume stream missing/);
    assert.match(card('NFS Storage').textContent, /persistent volume claims/);

    // Header: freshest sample, and when the screen last checked.
    assert.match(document.body.textContent, /Reading just now/);
    assert.match(document.body.textContent, /auto-refresh 20s, checked just now/);
  });

  it('marks a critical reading and a missing tile with default text', async () => {
    mount({
      items: [
        { kind: 'CPU', available: true, usedPercent: 95, detail: '4.8 / 5 cores', lastSeenAgoSec: 7200 },
      ],
    });
    await waitFor(() => assert.ok(card('CPU').textContent.includes('4.8 / 5 cores')));
    assert.match(card('CPU').querySelector('.rs-headline-pct').className, /is-critical/);
    assert.match(card('CPU').textContent, /Reading 2h old — collector has gone quiet/);
    assert.match(card('Memory').textContent, /No reading available\./);
    // Header age flagged stale.
    const asof = document.querySelector('.rs-asof.is-stale');
    assert.match(asof.textContent, /Reading 2h old/);
  });

  it('shows a banner when the request itself fails', async () => {
    errSpy = mock.method(console, 'error', () => {});
    mount({ status: 503, body: {} });
    await screen.findByRole('alert');
    assert.match(screen.getByRole('alert').textContent, /HTTP error! status: 503/);
    assert.match(card('CPU').textContent, /No reading available\./);
  });

  it('refresh asks the backend to bypass its cache', async () => {
    const { calls } = mount({ items: ITEMS });
    await waitFor(() => assert.equal(calls.length, 1));
    assert.doesNotMatch(calls[0].url, /refresh=true/);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh resource figures' }));
    await waitFor(() => assert.equal(calls.length, 2));
    assert.match(calls[1].url, /refresh=true/);
    // No flicker back to loading on a later read.
    assert.equal(screen.queryAllByText('Loading…').length, 0);
  });

  it('polls every 20s, skips while hidden and re-reads when visible again', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    const { calls } = mount({ items: ITEMS });
    await waitFor(() => assert.equal(calls.length, 1));
    await act(async () => { mock.timers.tick(20_000); });
    await waitFor(() => assert.equal(calls.length, 2));

    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    await act(async () => { mock.timers.tick(20_000); });
    document.dispatchEvent(new Event('visibilitychange'));
    assert.equal(calls.length, 2);

    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => assert.equal(calls.length, 3));
  });

  it('re-reads when the active organization changes', async () => {
    const stub = stubFetch([[/\/infrastructure\/utilization/, { items: ITEMS }]]);
    restore = stub.restore;
    const { rerender } = render(h(ResourceUsageView, { activeOrg: 'default' }));
    await waitFor(() => assert.equal(stub.calls.length, 1));
    rerender(h(ResourceUsageView, { activeOrg: 'DLH' }));
    await waitFor(() => assert.equal(stub.calls.length, 2));
  });
});
