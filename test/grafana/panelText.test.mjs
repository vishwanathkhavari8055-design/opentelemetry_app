/**
 * Guards the text panel renderer.
 *
 * Grafana dashboard-edit rights are held far more widely than anything in this
 * console, so a text panel's HTML is untrusted input rendered inside it. Each
 * mode must end at the sanitiser: <script>, event handlers, javascript: URLs,
 * iframes and forms go; the headings, rules, tables and inline styles these
 * header panels are made of stay. `code` mode is the one place where printing
 * the characters verbatim is correct. A renderer failure falls back to text
 * rather than taking the dashboard down.
 *
 * DOMPurify needs a DOM, so jsdom is loaded first. The one stubbed method is
 * restored, and console.warn is silenced only for the failure test.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import '../support/dom.mjs';

const { default: DOMPurify } = await import('dompurify');
const { renderPanelText } = await import('../../src/grafana/panelText.js');

describe('renderPanelText', () => {
  it('returns empty text for blank or non-string content', () => {
    assert.deepEqual(renderPanelText('   \n', 'markdown'), { text: '' });
    assert.deepEqual(renderPanelText(null, 'html'), { text: '' });
    assert.deepEqual(renderPanelText(42), { text: '' });
  });

  it('prints code mode verbatim, tags and all', () => {
    const src = '<b>not bold</b>\n# not a heading';
    assert.deepEqual(renderPanelText(src, 'code'), { text: src });
  });

  it('renders markdown (the default when mode is absent) as HTML', () => {
    const { html } = renderPanelText('# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    assert.match(html, /<h1[^>]*>Title<\/h1>/);
    assert.match(html, /<table>/);
    assert.match(html, /<td>1<\/td>/);
  });

  it('keeps an HTML header panel\'s structure and inline style', () => {
    const { html } = renderPanelText('<hr><h1 style="text-align:center">VM Dashboard</h1><hr>', 'html');
    assert.equal(html, '<hr><h1 style="text-align:center">VM Dashboard</h1><hr>');
  });

  it('strips everything executable from HTML mode', () => {
    const { html } = renderPanelText(
      '<p onclick="steal()">hi</p><script>alert(1)</script><a href="javascript:alert(1)">x</a>'
        + '<iframe src="https://evil"></iframe><form><input name="p"></form><style>body{}</style>'
        + '<div data-secret="1">d</div>',
      'html',
    );
    assert.doesNotMatch(html, /onclick|<script|javascript:|<iframe|<form|<input|<style|data-secret/i);
    assert.match(html, /<p>hi<\/p>/);
    assert.match(html, /<a>x<\/a>/);
  });

  it('sanitises inline HTML inside markdown too', () => {
    const { html } = renderPanelText('**bold** <img src=x onerror="alert(1)">', 'markdown');
    assert.match(html, /<strong>bold<\/strong>/);
    assert.doesNotMatch(html, /onerror/);
  });

  it('keeps safe links: http(s), mailto, tel, anchors and paths', () => {
    const { html } = renderPanelText(
      '<a href="https://a">1</a><a href="mailto:x@y">2</a><a href="tel:1">3</a><a href="#s">4</a><a href="/p">5</a><a href="ftp://f">6</a>',
      'html',
    );
    for (const href of ['https://a', 'mailto:x@y', 'tel:1', '#s', '/p']) assert.ok(html.includes(`href="${href}"`), href);
    assert.ok(!html.includes('ftp://'));
  });

  it('falls back to the literal text when rendering throws', () => {
    const originalSanitize = DOMPurify.sanitize;
    const originalWarn = console.warn;
    const warned = [];
    DOMPurify.sanitize = () => { throw new Error('boom'); };
    console.warn = (...args) => { warned.push(args); };
    try {
      assert.deepEqual(renderPanelText('<b>x</b>', 'html'), { text: '<b>x</b>' });
    } finally {
      DOMPurify.sanitize = originalSanitize;
      console.warn = originalWarn;
    }
    assert.equal(warned.length, 1);
    assert.match(String(warned[0][0]), /could not render text panel/);
  });
});
