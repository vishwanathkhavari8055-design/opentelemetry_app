import React from 'react';
import PropTypes from 'prop-types';

/**
 * Highlights search-term occurrences inside an arbitrary text node by
 * wrapping matches in a <mark>. Used by every cell that surfaces user-facing
 * text so the active query term is visually traceable to the matching field.
 *
 * Lived in LogRow.jsx until the columnar and console row layouts were removed;
 * it has no dependency on either, so it moved to its own module rather than
 * keeping a 350-line file alive for one export.
 */
export const HighlightedText = React.memo(function HighlightedText({ text, highlight }) {
  if (!highlight || !text) return text;
  try {
    const escapedHighlight = highlight.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    const parts = String(text).split(new RegExp(`(${escapedHighlight})`, 'gi'));
    // Keyed by where each part starts in the text: unique, and stable for a
    // given text/highlight pair.
    let offset = 0;
    const keyed = parts.map((part) => {
      const start = offset;
      offset += part.length;
      return { part, start };
    });
    return (
      <>
        {keyed.map(({ part, start }) =>
          part.toLowerCase() === highlight.toLowerCase() ? (
            <mark key={start}>{part}</mark>
          ) : (
            part
          )
        )}
      </>
    );
  } catch {
    return text;
  }
});

HighlightedText.propTypes = {
  text: PropTypes.node,
  highlight: PropTypes.string,
};

export default HighlightedText;
