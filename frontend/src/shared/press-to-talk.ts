/** One held source owns a press. Releasing/cancelling always wins, including
 * while microphone permission or track publication is still pending. */
export function bindPressToTalk(button: HTMLButtonElement, options: {
  available: () => boolean;
  change: (pressed: boolean, immediate?: boolean) => void;
  unlock: () => void;
}): () => void {
  let source: string | null = null;
  const controller = new AbortController();
  const listener = { signal: controller.signal };
  const release = (immediate = false) => {
    if (source === null) return;
    source = null;
    options.change(false, immediate);
  };
  const press = (next: string) => {
    if (source !== null || !options.available()) return;
    source = next;
    options.unlock();
    options.change(true);
  };
  button.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    press(`pointer:${event.pointerId}`);
  }, listener);
  const pointerRelease = (event: PointerEvent) => {
    if (source === `pointer:${event.pointerId}`) release(event.type !== 'pointerup');
  };
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
    button.addEventListener(name, pointerRelease, listener);
  }
  document.addEventListener('keydown', event => {
    if (event.repeat) {
      if (source === `key:${event.code}`) event.preventDefault();
      return;
    }
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target instanceof Element ? event.target : null;
    if (document.querySelector('dialog[open]')) return;
    if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
    if (target?.closest('button, a, [role="button"]') && target !== button) return;
    if (event.code !== 'Space' && !(event.code === 'Enter' && target === button)) return;
    if (!options.available()) return;
    event.preventDefault();
    press(`key:${event.code}`);
  }, listener);
  document.addEventListener('keyup', event => {
    if (source !== `key:${event.code}`) return;
    event.preventDefault();
    release();
  }, listener);
  window.addEventListener('blur', () => release(true), listener);
  document.addEventListener('focusin', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) release(true);
  }, listener);
  window.addEventListener('pagehide', () => release(true), listener);
  document.addEventListener('visibilitychange', () => { if (document.hidden) release(true); }, listener);
  return () => { release(true); controller.abort(); };
}
