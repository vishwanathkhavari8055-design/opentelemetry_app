/**
 * MetricCatalog is the Explorer's left-hand picker over thousands of names.
 * Guarded here: group facets narrow the list and changing group clears the
 * technology sub-filter (else the intersection is empty); search matches name,
 * help and technology; the list is headed by technology until one is chosen;
 * paging reports how many remain; empty and error states say which they are;
 * and clicking a row hands the whole catalogue entry to the caller.
 */
import '../../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup, within } = await import('@testing-library/react');
const { default: MetricCatalog } = await import('../../../../src/components/metrics/MetricCatalog.jsx');

const h = React.createElement;

const ITEMS = [
  { name: 'jvm_memory_used_bytes', type: 'gauge', help: 'how much heap', unit: 'bytes', group: 'microservice', technology: 'JVM' },
  { name: 'http_requests_total', type: 'counter', help: '', group: 'microservice', technology: 'HTTP' },
  { name: 'pg_up', type: 'gauge', group: 'middleware', technology: 'PostgreSQL' },
  { name: 'odd_metric', type: 'weird', group: 'other' },
];
const GROUPS = [
  { key: 'microservice', label: 'Microservices', count: 2, technologies: [{ name: 'JVM', count: 1 }, { name: 'HTTP', count: 1 }] },
  { key: 'middleware', label: 'Middleware', count: 1, technologies: [{ name: 'PostgreSQL', count: 1 }] },
  { key: 'other', label: 'Other', count: 1, technologies: [] },
];

const renderCatalog = (props = {}) => {
  const picked = [];
  const utils = render(h(MetricCatalog, {
    items: ITEMS, groups: GROUPS, total: 4, onSelect: (m) => picked.push(m), ...props,
  }));
  return { ...utils, picked };
};
const metricNames = () => [...document.querySelectorAll('.mv-metric-name')].map((n) => n.textContent);
const search = () => screen.getByRole('searchbox');

describe('MetricCatalog', () => {
  afterEach(cleanup);

  it('lists every metric under technology headings with the total', () => {
    renderCatalog();
    assert.ok(screen.getByText('4 metrics'));
    assert.deepEqual(metricNames(), ['jvm_memory_used_bytes', 'http_requests_total', 'pg_up', 'odd_metric']);
    const heads = [...document.querySelectorAll('.mv-group-head')].map((n) => n.textContent);
    assert.deepEqual(heads, ['JVM', 'HTTP', 'PostgreSQL', 'Unclassified']);
    // An unknown type falls back to the "?" badge.
    assert.ok(screen.getByText('?'));
  });

  it('hands the whole entry to onSelect and marks the selected row', () => {
    const { picked } = renderCatalog({ selected: 'pg_up' });
    fireEvent.click(screen.getByText('http_requests_total'));
    assert.equal(picked[0].type, 'counter');
    assert.match(screen.getByText('pg_up').closest('button').className, /is-on/);
  });

  it('narrows by group, offers its technologies, then by technology', () => {
    renderCatalog();
    const facets = screen.getByRole('group', { name: 'Filter metrics by source' });
    fireEvent.click(within(facets).getByText('Microservices'));
    assert.deepEqual(metricNames(), ['jvm_memory_used_bytes', 'http_requests_total']);
    assert.ok(screen.getByText('2 of 4'));
    assert.match(document.body.textContent, /Micrometer and the OTel SDK/);
    assert.equal(search().getAttribute('placeholder'), 'Search Microservices…');

    const techs = screen.getByRole('group', { name: 'Filter Microservices by technology' });
    fireEvent.click(within(techs).getByText('JVM'));
    assert.deepEqual(metricNames(), ['jvm_memory_used_bytes']);
    // One technology chosen: no heading repeating the chip.
    assert.equal(document.querySelectorAll('.mv-group-head').length, 0);

    // Switching group clears the technology rather than emptying the list.
    fireEvent.click(within(facets).getByText('Middleware'));
    assert.deepEqual(metricNames(), ['pg_up']);
    // A single-technology group shows no sub-filter.
    assert.equal(screen.queryByRole('group', { name: /by technology/ }), null);

    // Clicking the active facet again turns it off; "All" also resets.
    fireEvent.click(within(facets).getByText('Middleware'));
    assert.equal(metricNames().length, 4);
    fireEvent.click(within(facets).getByText('Other'));
    fireEvent.click(within(facets).getByText('All'));
    assert.equal(metricNames().length, 4);
  });

  it('toggles a technology off by clicking it again', () => {
    renderCatalog();
    fireEvent.click(screen.getByText('Microservices'));
    const techs = screen.getByRole('group', { name: /by technology/ });
    fireEvent.click(within(techs).getByText('HTTP'));
    assert.deepEqual(metricNames(), ['http_requests_total']);
    fireEvent.click(within(techs).getByText('HTTP'));
    assert.equal(metricNames().length, 2);
  });

  it('searches the name, the help text and the technology', () => {
    renderCatalog();
    fireEvent.change(search(), { target: { value: 'heap' } });
    assert.deepEqual(metricNames(), ['jvm_memory_used_bytes']);
    fireEvent.change(search(), { target: { value: 'postgres' } });
    assert.deepEqual(metricNames(), ['pg_up']);
    fireEvent.change(search(), { target: { value: 'HTTP_REQ' } });
    assert.deepEqual(metricNames(), ['http_requests_total']);
  });

  it('says when nothing matches, naming the group', () => {
    renderCatalog();
    fireEvent.click(screen.getByText('Middleware'));
    fireEvent.change(search(), { target: { value: 'zzz' } });
    assert.match(document.body.textContent, /No metric matches “zzz” in Middleware\./);
  });

  it('says a group is empty when no item belongs to it', () => {
    renderCatalog({ items: ITEMS.slice(0, 1) });
    fireEvent.click(screen.getByText('Other'));
    assert.ok(screen.getByText('No metric in this group.'));
  });

  it('shows loading, then the error reason instead of an empty list', () => {
    const { rerender } = renderCatalog({ items: [], loading: true });
    assert.ok(screen.getByText('Loading…'));
    rerender(h(MetricCatalog, { items: [], groups: [], error: 'HTTP 502', onSelect() {} }));
    assert.match(document.body.textContent, /Catalogue unavailable — HTTP 502/);
    assert.equal(screen.queryByText('No metric in this group.'), null);
    // No groups from an older backend: no facets at all.
    assert.equal(screen.queryByRole('group'), null);
  });

  it('pages a long list and reveals more on demand', () => {
    const many = Array.from({ length: 70 }, (_, i) => ({ name: `m_${String(i).padStart(2, '0')}`, type: 'gauge' }));
    render(h(MetricCatalog, { items: many, total: 70, onSelect() {} }));
    assert.equal(metricNames().length, 60);
    assert.equal(document.querySelectorAll('.mv-group-head').length, 0);
    fireEvent.click(screen.getByText(/Show more — 10 remaining/));
    assert.equal(metricNames().length, 70);
    assert.equal(screen.queryByText(/Show more/), null);
  });
});
