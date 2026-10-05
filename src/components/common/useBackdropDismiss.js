import { useEffect, useRef } from 'react';

/**
 * Click-outside-to-close for a modal whose backdrop is the <dialog> itself.
 *
 * Returns a ref for the backdrop. `onDismiss` runs only when the click lands on
 * the backdrop, not on anything inside the panel, so the panel no longer needs
 * an onClick that stops propagation. A native listener rather than an onClick
 * prop, because a <dialog> is not a control and should not carry one.
 */
export default function useBackdropDismiss(onDismiss) {
  const ref = useRef(null);
  const latest = useRef(onDismiss);
  latest.current = onDismiss;

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const onClick = (e) => { if (e.target === el) latest.current(); };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, []);

  return ref;
}
