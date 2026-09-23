import { describe, expect, it } from 'vitest';
import { labelElement, labelToPhrase } from './labeller';

/** Build a document fragment and return the element matching `selector`. */
function render(html: string, selector: string): Element {
  document.body.innerHTML = html;
  const el = document.body.querySelector(selector);
  if (!el) throw new Error(`no element matched ${selector}`);
  return el;
}

describe('labelElement', () => {
  it('prefers aria-label over text content', () => {
    const el = render('<button aria-label="Close dialog">×</button>', 'button');
    expect(labelElement(el)).toMatchObject({ name: 'Close dialog', role: 'button' });
  });

  it('resolves aria-labelledby', () => {
    const el = render('<h2 id="t">Order Details</h2><div role="region" aria-labelledby="t" id="r"></div>', '#r');
    expect(labelElement(el).name).toBe('Order Details');
  });

  it('reads a button by its text', () => {
    const el = render('<button>Submit prescription</button>', 'button');
    expect(labelToPhrase(labelElement(el))).toBe("the 'Submit prescription' button");
  });

  it('names a field by its label, never by its value', () => {
    const el = render('<label for="e">Email address</label><input id="e" value="a@b.test">', 'input');
    const label = labelElement(el);
    expect(label.name).toBe('Email address');
    expect(label.role).toBe('text field');
    expect(JSON.stringify(label)).not.toContain('a@b.test');
  });

  it('falls back through placeholder then name for an unlabelled field', () => {
    expect(labelElement(render('<input placeholder="Search orders">', 'input')).name).toBe(
      'Search orders',
    );
    expect(labelElement(render('<input name="invoiceNumber">', 'input')).name).toBe(
      'invoice number',
    );
  });

  it('describes input types in words a tester would use', () => {
    expect(labelElement(render('<input type="password">', 'input')).role).toBe('password field');
    expect(labelElement(render('<input type="checkbox">', 'input')).role).toBe('checkbox');
    expect(labelElement(render('<select></select>', 'select')).role).toBe('dropdown');
  });

  it('adds the containing region as context', () => {
    const el = render(
      '<section aria-label="Order Details"><button>Submit</button></section>',
      'button',
    );
    expect(labelToPhrase(labelElement(el))).toBe("the 'Submit' button in Order Details");
  });

  it('uses a section heading when there is no aria-label', () => {
    const el = render('<section><h2>Payment</h2><button>Pay now</button></section>', 'button');
    expect(labelElement(el).context).toBe('Payment');
  });

  it('ignores unnamed wrappers rather than reporting them', () => {
    const el = render('<div class="css-1x2y3"><div><button>Save</button></div></div>', 'button');
    expect(labelElement(el).context).toBeUndefined();
  });

  it('ignores script and hidden content when reading text', () => {
    const el = render(
      '<button><script>var x=1</script><span aria-hidden="true">✓</span>Confirm</button>',
      'button',
    );
    expect(labelElement(el).name).toBe('Confirm');
  });

  it('stays honest when nothing names the element', () => {
    const el = render('<div class="a b c"><span></span></div>', 'span');
    expect(labelToPhrase(labelElement(el))).toBe('the span');
  });

  it('truncates a very long name instead of dumping a paragraph', () => {
    const el = render(`<button>${'word '.repeat(60)}</button>`, 'button');
    expect(labelElement(el).name.length).toBeLessThanOrEqual(80);
    expect(labelElement(el).name.endsWith('…')).toBe(true);
  });

  it('collapses whitespace from prettified markup', () => {
    const el = render('<button>\n  Submit\n  prescription\n</button>', 'button');
    expect(labelElement(el).name).toBe('Submit prescription');
  });
});
