/**
 * Builds a selector that still finds an element after the page changes.
 *
 * The report does not need this — steps are described in words. It exists so the event
 * log doubles as a starting point for a regression test: having reproduced a bug, the
 * obvious next question is how to assert it never comes back, and a hand-written
 * selector is the tedious part of answering it.
 *
 * Preference order is deliberate. Test ids are put there by developers precisely so
 * they survive refactors; generated class names (`css-1x2y3`, `sc-bdVaJa`) change on
 * every build and are worse than useless in a test.
 */

/** Attributes teams use to mark elements for testing, in descending preference. */
const TEST_ID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];

/** Class name patterns emitted by CSS-in-JS tooling, which change every build. */
const GENERATED_CLASS = /^(css-[a-z0-9]+|sc-[A-Za-z0-9]+|jsx-\d+|[a-z]+_[a-zA-Z0-9]{5,}|emotion-)/;

/** An id that looks generated rather than authored. */
const GENERATED_ID = /^(:r[0-9a-z]+:|radix-|headlessui-|mui-|react-aria)/i;

export function buildSelector(el: Element): string {
  const testId = testIdOf(el);
  if (testId) return testId;

  const id = el.getAttribute('id');
  if (id && !GENERATED_ID.test(id) && isUnique(el, `#${cssEscape(id)}`)) {
    return `#${cssEscape(id)}`;
  }

  const named = namedSelector(el);
  if (named && isUnique(el, named)) return named;

  return pathSelector(el);
}

/** A `[data-testid="…"]` selector when the element or its closest ancestor has one. */
function testIdOf(el: Element): string | null {
  for (const attr of TEST_ID_ATTRS) {
    const value = el.getAttribute(attr);
    if (value) return `[${attr}="${value}"]`;
  }
  return null;
}

/** A selector built from stable, authored attributes. */
function namedSelector(el: Element): string | null {
  const tag = el.tagName.toLowerCase();

  const name = el.getAttribute('name');
  if (name) return `${tag}[name="${name}"]`;

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return `${tag}[aria-label="${ariaLabel}"]`;

  const role = el.getAttribute('role');
  const stable = stableClasses(el);
  if (role && stable.length > 0) return `${tag}[role="${role}"].${stable[0]}`;
  if (role) return `${tag}[role="${role}"]`;
  if (stable.length > 0) return `${tag}.${stable.slice(0, 2).join('.')}`;

  return null;
}

/**
 * A structural path, used only when nothing stable names the element.
 *
 * Fragile by nature — it breaks when the DOM is reshaped — so it is the last resort,
 * and the caller should treat it as a hint rather than a contract.
 */
function pathSelector(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  let depth = 0;

  while (node && node.nodeType === Node.ELEMENT_NODE && depth < 6) {
    const tag = node.tagName.toLowerCase();
    if (tag === 'body' || tag === 'html') break;

    const testId = testIdOf(node);
    if (testId && node !== el) {
      parts.unshift(testId);
      break;
    }

    const siblings = node.parentElement
      ? Array.from(node.parentElement.children).filter((c) => c.tagName === node!.tagName)
      : [];
    parts.unshift(
      siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag,
    );

    node = node.parentElement;
    depth += 1;
  }

  return parts.join(' > ');
}

/** Class names that look authored rather than generated. */
function stableClasses(el: Element): string[] {
  return Array.from(el.classList).filter(
    (name) => !GENERATED_CLASS.test(name) && name.length > 1 && name.length < 40,
  );
}

function isUnique(el: Element, selector: string): boolean {
  try {
    const matches = el.ownerDocument.querySelectorAll(selector);
    return matches.length === 1 && matches[0] === el;
  } catch {
    return false; // a selector we cannot even parse is not one to hand to a test
  }
}

/** Minimal identifier escaping; `CSS.escape` is not available in every context. */
function cssEscape(value: string): string {
  return value.replace(/([^\w-])/g, '\\$1');
}
