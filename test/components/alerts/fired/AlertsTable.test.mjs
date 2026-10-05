/**
 * AlertsTable: the fired-alert rows and their Actions cell. Guarded — sort
 * headers report and request the right column; loading shows skeletons and the
 * empty state says whether filters are to blame; each row shows its usage, unit
 * and badges; the Actions menu offers Acknowledge/Resolve and refuses the ones a
 * terminal status cannot take; rows without an id (live-stream rows) cannot be
 * selected, and a read-only user sees the status as plain text; select-all only
 * covers rows that have ids.
 */
import '../../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup, within } = await import('@testing-library/react');
const { default: AlertsTable, absoluteTime } = await import('../../../../src/components/alerts/fired/AlertsTable.jsx');

const FIRING = {
  id: 1, alertName: 'High CPU', serviceName: 'checkout', severity: 'critical', status: 'FIRING',
  triggeredAt: '2026-09-25T10:00:00Z', lastFiredAt: '2026-09-25T10:05:00Z',
  usedLabel: '4040 MB', limitLabel: '5120 MB', aggValue: 78.93, displayValue: '78.9%',
  operator: '>', threshold: 75, observedCount: 4,
  incidentType: 'Resource pressure', episode: 3, affectedCount: 2, newSinceAck: 5, reopenCount: 1,
  parseError: 'bad json',
};
const ACKED = {
  id: 2, alertName: 'Disk', status: 'ACKNOWLEDGED', aggValue: 12, acknowledgedBy: 'ana',
  acknowledgedAt: '2026-09-25T10:00:00Z', episode: 2,
};
const RESOLVED = { id: 3, alertName: 'Mem', status: 'RESOLVED', aggValue: 'n/a', autoResolved: true, episode: 11 };
const CLOSED = { id: 4, alertName: 'Net', status: 'CLOSED', closedBy: 'bo', episode: 22, limitLabel: '10 GB' };
const LIVE = { id: null, fingerprint: 'fp-9', alertName: 'Live one', status: 'FIRING', lastFiredAt: 'x', episode: 23 };
const ORPHAN = { alertName: 'Orphan' };

const renderTable = (props = {}) => {
  const log = [];
  const all = {
    items: [FIRING, ACKED, RESOLVED, CLOSED],
    loading: false, refreshing: false, sortBy: 'lastFiredAt', sortDir: 'desc',
    onSort: (c) => log.push(['sort', c]),
    selected: [],
    onToggleSelect: (id) => log.push(['select', id]),
    onToggleSelectAll: (ids, sel) => log.push(['selectAll', ids, sel]),
    onOpen: (a) => log.push(['open', a.alertName]),
    onAction: (a, action) => log.push(['action', a.alertName, action]),
    pendingId: null, hasFilters: false, canAct: true,
    ...props,
  };
  const utils = render(React.createElement(AlertsTable, all));
  return { ...utils, log };
};

const rowOf = (name) => screen.getByText(name, { selector: '.alerts-name2-btn' }).closest('.alerts-row2');

describe('AlertsTable', () => {
  afterEach(cleanup);

  it('marks the active sort column and requests a column on click', () => {
    const { log, rerender } = renderTable();
    const last = screen.getByRole('button', { name: /^Last Seen/ });
    assert.equal(last.getAttribute('aria-sort'), 'descending');
    assert.match(last.textContent, /↓/);
    assert.equal(screen.getByRole('button', { name: /^Severity/ }).getAttribute('aria-sort'), 'none');
    fireEvent.click(screen.getByRole('button', { name: /^Severity/ }));
    assert.deepEqual(log, [['sort', 'severity']]);

    rerender(React.createElement(AlertsTable, {
      items: [], sortBy: 'lastFiredAt', sortDir: 'asc', onSort() {}, selected: [],
      onToggleSelect() {}, onToggleSelectAll() {}, onOpen() {}, onAction() {},
    }));
    assert.equal(screen.getByRole('button', { name: /^Last Seen/ }).getAttribute('aria-sort'), 'ascending');
  });

  it('shows skeleton rows while the first load is in flight', () => {
    const { container } = renderTable({ items: [], loading: true });
    assert.equal(container.querySelectorAll('.alerts-row2--skeleton').length, 8);
    assert.equal(container.querySelector('.iam-state'), null);
  });

  it('says whether the filters are why nothing shows', () => {
    const { rerender } = renderTable({ items: [], hasFilters: true });
    assert.ok(screen.getByText(/No alerts match these filters/));
    rerender(React.createElement(AlertsTable, {
      items: [], sortBy: 'x', sortDir: 'desc', onSort() {}, selected: [],
      onToggleSelect() {}, onToggleSelectAll() {}, onOpen() {}, onAction() {}, hasFilters: false,
    }));
    assert.ok(screen.getByText(/No alerts recorded yet/));
  });

  it('shows a row\'s service, severity, usage with its unit, and every badge', () => {
    renderTable();
    const row = rowOf('High CPU');
    const text = row.textContent;
    assert.match(text, /checkout/);
    assert.match(text, /critical/);
    assert.match(text, /4040 MB/);
    assert.match(text, /78\.9%/);
    assert.match(text, /Resource pressure/);
    assert.match(text, /3rd/);
    assert.match(text, /×2/);
    assert.match(text, /\+5/);
    assert.match(text, /↻1/);
    assert.ok(within(row).getByTitle('This alert arrived malformed: bad json'));
    assert.equal(row.querySelector('.alerts-usage2').title,
      '78.9% · 4040 MB of 5120 MB · Observed 78.93 · threshold > 75 · 4 matching record(s)');
  });

  it('formats plain usage values and ordinals', () => {
    renderTable({ items: [ACKED, RESOLVED, CLOSED, LIVE] });
    assert.match(rowOf('Disk').textContent, /2nd/);
    assert.match(rowOf('Disk').querySelector('.alerts-usage2').textContent, /^12$/);
    assert.match(rowOf('Mem').textContent, /11th/);
    assert.equal(rowOf('Mem').querySelector('.alerts-usage2').textContent, '—');
    assert.equal(rowOf('Mem').querySelector('.alerts-usage2').title, 'Observed n/a');
    assert.match(rowOf('Net').textContent, /22nd/);
    assert.equal(rowOf('Net').querySelector('.alerts-usage2').title, 'Limit 10 GB');
    assert.match(rowOf('Live one').textContent, /23rd/);
    assert.equal(rowOf('Live one').querySelector('.alerts-usage2').title, 'This alert reported no observed value');
    assert.equal(rowOf('Disk').querySelector('.alerts-sev2').textContent, 'info');
  });

  it('opens the alert when its name is clicked', () => {
    const { log } = renderTable();
    fireEvent.click(screen.getByRole('button', { name: 'High CPU' }));
    assert.deepEqual(log, [['open', 'High CPU']]);
  });

  it('the Actions menu acknowledges or resolves a firing alert, then closes', () => {
    const { log } = renderTable();
    const menuBtn = within(rowOf('High CPU')).getByRole('button', { name: /Actions/ });
    assert.equal(menuBtn.title, 'Open — nobody has taken this on yet');
    fireEvent.click(menuBtn);
    const menu = screen.getByRole('menu');
    const ack = within(menu).getByRole('menuitem', { name: 'Acknowledge' });
    assert.equal(ack.disabled, false);
    fireEvent.click(ack);
    assert.equal(screen.queryByRole('menu'), null);
    fireEvent.click(menuBtn);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Resolve' }));
    assert.deepEqual(log, [['action', 'High CPU', 'acknowledge'], ['action', 'High CPU', 'resolve']]);
  });

  it('the Actions menu closes on Escape and on an outside click', () => {
    renderTable();
    const menuBtn = within(rowOf('High CPU')).getByRole('button', { name: /Actions/ });
    fireEvent.click(menuBtn);
    fireEvent.keyDown(document, { key: 'Escape' });
    assert.equal(screen.queryByRole('menu'), null);
    fireEvent.click(menuBtn);
    fireEvent.mouseDown(screen.getByRole('menu'));
    assert.ok(screen.getByRole('menu'), 'a click inside keeps it open');
    fireEvent.mouseDown(document.body);
    assert.equal(screen.queryByRole('menu'), null);
    fireEvent.click(menuBtn);
    fireEvent.click(menuBtn);
    assert.equal(screen.queryByRole('menu'), null, 'the button toggles it');
  });

  it('an acknowledged alert reads "Acknowledged" and says by whom', () => {
    renderTable();
    const btn = within(rowOf('Disk')).getByRole('button', { name: /Acknowledged/ });
    assert.match(btn.title, /^Acknowledged by ana at /);
  });

  it('refuses Acknowledge and Resolve on resolved and closed alerts, with the reason', () => {
    renderTable();
    fireEvent.click(within(rowOf('Mem')).getByRole('button', { name: /Resolved/ }));
    let menu = screen.getByRole('menu');
    assert.equal(within(menu).getByRole('menuitem', { name: 'Acknowledge' }).title,
      'This alert is resolved — reopen it from the details panel first.');
    assert.equal(within(menu).getByRole('menuitem', { name: 'Resolve' }).title, 'This alert is already resolved.');
    assert.equal(within(menu).getByRole('menuitem', { name: 'Resolve' }).disabled, true);
    fireEvent.keyDown(document, { key: 'Escape' });

    const closedBtn = within(rowOf('Net')).getByRole('button', { name: /Closed/ });
    assert.equal(closedBtn.title, 'Closed by bo');
    fireEvent.click(closedBtn);
    menu = screen.getByRole('menu');
    assert.equal(within(menu).getByRole('menuitem', { name: 'Resolve' }).title,
      'This alert is closed — reopen it from the details panel first.');
  });

  it('describes an auto-resolved alert as the sweep\'s doing', () => {
    renderTable();
    assert.match(within(rowOf('Mem')).getByRole('button', { name: /Resolved/ }).title, /staleness sweep/);
  });

  it('shows an ellipsis and disables the button while the row\'s transition is pending', () => {
    renderTable({ pendingId: 1 });
    const btn = rowOf('High CPU').querySelector('.alerts-menu-btn');
    assert.equal(btn.disabled, true);
    assert.match(btn.textContent, /^…/);
  });

  it('a live row is actionable by fingerprint but never selectable', () => {
    const { log } = renderTable({ items: [LIVE], pendingId: null });
    const check = screen.getByLabelText('Select Live one');
    assert.equal(check.disabled, true);
    assert.match(check.title, /never ingested/);
    fireEvent.click(within(rowOf('Live one')).getByRole('button', { name: /Actions/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Resolve' }));
    assert.deepEqual(log, [['action', 'Live one', 'resolve']]);
    assert.equal(screen.getByLabelText('Select all rows on this page').disabled, true,
      'no id on the page means nothing to select');
  });

  it('a row with neither id nor fingerprint shows its state as text, with the reason', () => {
    renderTable({ items: [ORPHAN] });
    const state = rowOf('Orphan').querySelector('.alerts-actstate');
    assert.equal(state.textContent, 'Firing');
    assert.match(state.title, /neither an alert id nor a fingerprint/);
    assert.equal(rowOf('Orphan').querySelector('.alerts-time2').textContent, '—');
  });

  it('a read-only user sees plain status text and cannot select', () => {
    renderTable({ canAct: false });
    const state = rowOf('Disk').querySelector('.alerts-actstate');
    assert.equal(state.textContent, 'Acknowledged');
    assert.match(state.title, /do not have permission/);
    assert.match(screen.getByLabelText('Select High CPU').title, /do not have permission/);
    assert.equal(screen.getByLabelText('Select all rows on this page').disabled, true);
  });

  it('selects a row, and select-all covers the id-bearing rows only', () => {
    const { log } = renderTable({ items: [FIRING, ACKED, LIVE] });
    fireEvent.click(screen.getByLabelText('Select High CPU'));
    fireEvent.click(screen.getByLabelText('Select all rows on this page'));
    assert.deepEqual(log, [['select', 1], ['selectAll', [1, 2], true]]);
  });

  it('with some selected the header is indeterminate; with all it offers to clear', () => {
    const { rerender, log } = renderTable({ items: [FIRING, ACKED], selected: [1] });
    const head = screen.getByLabelText('Select all rows on this page');
    assert.equal(head.indeterminate, true);
    assert.match(rowOf('High CPU').className, /is-selected/);
    rerender(React.createElement(AlertsTable, {
      items: [FIRING, ACKED], selected: [1, 2], sortBy: 'x', sortDir: 'desc', onSort() {},
      onToggleSelect() {}, onToggleSelectAll: (ids, sel) => log.push(['selectAll', ids, sel]),
      onOpen() {}, onAction() {},
    }));
    fireEvent.click(screen.getByLabelText('Clear selection'));
    assert.deepEqual(log.at(-1), ['selectAll', [1, 2], false]);
  });

  it('absoluteTime pairs the local time with the raw value, and passes junk through', () => {
    assert.equal(absoluteTime(''), '');
    assert.equal(absoluteTime('garbage'), 'garbage');
    assert.match(absoluteTime('2026-09-25T10:00:00Z'), / · 2026-09-25T10:00:00Z$/);
  });
});
