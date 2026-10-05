/**
 * The text panel's content, rendered the way its `mode` asks — safely.
 *
 * ─── Why this is not just `{content}` ───────────────────────────────────────
 *
 * Grafana's text panel has three modes, and real dashboards use all of them. The
 * VM Monitoring dashboard's header panel, for instance, is `mode: 'html'` holding
 *
 *     <hr><h1 style="...">VM Dashboard</h1><hr>
 *
 * Rendering that as plain text prints the tags on screen, which looks like the
 * renderer is broken. Rendering it as raw HTML would hand anyone who can edit a
 * dashboard in Grafana script execution inside this console — a real escalation,
 * because dashboard-edit rights in Grafana are much more widely held than
 * anything in this application.
 *
 * So: parse per mode, then SANITISE. DOMPurify strips `<script>`, event-handler
 * attributes, `javascript:` URLs and everything else executable, while keeping
 * the headings, rules, tables and inline styles these panels are actually made of.
 *
 * ─── Both libraries are already here ────────────────────────────────────────
 *
 * `marked` and `dompurify` arrive with @grafana/data / @grafana/ui — Grafana uses
 * them for exactly this. They are declared in package.json anyway, because a
 * direct import of a transitive dependency is a dependency that can vanish under
 * you on an unrelated upgrade.
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * `style` is allowed, deliberately.
 *
 * These panels are used as dashboard section headers and they carry their layout
 * inline (`text-align`, `background-color`, `padding`). Stripping it would leave
 * the content correct and the dashboard looking wrong. DOMPurify still removes
 * anything executable from a style attribute, and `ALLOW_DATA_ATTR: false` keeps
 * data-* out since nothing here reads them.
 */
const PURIFY_OPTIONS = {
  ALLOWED_URI_REGEXP: /^(?:https?|mailto|tel|#|\/)/i,
  ALLOW_DATA_ATTR: false,
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input'],
  FORBID_ATTR: ['srcdoc', 'formaction'],
};

marked.setOptions({ gfm: true, breaks: false });

/**
 * Turn a text panel's content into `{ html }` or `{ text }`.
 *
 * @param {string} content    raw panel content, variables already interpolated
 * @param {string} mode       Grafana's `options.mode`: markdown | html | code
 * @returns {{html?: string, text?: string}} `html` is sanitised and safe to
 *          inject; `text` must be rendered as text
 */
export function renderPanelText(content, mode) {
  const raw = typeof content === 'string' ? content : '';
  if (!raw.trim()) return { text: '' };

  // `code` means "show me the source", so it is the one mode where printing the
  // characters verbatim IS the correct rendering.
  if (mode === 'code') {
    return { text: raw };
  }

  try {
    // Grafana treats an absent mode as markdown. Markdown also passes inline HTML
    // through, which is why both modes end at the same sanitiser rather than the
    // markdown path being treated as inherently safe.
    const html = mode === 'html' ? raw : marked.parse(raw);
    return { html: DOMPurify.sanitize(html, PURIFY_OPTIONS) };
  } catch (err) {
    // A malformed panel must not take its dashboard down. Falling back to the
    // literal characters is both safe and diagnosable — you can see what broke.
    console.warn('[dashboards] could not render text panel content', err);
    return { text: raw };
  }
}
