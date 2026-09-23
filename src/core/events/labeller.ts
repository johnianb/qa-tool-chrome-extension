/**
 * Turns a DOM element into a phrase a person would recognise.
 *
 * This is the module that decides whether the finished bug report reads like
 * *"clicked the 'Submit prescription' button in the Order Details panel"* or like
 * *"clicked div.css-1x2y3"*. Everything downstream — the Markdown report, the model's
 * description of the steps — is bounded by the quality of what comes out of here, so
 * it is worth more care than its size suggests.
 *
 * The approach follows the accessible-name computation that screen readers use, which
 * is the closest thing to "what a human would call this thing" that the DOM offers.
 */

/** How an element should be described, and where it sits. */
export interface ElementLabel {
  /** What the element is called, e.g. `Submit prescription`. */
  name: string;
  /** What kind of thing it is, e.g. `button`, `text field`, `link`. */
  role: string;
  /** The region it lives in, e.g. `Order Details`. Absent when there is no useful one. */
  context?: string;
}

const MAX_NAME = 80;

/** Elements whose text should never be read as a name. */
const OPAQUE = new Set(['SCRIPT', 'STYLE', 'SVG', 'NOSCRIPT']);

/**
 * Sections that plausibly name a region of the page.
 *
 * `form` and `dialog` are included because "in the Login form" is genuinely useful
 * context; `div` is not, however many classes it carries.
 */
const LANDMARKS = 'main,nav,aside,header,footer,form,dialog,section,article,[role],[aria-label]';

export function labelElement(el: Element): ElementLabel {
  const role = describeRole(el);
  const name = accessibleName(el) || fallbackName(el, role);
  const context = regionOf(el);
  return context ? { name, role, context } : { name, role };
}

/** Render a label as the phrase used in a reported step. */
export function labelToPhrase(label: ElementLabel): string {
  const named = label.name ? `'${label.name}' ` : '';
  const where = label.context ? ` in ${label.context}` : '';
  return `the ${named}${label.role}${where}`;
}

/**
 * The element's accessible name, in specification precedence order.
 *
 * Simplified from the full ARIA algorithm: no recursive name-from-content across
 * nested labelled controls, which buys accuracy that no bug report would notice.
 */
function accessibleName(el: Element): string {
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ');
    if (clean(text)) return clean(text);
  }

  const ariaLabel = clean(el.getAttribute('aria-label') ?? '');
  if (ariaLabel) return ariaLabel;

  if (isFormField(el)) {
    // A field's own text content is its *value*, never its name — reading it would put
    // whatever the tester typed into the report.
    const fromLabel = labelFor(el);
    if (fromLabel) return fromLabel;
    const placeholder = clean(el.getAttribute('placeholder') ?? '');
    if (placeholder) return placeholder;
    const title = clean(el.getAttribute('title') ?? '');
    if (title) return title;
    const name = clean(el.getAttribute('name') ?? '');
    if (name) return humanise(name);
    return '';
  }

  const alt = clean(el.getAttribute('alt') ?? '');
  if (alt) return alt;

  const text = visibleText(el);
  if (text) return text;

  const title = clean(el.getAttribute('title') ?? '');
  if (title) return title;

  return '';
}

/** The `<label>` associated with a form field, by `for=` or by containment. */
function labelFor(el: Element): string {
  const id = el.getAttribute('id');
  if (id) {
    // Compared as an attribute rather than built into a selector: an id may contain
    // characters that need escaping, and `CSS.escape` is not available everywhere this
    // runs. Pages have few labels, so scanning them is cheap.
    for (const label of Array.from(el.ownerDocument.querySelectorAll('label[for]'))) {
      if (label.getAttribute('for') !== id) continue;
      const text = clean(label.textContent ?? '');
      if (text) return text;
      break;
    }
  }
  const wrapping = el.closest('label');
  return wrapping ? clean(wrapping.textContent ?? '') : '';
}

/** Text a sighted user would read, ignoring script, style and hidden subtrees. */
function visibleText(el: Element): string {
  if (OPAQUE.has(el.tagName)) return '';
  let text = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? '';
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const child = node as Element;
      if (OPAQUE.has(child.tagName)) continue;
      if (child.getAttribute('aria-hidden') === 'true') continue;
      if (child.hasAttribute('hidden')) continue;
      text += visibleText(child);
      if (text.length > MAX_NAME * 2) break; // enough to trim from
    }
  }
  return clean(text);
}

/** What kind of control this is, in the words a tester would use. */
function describeRole(el: Element): string {
  const explicit = el.getAttribute('role');
  if (explicit) return humanise(explicit);

  const tag = el.tagName.toLowerCase();
  if (tag === 'input') {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    return INPUT_ROLES[type] ?? `${type} field`;
  }

  return TAG_ROLES[tag] ?? tag;
}

const INPUT_ROLES: Record<string, string> = {
  text: 'text field',
  email: 'email field',
  password: 'password field',
  search: 'search field',
  tel: 'phone field',
  url: 'URL field',
  number: 'number field',
  checkbox: 'checkbox',
  radio: 'radio button',
  file: 'file picker',
  date: 'date field',
  submit: 'button',
  button: 'button',
  reset: 'button',
};

const TAG_ROLES: Record<string, string> = {
  a: 'link',
  button: 'button',
  select: 'dropdown',
  textarea: 'text area',
  summary: 'disclosure',
  option: 'option',
  label: 'label',
  img: 'image',
  form: 'form',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  li: 'list item',
  td: 'table cell',
  th: 'column header',
  tr: 'table row',
};

/**
 * A last resort when nothing names the element.
 *
 * Returning an empty name is better than inventing one: `labelToPhrase` then produces
 * "the button", which is honest, where a class name would be noise presented as fact.
 */
function fallbackName(el: Element, role: string): string {
  const testId = el.getAttribute('data-testid') ?? el.getAttribute('data-test-id');
  if (testId) return humanise(testId);
  if (role === 'image') return '';
  return '';
}

/**
 * The named region containing the element.
 *
 * Walks out to the nearest landmark that actually has a name — an unnamed `<div>`
 * wrapper tells the reader nothing, so it is skipped rather than reported.
 */
function regionOf(el: Element): string | undefined {
  let node: Element | null = el.parentElement;
  let hops = 0;

  while (node && hops < 12) {
    if (node.matches(LANDMARKS)) {
      const named = clean(node.getAttribute('aria-label') ?? '');
      if (named) return named;

      const labelledBy = node.getAttribute('aria-labelledby');
      if (labelledBy) {
        const text = clean(
          el.ownerDocument.getElementById(labelledBy.split(/\s+/)[0] ?? '')?.textContent ?? '',
        );
        if (text) return text;
      }

      const heading = node.querySelector('h1,h2,h3,h4,legend,caption');
      const headingText = clean(heading?.textContent ?? '');
      if (headingText) return truncate(headingText, 40);

      const landmarkRole = node.getAttribute('role') ?? node.tagName.toLowerCase();
      if (landmarkRole === 'dialog' || landmarkRole === 'form') return `the ${landmarkRole}`;
    }
    node = node.parentElement;
    hops += 1;
  }
  return undefined;
}

function isFormField(el: Element): boolean {
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

/** Collapse whitespace and trim to a length that reads well in a sentence. */
function clean(text: string): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), MAX_NAME);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** `submit-prescription` / `submitPrescription` → `submit prescription`. */
function humanise(token: string): string {
  return clean(
    token
      .replace(/[-_.]+/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase(),
  );
}
