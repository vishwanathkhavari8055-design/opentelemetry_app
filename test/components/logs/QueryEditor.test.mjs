/**
 * The Query Editor strip: Ctrl/Cmd+Enter runs, Tab indents, the gutter tracks
 * line count, full screen toggles (and Escape leaves it), the collapsed header
 * previews the query, and parse errors suppress warnings.
 *
 * Guarded because Ctrl+Enter and the toolbar's "Run query" must be the same
 * action, and because a plain Enter submitting would break multi-line queries.
 */
import '../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup, waitFor } = await import('@testing-library/react');
const { default: QueryEditor } = await import('../../../src/components/logs/QueryEditor.jsx');

const h = React.createElement;

const setup = (props = {}) => {
  const log = { change: [], run: 0, toggle: 0 };
  const all = {
    value: '', onChange: (v) => log.change.push(v), onRun: () => { log.run += 1; },
    onToggleCollapsed: () => { log.toggle += 1; }, ...props,
  };
  const utils = render(h(QueryEditor, all));
  return { ...utils, log, props: all };
};

describe('QueryEditor', () => {
  afterEach(cleanup);

  it('shows filter mode, a line number per line, and reports typing', () => {
    const { log, container } = setup({ value: 'a\nb\nc', placeholder: 'type here' });
    assert.ok(screen.getByText('filter'));
    assert.deepEqual([...container.querySelectorAll('.qe-gutter span')].map((s) => s.textContent), ['1', '2', '3']);
    const ta = screen.getByRole('textbox', { name: 'Query editor' });
    assert.equal(ta.getAttribute('placeholder'), 'type here');
    fireEvent.change(ta, { target: { value: 'severity_text=\'ERROR\'' } });
    assert.deepEqual(log.change, ["severity_text='ERROR'"]);
  });

  it('labels SQL mode', () => {
    setup({ sqlMode: true });
    assert.ok(screen.getByText('SQL'));
  });

  it('runs on Ctrl+Enter and Cmd+Enter but not on plain Enter', () => {
    const { log } = setup({ value: 'x' });
    const ta = screen.getByRole('textbox');
    fireEvent.keyDown(ta, { key: 'Enter' });
    assert.equal(log.run, 0);
    fireEvent.keyDown(ta, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true });
    assert.equal(log.run, 2);
  });

  it('indents with Tab at the cursor, but lets Shift+Tab leave the field', async () => {
    const { log } = setup({ value: 'abcd' });
    const ta = screen.getByRole('textbox');
    ta.setSelectionRange(2, 2);
    fireEvent.keyDown(ta, { key: 'Tab' });
    assert.deepEqual(log.change, ['ab  cd']);
    fireEvent.keyDown(ta, { key: 'Tab', shiftKey: true });
    assert.equal(log.change.length, 1);
    // The cursor is moved past the inserted spaces on the next frame.
    await waitFor(() => assert.equal(ta.selectionStart, 4));
  });

  it('keeps the gutter scrolled with the text area', () => {
    const { container } = setup({ value: 'a' });
    const ta = screen.getByRole('textbox');
    ta.scrollTop = 40;
    fireEvent.scroll(ta);
    assert.equal(container.querySelector('.qe-gutter').scrollTop, 40);
  });

  it('toggles full screen with the button and leaves it on Escape', () => {
    const { container } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    assert.match(container.firstChild.className, /qe--fullscreen/);
    assert.ok(screen.getByRole('button', { name: 'Exit full screen' }));
    fireEvent.keyDown(document, { key: 'a' });
    assert.match(container.firstChild.className, /qe--fullscreen/);
    fireEvent.keyDown(document, { key: 'Escape' });
    assert.doesNotMatch(container.firstChild.className, /qe--fullscreen/);
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Exit full screen' }));
    assert.doesNotMatch(container.firstChild.className, /qe--fullscreen/);
  });

  it('shows the error and hides warnings; shows warnings when there is no error', () => {
    const { rerender, props } = setup({ error: 'Expected SELECT', warnings: ['w1'] });
    assert.equal(screen.getByRole('alert').textContent, 'Expected SELECT');
    assert.equal(screen.queryByText('w1'), null);
    rerender(h(QueryEditor, { ...props, error: null, warnings: ['w1', 'w2'] }));
    assert.equal(screen.queryByRole('alert'), null);
    assert.ok(screen.getByText('w1'));
    assert.ok(screen.getByText('w2'));
  });

  it('collapses to a header with a preview, and the header toggles', () => {
    const { log } = setup({ collapsed: true, value: "  service_name='x'  " });
    const btn = screen.getByRole('button', { name: /Query Editor/ });
    assert.equal(btn.getAttribute('aria-expanded'), 'false');
    assert.ok(screen.getByText("service_name='x'"));
    assert.equal(screen.queryByRole('textbox'), null);
    fireEvent.click(btn);
    assert.equal(log.toggle, 1);
  });

  it('hides from the expanded header too', () => {
    const { log } = setup();
    fireEvent.click(screen.getByTitle('Hide the query editor'));
    assert.equal(log.toggle, 1);
  });
});
