import { useEffect, useRef } from 'react';

/**
 * Close a modal when its backdrop — and only the backdrop — is clicked.
 *
 * Returns a ref for the backdrop element. A click whose target is the backdrop
 * itself calls `onClose`; a click anywhere inside the panel has a different
 * target and is ignored, so the panel no longer needs a stopPropagation wrapper.
 * Bound as a DOM listener so the <dialog> carries no mouse handler of its own.
 */
export default function useBackdropClose(onClose) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const onClick = (e) => { if (e.target === el) onClose(); };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, [onClose]);
  return ref;
}
