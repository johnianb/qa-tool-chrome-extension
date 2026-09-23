import { describe, expect, it } from 'vitest';
import { buildSelector } from './selector';

function render(html: string, selector: string): Element {
  document.body.innerHTML = html;
  return document.body.querySelector(selector)!;
}

describe('buildSelector', () => {
  it('prefers a test id above everything', () => {
    const el = render('<button id="a" data-testid="submit-order" class="btn">Go</button>', 'button');
    expect(buildSelector(el)).toBe('[data-testid="submit-order"]');
  });

  it('uses an authored id', () => {
    expect(buildSelector(render('<input id="email-field">', 'input'))).toBe('#email-field');
  });

  it('rejects a generated id from a component library', () => {
    const el = render('<input id=":r3:" name="email">', 'input');
    expect(buildSelector(el)).toBe('input[name="email"]');
  });

  it('rejects CSS-in-JS class names, which change every build', () => {
    const el = render('<div><button class="css-1x2y3 sc-bdVaJa">Save</button></div>', 'button');
    expect(buildSelector(el)).not.toContain('css-1x2y3');
    expect(buildSelector(el)).not.toContain('sc-bdVaJa');
  });

  it('keeps authored class names', () => {
    const el = render('<div><span class="order-total">12</span></div>', 'span');
    expect(buildSelector(el)).toBe('span.order-total');
  });

  it('falls back to a structural path when nothing is stable', () => {
    const el = render('<div><ul><li>a</li><li>b</li></ul></div>', 'li:nth-child(2)');
    expect(buildSelector(el)).toContain('li:nth-of-type(2)');
  });

  it('anchors a structural path to the nearest test id', () => {
    const el = render('<div data-testid="cart"><ul><li>a</li><li>b</li></ul></div>', 'li:nth-child(2)');
    expect(buildSelector(el)).toBe('[data-testid="cart"] > ul > li:nth-of-type(2)');
  });

  it('does not return a non-unique selector', () => {
    const el = render('<span class="tag">a</span><span class="tag">b</span>', 'span');
    const selector = buildSelector(el);
    expect(document.querySelectorAll(selector)).toHaveLength(1);
  });
});
