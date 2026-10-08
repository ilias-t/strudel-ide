/**
 * ask(): a small modal confirmation unit for the stage.
 *
 * A graphite unit with a black-glass readout, set over a dimmed room. Built
 * fresh on every call (appended to <body>), removed on close. Text only ever
 * goes in through textContent: titles and facts can come from share links.
 *
 * Keyboard: focus moves to a key on open and stays inside the card (Tab is
 * wrapped, a capture-phase focusin guard pulls stray focus back). Esc cancels;
 * Enter confirms unless a key/button has focus (then that key's own native
 * activation runs, so Enter on the cancel key cancels). Every key event that
 * passes through the overlay stops propagating, so the page's document-level
 * shortcuts (Space = play, E = edit, digits = mute…) never fire while open.
 *
 * One dialog at a time: a second ask() waits until the first has closed.
 */
import "./ask.css";

export interface AskOptions {
  /** data-testid of the dialog card; keys get `${testid}-confirm` and `${testid}-cancel` */
  testid: string;
  title: string;
  /** Short label/value rows shown on a black-glass readout, e.g. [["song", "Acid Rain"], ["size", "4.2 KB · 120 lines"]] */
  facts?: [label: string, value: string][];
  /** A short paragraph under the facts */
  note?: string;
  /** Optional extra content appended after the note (e.g. a read-only <input> holding a link) */
  content?: HTMLElement;
  /** Confirm key label, e.g. "open it" */
  confirm: string;
  /** Cancel key label, e.g. "don't". Omitted: a single-key dialog */
  cancel?: string;
  /** "warn": something risky (runs code from a link / discards edits): an amber LED and role="alertdialog". Default "plain" (role="dialog") */
  tone?: "warn" | "plain";
  /** Which key has focus when it opens (default "confirm") */
  focus?: "confirm" | "cancel";
}

/** Control characters and bidi overrides/isolates: never shown from untrusted text */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
const clean = (s: string) => String(s).replace(UNSAFE, "");

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let current: { overlay: HTMLElement } | null = null;
let chain: Promise<unknown> = Promise.resolve();
let uid = 0;

/** Show a modal card; resolves true for confirm, false for cancel / Esc / backdrop click. */
export function ask(opts: AskOptions): Promise<boolean> {
  const run = chain.then(() => show(opts));
  chain = run.catch(() => undefined);
  return run;
}

/** Whether a dialog from ask() is open now */
export function askOpen(): boolean {
  return current !== null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function show(opts: AskOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const id = `ask-${++uid}`;
    const warn = opts.tone === "warn";
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // ── DOM ──────────────────────────────────────────────────────────────────
    const overlay = el("div", "ask-overlay");
    overlay.dataset.testid = `${opts.testid}-overlay`;
    overlay.tabIndex = -1;

    const card = el("div", "ask-card");
    card.dataset.testid = opts.testid;
    card.dataset.tone = warn ? "warn" : "plain";
    card.setAttribute("role", warn ? "alertdialog" : "dialog");
    card.setAttribute("aria-modal", "true");
    card.tabIndex = -1;
    card.append(el("span", "screw ask-screw"), el("span", "screw ask-screw"));

    const head = el("div", "ask-head");
    if (warn) {
      const led = el("span", "ask-led");
      led.setAttribute("aria-hidden", "true");
      head.append(led);
    }
    const title = el("h2", "ask-title", clean(opts.title));
    title.id = `${id}-title`;
    head.append(title);
    card.append(head);
    card.setAttribute("aria-labelledby", title.id);

    const described: string[] = [];
    if (opts.facts?.length) {
      const readout = el("dl", "ask-readout screen");
      readout.id = `${id}-facts`;
      for (const [label, value] of opts.facts) {
        const row = el("div", "ask-fact");
        const shown = clean(value);
        const dd = el("dd", "ask-value", shown);
        dd.title = shown;
        row.append(el("dt", "ask-label", clean(label)), dd);
        readout.append(row);
      }
      card.append(readout);
      described.push(readout.id);
    }
    if (opts.note) {
      const note = el("p", "ask-note", opts.note);
      note.id = `${id}-note`;
      card.append(note);
      described.push(note.id);
    }
    if (described.length) card.setAttribute("aria-describedby", described.join(" "));
    if (opts.content) {
      const slot = el("div", "ask-content");
      slot.append(opts.content);
      card.append(slot);
    }

    const keys = el("div", "ask-keys");
    let cancelKey: HTMLButtonElement | null = null;
    if (opts.cancel !== undefined) {
      cancelKey = el("button", "key ask-key", opts.cancel);
      cancelKey.type = "button";
      cancelKey.dataset.testid = `${opts.testid}-cancel`;
      keys.append(cancelKey);
    }
    const confirmKey = el("button", "key ask-key ask-key-go", opts.confirm);
    confirmKey.type = "button";
    confirmKey.dataset.testid = `${opts.testid}-confirm`;
    keys.append(confirmKey);
    card.append(keys);
    overlay.append(card);

    const home = (opts.focus === "cancel" && cancelKey) || confirmKey;

    // ── closing ──────────────────────────────────────────────────────────────
    let done = false;
    const finish = (result: boolean) => {
      if (done) return;
      done = true;
      document.removeEventListener("focusin", onFocusIn, true);
      window.removeEventListener("keydown", onStrayKey, true);
      overlay.remove();
      current = null;
      if (prev && prev.isConnected && prev !== document.body) {
        try {
          prev.focus({ preventScroll: true });
        } catch {
          /* nothing to restore to */
        }
      }
      resolve(result);
    };

    confirmKey.addEventListener("click", () => finish(true));
    cancelKey?.addEventListener("click", () => finish(false));

    // backdrop: only a press that both starts and ends on the dim area cancels
    // (a text-selection drag out of the card must not close it)
    let downOnBackdrop = false;
    overlay.addEventListener("pointerdown", (e) => {
      downOnBackdrop = e.target === overlay;
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay && downOnBackdrop) finish(false);
      downOnBackdrop = false;
    });

    // ── keyboard ─────────────────────────────────────────────────────────────
    const stop = (e: Event) => e.stopPropagation();
    overlay.addEventListener("keyup", stop);
    overlay.addEventListener("keypress", stop);
    overlay.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      } else if (e.key === "Tab") {
        const items = [...card.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.getClientRects().length > 0);
        if (!items.length) {
          e.preventDefault();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const at = document.activeElement;
        const inside = at instanceof HTMLElement && items.includes(at);
        if (!inside) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        } else if (e.shiftKey && at === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && at === last) {
          e.preventDefault();
          first.focus();
        }
      } else if (e.key === "Enter") {
        // a held Enter (from whatever opened this) must not confirm by itself
        if (e.repeat) {
          e.preventDefault();
          return;
        }
        const t = e.target;
        // keys, buttons and links in the card handle Enter themselves
        if (t instanceof HTMLButtonElement || t instanceof HTMLAnchorElement || t instanceof HTMLTextAreaElement) return;
        e.preventDefault();
        finish(true);
      }
    });

    // keys aimed outside the overlay while it's open (e.g. focus fell to <body>)
    const onStrayKey = (e: KeyboardEvent) => {
      if (e.target instanceof Node && overlay.contains(e.target)) return;
      e.stopPropagation();
      e.preventDefault();
      if (e.key === "Escape") finish(false);
      else home.focus();
    };

    const onFocusIn = (e: FocusEvent) => {
      if (e.target instanceof Node && overlay.contains(e.target)) return;
      home.focus();
    };

    // ── open ─────────────────────────────────────────────────────────────────
    current = { overlay };
    document.body.append(overlay);
    document.addEventListener("focusin", onFocusIn, true);
    window.addEventListener("keydown", onStrayKey, true);
    home.focus({ preventScroll: true });
  });
}
