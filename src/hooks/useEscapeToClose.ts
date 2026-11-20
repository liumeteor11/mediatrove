import { useEffect } from 'react';

/**
 * Close the current modal on Escape, and keep the event from reaching
 * page-level Escape handlers sitting behind it (e.g. the collection grid
 * closing its detail overlay or filter dropdowns). Capture phase on window
 * wins over the page's bubble-phase listener, so only the topmost layer
 * reacts.
 *
 * Assumes one hook-modal open at a time (the current stacking — z-50/70/100
 * backdrops block clicks into lower layers — makes that the only reachable
 * case). `enabled` supports always-mounted modals that toggle visibility
 * via an `isOpen` prop.
 */
export function useEscapeToClose(onClose: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, enabled]);
}
