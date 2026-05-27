/**
 * Browser Agent DOM scripts — strings injected into the active webview
 * via `wv.executeJavaScript`. Kept as plain strings (NOT functions) so
 * they are serializable through the IPC boundary unchanged.
 *
 * All scripts MUST be self-contained IIFEs that return JSON-serializable
 * values.
 */

const MAX_TEXT = 4_000;
const MAX_ELEMENTS = 80;
const MAX_FIELD_TEXT = 120;

/**
 * Tag every interactive element with a stable `data-joy-aid` index and
 * return a compact catalogue the agent can reason over.
 *
 * The index is preserved across calls within the same page life-time so
 * the model can refer back to "element 14" two steps later. Indexes are
 * reset when the URL changes (a fresh script run on a new page starts
 * from 0).
 */
export const AGENT_OBSERVE_SCRIPT = `(() => {
  const MAX_TEXT = ${MAX_TEXT};
  const MAX_ELEMENTS = ${MAX_ELEMENTS};
  const MAX_FIELD_TEXT = ${MAX_FIELD_TEXT};

  const isVisible = (el) => {
    if (!(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    if (parseFloat(cs.opacity || '1') === 0) return false;
    return true;
  };

  const inViewport = (el) => {
    const r = el.getBoundingClientRect();
    return r.top < (window.innerHeight || 0) && r.bottom > 0 && r.left < (window.innerWidth || 0) && r.right > 0;
  };

  const SELECTOR = 'a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=textbox], [role=combobox], [role=checkbox], [role=switch], [role=tab], [role=menuitem], [contenteditable=true], [onclick]';

  const elements = [];
  let counter = 0;
  const nodes = document.querySelectorAll(SELECTOR);

  for (const el of nodes) {
    if (!isVisible(el)) continue;
    // Persist or assign joy-aid.
    let aid = el.getAttribute('data-joy-aid');
    if (!aid) {
      aid = String(counter++);
      el.setAttribute('data-joy-aid', aid);
    }

    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || el.getAttribute('type') || '';
    let text = '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      text = el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('name') || '';
    } else {
      text = (el.innerText || el.textContent || '').trim();
      if (!text) text = el.getAttribute('aria-label') || el.getAttribute('title') || '';
    }
    text = (text || '').replace(/\\s+/g, ' ').trim().slice(0, MAX_FIELD_TEXT);

    const entry = {
      i: parseInt(aid, 10),
      t: tag,
      r: role || undefined,
      text: text || undefined,
      inView: inViewport(el),
    };
    if (tag === 'a' && el.getAttribute('href')) entry.href = el.getAttribute('href');
    if ((tag === 'input' || tag === 'textarea') && el.value != null) {
      const v = String(el.value);
      if (v) entry.value = v.length > 80 ? v.slice(0, 80) + '…' : v;
    }
    elements.push(entry);
  }

  // viewport-first ordering, then DOM order.
  elements.sort((a, b) => {
    if (a.inView === b.inView) return a.i - b.i;
    return a.inView ? -1 : 1;
  });
  const trimmed = elements.slice(0, MAX_ELEMENTS);

  // Plain-text body for grounding.
  const bodyClone = document.body ? document.body.cloneNode(true) : null;
  if (bodyClone) {
    for (const sel of ['script', 'style', 'noscript', 'svg']) {
      for (const el of bodyClone.querySelectorAll(sel)) el.remove();
    }
  }
  let text = (bodyClone ? bodyClone.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim();
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + '\\n\\n[…truncated]';

  return JSON.stringify({
    url: location.href,
    title: document.title || '',
    text,
    elements: trimmed,
  });
})()`;

/**
 * Click the element with the given joy-aid index. Returns a status
 * string the agent can read back.
 */
export function buildClickScript(index: number): string {
  return `(() => {
    const el = document.querySelector('[data-joy-aid="${index}"]');
    if (!el) return 'ERROR: element ${index} not found';
    try {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      if (typeof el.focus === 'function') el.focus();
      el.click();
      return 'OK: clicked ' + (el.tagName.toLowerCase()) + (el.id ? '#' + el.id : '');
    } catch (e) {
      return 'ERROR: ' + String(e && e.message ? e.message : e);
    }
  })()`;
}

/**
 * Fill an input/textarea by joy-aid index. Dispatches input + change
 * events so React-controlled inputs update properly.
 */
export function buildFillScript(index: number, value: string): string {
  const json = JSON.stringify(value);
  return `(() => {
    const el = document.querySelector('[data-joy-aid="${index}"]');
    if (!el) return 'ERROR: element ${index} not found';
    const v = ${json};
    try {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      if (typeof el.focus === 'function') el.focus();
      const tag = el.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea') {
        const proto = tag === 'input' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(el, v); else el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (tag === 'select') {
        el.value = v;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.isContentEditable) {
        el.textContent = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        return 'ERROR: element ${index} is not fillable (' + tag + ')';
      }
      return 'OK: filled ${index} with ' + JSON.stringify(v).slice(0, 80);
    } catch (e) {
      return 'ERROR: ' + String(e && e.message ? e.message : e);
    }
  })()`;
}

export function buildPressKeyScript(key: string, index?: number): string {
  const idxClause =
    typeof index === "number"
      ? `document.querySelector('[data-joy-aid="${index}"]') || document.activeElement || document.body`
      : `document.activeElement || document.body`;
  const keyJson = JSON.stringify(key);
  return `(() => {
    const el = ${idxClause};
    const key = ${keyJson};
    try {
      el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keypress', { key, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
      if (key === 'Enter' && el.form && typeof el.form.requestSubmit === 'function') {
        try { el.form.requestSubmit(); } catch {}
      }
      return 'OK: pressed ' + key;
    } catch (e) {
      return 'ERROR: ' + String(e && e.message ? e.message : e);
    }
  })()`;
}

export function buildScrollScript(
  direction: "up" | "down" | "top" | "bottom",
  amount?: number,
): string {
  const amt = typeof amount === "number" ? amount : 800;
  return `(() => {
    try {
      switch (${JSON.stringify(direction)}) {
        case 'top': window.scrollTo({ top: 0, behavior: 'instant' }); break;
        case 'bottom': window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }); break;
        case 'up': window.scrollBy({ top: -${amt}, behavior: 'instant' }); break;
        case 'down': window.scrollBy({ top: ${amt}, behavior: 'instant' }); break;
      }
      return 'OK: scrolled ' + ${JSON.stringify(direction)};
    } catch (e) {
      return 'ERROR: ' + String(e && e.message ? e.message : e);
    }
  })()`;
}

export function buildExtractScript(selector?: string): string {
  const sel = selector && selector.trim() ? selector : "body";
  const selJson = JSON.stringify(sel);
  return `(() => {
    try {
      const el = document.querySelector(${selJson});
      if (!el) return JSON.stringify({ ok: false, error: 'no match for ' + ${selJson} });
      const text = (el.innerText || el.textContent || '').replace(/\\s+\\n/g, '\\n').trim();
      return JSON.stringify({ ok: true, text: text.slice(0, 8000) });
    } catch (e) {
      return JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  })()`;
}
