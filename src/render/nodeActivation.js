// Interaction-only adapter. Does not measure labels or change layout.
export const HOLD_MS = 650;
export const MOVE_TOLERANCE = 10;

export function installNodeActivation(nodes, { activate, select, eligible = () => true, label }) {
  const elements = nodes.nodes();
  const doc = elements[0]?.ownerDocument;
  if (!doc) return () => {};
  const win = doc.defaultView;
  const pointers = new Set();
  const removers = [];
  let pending = null, timer = null, frame = null, suppressUntil = 0;
  let heldPointer = null, disposed = false, guardTimer = null;
  const listen = (target, type, fn, options) => {
    target.addEventListener(type, fn, options);
    removers.push(() => target.removeEventListener(type, fn, options));
  };
  function cancel() {
    clearTimeout(timer);
    win.cancelAnimationFrame(frame);
    if (pending) {
      pending.el.removeAttribute('data-holding');
      pending.ring.remove();
    }
    pending = null;
  }
  function blockFollowup(e) {
    if (Date.now() < suppressUntil && e.detail !== 0) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }
  // Capture before D3's click/double-click handlers, including after a hold
  // opens a new panel under the finger.
  doc.addEventListener('click', blockFollowup, true);
  doc.addEventListener('dblclick', blockFollowup, true);
  // A new pointer or keyboard action is intentional, not the held pointer's
  // synthesized click. Keep this reset alive alongside the teardown guard.
  const freshInput = () => { suppressUntil = 0; heldPointer = null; if (disposed) removeGuard(); };
  doc.addEventListener('pointerdown', freshInput, true);
  doc.addEventListener('keydown', freshInput, true);
  const releaseGuard = e => {
    if (e.pointerId !== heldPointer) return;
    heldPointer = null;
    suppressUntil = Date.now() + 1000;
    if (disposed) guardTimer = setTimeout(removeGuard, 1000);
  };
  for (const type of ['pointerup', 'pointercancel']) doc.addEventListener(type, releaseGuard, true);
  function removeGuard() {
    clearTimeout(guardTimer);
    doc.removeEventListener('click', blockFollowup, true);
    doc.removeEventListener('dblclick', blockFollowup, true);
    doc.removeEventListener('pointerdown', freshInput, true);
    doc.removeEventListener('keydown', freshInput, true);
    for (const type of ['pointerup', 'pointercancel']) doc.removeEventListener(type, releaseGuard, true);
  }
  listen(doc, 'pointerdown', e => {
    pointers.add(e.pointerId);
    if (pointers.size > 1) cancel();
  }, true);
  listen(doc, 'pointermove', e => {
    if (pending && e.pointerId === pending.id &&
        Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > MOVE_TOLERANCE) cancel();
  }, true);
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    listen(doc, type, e => { pointers.delete(e.pointerId); cancel(); }, true);
  }
  for (const type of ['wheel', 'scroll', 'keydown', 'codeflow:navigation']) listen(doc, type, cancel, true);
  for (const type of ['blur', 'resize', 'orientationchange', 'pagehide']) {
    listen(win, type, () => { pointers.clear(); cancel(); });
  }
  listen(doc, 'visibilitychange', () => { pointers.clear(); cancel(); });
  for (const el of elements) {
    const datum = el.__data__;
    el.classList.add('graph-interactive-node');
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', !eligible(datum) && select ? label(datum).replace(/^Open /, 'Select ') : label(datum));
    el.setAttribute('aria-disabled', String(!eligible(datum) && !select));
    listen(el, 'keydown', e => {
      if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
        e.preventDefault(); e.stopPropagation();
        if (eligible(datum)) activate(datum);
        else select?.(datum);
      }
    });
    listen(el, 'contextmenu', e => e.preventDefault());
    listen(el, 'pointerdown', e => {
      cancel();
      if (e.pointerType === 'mouse' || e.button !== 0 || pointers.size !== 1 || !eligible(datum)) return;
      const ring = doc.createElementNS('http://www.w3.org/2000/svg', 'circle');
      for (const [key, value] of Object.entries({ r: 22, fill: 'none', stroke: '#f59e0b',
        'stroke-width': 3, 'pointer-events': 'none', 'stroke-dasharray': 138.23,
        'stroke-dashoffset': 138.23, 'aria-hidden': 'true' })) ring.setAttribute(key, value);
      el.append(ring);
      el.setAttribute('data-holding', 'true');
      pending = { id: e.pointerId, x: e.clientX, y: e.clientY, el, ring };
      const started = Date.now();
      function progress() {
        if (!pending) return;
        ring.setAttribute('stroke-dashoffset', 138.23 * (1 - Math.min(1, (Date.now() - started) / HOLD_MS)));
        frame = win.requestAnimationFrame(progress);
      }
      frame = win.requestAnimationFrame(progress);
      timer = setTimeout(() => {
        if (!pending || !el.isConnected || pointers.size !== 1) { cancel(); return; }
        heldPointer = pending.id;
        suppressUntil = Infinity; // The user may keep holding after navigation.
        cancel();
        activate(datum);
      }, HOLD_MS);
    });
  }
  return () => {
    if (disposed) return;
    disposed = true;
    cancel();
    removers.forEach(remove => remove());
    // Keep the guard through release, but any fresh input removes it immediately.
    if (heldPointer !== null) return;
    if (suppressUntil > Date.now()) guardTimer = setTimeout(removeGuard, suppressUntil - Date.now());
    else removeGuard();
  };
}
