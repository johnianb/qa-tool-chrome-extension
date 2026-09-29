import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REDACTION,
  describeValue,
  isBlockedHost,
  isSensitiveField,
  parseRedactionList,
  scrubText,
  scrubUrl,
} from './redact';

function field(html: string): Element {
  document.body.innerHTML = html;
  return document.body.firstElementChild!;
}

/**
 * Adversarial by policy. Every case here is somewhere a secret was found hiding in a
 * real page; add one whenever a new hiding place turns up.
 */
describe('isSensitiveField', () => {
  it('catches a password input', () => {
    expect(isSensitiveField(field('<input type="password">'))).toBe(true);
  });

  it('catches a secret hiding behind type="text"', () => {
    expect(isSensitiveField(field('<input type="text" name="apiKey">'))).toBe(true);
    expect(isSensitiveField(field('<input type="text" id="user-pin">'))).toBe(true);
    expect(isSensitiveField(field('<input type="text" placeholder="CVV">'))).toBe(true);
    expect(isSensitiveField(field('<input type="text" aria-label="Social Security Number">'))).toBe(
      true,
    );
  });

  it('honours the browser autocomplete hints', () => {
    expect(isSensitiveField(field('<input autocomplete="cc-number">'))).toBe(true);
    expect(isSensitiveField(field('<input autocomplete="new-password">'))).toBe(true);
    expect(isSensitiveField(field('<input autocomplete="one-time-code">'))).toBe(true);
  });

  it('leaves ordinary fields alone', () => {
    expect(isSensitiveField(field('<input name="quantity">'))).toBe(false);
    expect(isSensitiveField(field('<input name="searchTerm">'))).toBe(false);
  });
});

describe('describeValue', () => {
  it('never reveals a sensitive value', () => {
    const el = field('<input type="password" value="hunter2">');
    expect(describeValue(el, 'hunter2')).not.toContain('hunter2');
  });

  it('describes shape, not content, by default', () => {
    expect(describeValue(field('<input name="note">'), 'abcdefghijklmn')).toBe('14 characters');
    expect(describeValue(field('<input name="note">'), 'a')).toBe('1 character');
    expect(describeValue(field('<input name="note">'), '')).toBe('cleared it');
  });

  it('keeps the value only for an explicitly allowlisted field', () => {
    const el = field('<input name="quantity">');
    expect(describeValue(el, '250', { ...DEFAULT_REDACTION, allowValuesFor: ['quantity'] })).toBe(
      '"250"',
    );
  });

  it('still scrubs PII from an allowlisted field', () => {
    const el = field('<input name="note">');
    const out = describeValue(el, 'ask a@b.test', { ...DEFAULT_REDACTION, allowValuesFor: ['note'] });
    expect(out).toBe('"ask [email]"');
  });

  it('reports checkboxes by state', () => {
    const el = field('<input type="checkbox">') as HTMLInputElement;
    expect(describeValue(el, 'on')).toBe('unchecked');
    el.checked = true;
    expect(describeValue(el, 'on')).toBe('checked');
  });
});

describe('scrubText', () => {
  it('removes emails, cards, phones and SSNs', () => {
    expect(scrubText('mail me at jo@example.com')).toBe('mail me at [email]');
    expect(scrubText('card 4111 1111 1111 1111 declined')).toBe('card [card number] declined');
    expect(scrubText('call +62 812 3456 7890')).toContain('[phone]');
    expect(scrubText('ssn 123-45-6789')).toBe('ssn [ssn]');
  });

  it('leaves ordinary text untouched', () => {
    expect(scrubText('order 12 of 30 failed')).toBe('order 12 of 30 failed');
  });
});

describe('scrubUrl', () => {
  it('drops the query string but records how much was dropped', () => {
    expect(scrubUrl('https://api.test/v1/orders?token=abc123&email=a@b.test')).toBe(
      'https://api.test/v1/orders (+2 params)',
    );
  });

  it('keeps a clean URL as-is', () => {
    expect(scrubUrl('https://api.test/v1/orders')).toBe('https://api.test/v1/orders');
  });
});

describe('isBlockedHost', () => {
  const settings = { ...DEFAULT_REDACTION, blockedHosts: ['admin.internal'] };

  it('blocks the host and its subdomains', () => {
    expect(isBlockedHost('https://admin.internal/x', settings)).toBe(true);
    expect(isBlockedHost('https://eu.admin.internal/x', settings)).toBe(true);
  });

  it('does not block a lookalike host', () => {
    expect(isBlockedHost('https://notadmin.internal/x', settings)).toBe(false);
  });
});

describe('parseRedactionList', () => {
  it('splits on newlines and commas, trimming each entry', () => {
    expect(parseRedactionList('admin.internal\n billing.test ,ops.test')).toEqual([
      'admin.internal',
      'billing.test',
      'ops.test',
    ]);
  });

  it('drops blank lines rather than saving an empty entry', () => {
    // An empty string in `blockedHosts` would match nothing, but an empty string in
    // `allowValuesFor` matches a field with no name or id — which is a great many of them.
    expect(parseRedactionList('a.test\n\n\n  \n,,b.test')).toEqual(['a.test', 'b.test']);
    expect(parseRedactionList('   ')).toEqual([]);
  });

  /** Both consumers compare against lower-cased values, so a mixed-case entry would never match. */
  it('lower-cases and de-duplicates', () => {
    expect(parseRedactionList('Admin.Internal\nadmin.internal\nORDERID')).toEqual([
      'admin.internal',
      'orderid',
    ]);
  });

  it('round-trips a list through the textarea representation', () => {
    const list = ['admin.internal', 'billing.test'];
    expect(parseRedactionList(list.join('\n'))).toEqual(list);
  });
});
