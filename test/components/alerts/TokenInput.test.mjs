/**
 * TokenInput is the alert editor's free-form chip list (tags, fingerprint
 * fields). Guarded: Enter, comma and BLUR all commit the draft — blur because
 * the natural next gesture is clicking Save, and a draft left in the box must
 * not silently vanish; duplicates and blanks are ignored; Backspace on an empty
 * box removes the last chip; suggestions exclude what is chosen and cap at 8.
 */
import '../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { useState } = React;
const { render, screen, fireEvent, cleanup } = await import('@testing-library/react');
const { default: TokenInput } = await import('../../../src/components/alerts/TokenInput.jsx');

/** Holds the value in state, as the editor does, and records every change. */
const renderTokens = (props = {}, initial = []) => {
  const changes = [];
  function Harness() {
    const [value, setValue] = useState(initial);
    return React.createElement(TokenInput, {
      value, ariaLabel: 'Tags', placeholder: 'Add tag',
      onChange: (v) => { changes.push(v); setValue(v); },
      ...props,
    });
  }
  const utils = render(React.createElement(Harness));
  return { ...utils, changes, input: screen.getByLabelText('Tags') };
};

describe('TokenInput', () => {
  afterEach(cleanup);

  it('commits on Enter, comma and blur, trimming and ignoring blanks and duplicates', () => {
    const { changes, input } = renderTokens();
    assert.equal(input.placeholder, 'Add tag');
    fireEvent.change(input, { target: { value: '  prod ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'db' } });
    fireEvent.keyDown(input, { key: ',' });
    fireEvent.change(input, { target: { value: 'prod' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'late' } });
    fireEvent.blur(input);
    assert.deepEqual(changes, [['prod'], ['prod', 'db'], ['prod', 'db', 'late']]);
    assert.equal(input.value, '');
    assert.equal(input.placeholder, '', 'placeholder hides once there are chips');
    assert.ok(screen.getByText('late'));
  });

  it('applies normalise to every committed token', () => {
    const { changes, input } = renderTokens({ normalise: (s) => s.trim().toLowerCase() });
    fireEvent.change(input, { target: { value: 'PROD' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    assert.deepEqual(changes, [['prod']]);
  });

  it('removes a chip by its × and the last chip by Backspace on an empty box', () => {
    const { changes, input } = renderTokens({}, ['a', 'b', 'c']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove b' }));
    fireEvent.keyDown(input, { key: 'Backspace' });
    assert.deepEqual(changes, [['a', 'c'], ['a']]);
    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.keyDown(input, { key: 'Backspace' });
    fireEvent.keyDown(input, { key: 'a' });
    assert.equal(changes.length, 2, 'Backspace with a draft edits the draft, not the chips');
  });

  it('offers at most 8 suggestions, minus what is taken, and commits one on click', () => {
    const suggestions = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', ''];
    const { changes } = renderTokens({ suggestions }, ['a']);
    const chips = screen.getAllByRole('button').filter((b) => b.textContent.startsWith('+ '));
    assert.deepEqual(chips.map((b) => b.textContent), ['+ b', '+ c', '+ d', '+ e', '+ f', '+ g', '+ h', '+ i']);
    fireEvent.click(screen.getByRole('button', { name: '+ c' }));
    assert.deepEqual(changes, [['a', 'c']]);
    assert.equal(screen.queryByRole('button', { name: '+ c' }), null);
  });

  it('disables input, chip removal and suggestions when disabled; a box click focuses the input', () => {
    const { input } = renderTokens({ disabled: true, suggestions: ['z'] }, ['a']);
    assert.equal(input.disabled, true);
    assert.equal(screen.getByRole('button', { name: 'Remove a' }).disabled, true);
    assert.equal(screen.getByRole('button', { name: '+ z' }).disabled, true);
    cleanup();
    const again = renderTokens();
    fireEvent.click(again.input.parentElement);
    assert.equal(document.activeElement, again.input);
  });

  it('treats a missing value as no chips', () => {
    render(React.createElement(TokenInput, { value: undefined, onChange: () => {}, ariaLabel: 'Tags' }));
    assert.equal(screen.queryAllByRole('button').length, 0);
  });
});
