/**
 * Decides what a captured value is allowed to say.
 *
 * Written in Phase 2 although it belonged to Phase 5, on purpose: the moment any code
 * captures a typed value, the rules about what may be kept have to already exist. Adding
 * them afterwards means a window during which real credentials are written to disk, and
 * "we'll redact it later" does not un-write them.
 *
 * The default is to describe a value's *shape*, never its content — "typed 14
 * characters" rather than the fourteen characters. Recordings at a healthcare company
 * will contain patient data, and a bug report is a document that gets pasted into
 * tickets, chat and email.
 */

/** Field types whose value must never be captured, regardless of settings. */
const NEVER_CAPTURE_TYPES = new Set(['password']);

/**
 * `autocomplete` tokens that mark a field as sensitive.
 *
 * Browsers already treat these as secret for autofill purposes; that judgement is
 * reused rather than second-guessed.
 */
const SENSITIVE_AUTOCOMPLETE = /^(cc-|current-password|new-password|one-time-code)/;

/** Field names and ids that indicate a secret, whatever the input type says. */
const SENSITIVE_NAME =
  /(pass(word|code)?|secret|token|api[-_ ]?key|auth|otp|cvv|cvc|pin|ssn|social.?security|credit.?card|card.?number|iban|account.?number|routing)/i;

/**
 * Patterns scrubbed from any free text before it is stored.
 *
 * Order matters: each replacement consumes its match, so the more specific rule must
 * come first. A 13-digit grouped number is genuinely ambiguous between a card and an
 * international phone number, and the leading `+` is what distinguishes them — so
 * `+`-prefixed numbers are claimed before the card rule can take them. Likewise a
 * US social security number is scrubbed before the general phone rule, which would
 * otherwise match its digit-and-dash shape.
 */
const PII_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/g, replacement: '[email]' },
  { pattern: /\+\d[\d\s().-]{6,}\d/g, replacement: '[phone]' },
  // Separators sit *between* digits so the match cannot swallow trailing whitespace.
  { pattern: /\b\d(?:[ -]?\d){12,18}\b/g, replacement: '[card number]' },
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[ssn]' },
  { pattern: /\b\d[\d\s().-]{6,}\d\b/g, replacement: '[phone]' },
];

export interface RedactionSettings {
  /**
   * Field names whose values may be stored verbatim. Opt-in, because the safe default
   * has to be the one you get by not configuring anything.
   */
  allowValuesFor: string[];
  /** Hosts the extension refuses to record at all. */
  blockedHosts: string[];
}

export const DEFAULT_REDACTION: RedactionSettings = {
  allowValuesFor: [],
  blockedHosts: [],
};

/** True when this field's value must never be recorded in any form. */
export function isSensitiveField(el: Element): boolean {
  const type = (el.getAttribute('type') ?? '').toLowerCase();
  if (NEVER_CAPTURE_TYPES.has(type)) return true;

  const autocomplete = (el.getAttribute('autocomplete') ?? '').toLowerCase();
  if (SENSITIVE_AUTOCOMPLETE.test(autocomplete)) return true;

  const identifiers = [
    el.getAttribute('name') ?? '',
    el.getAttribute('id') ?? '',
    el.getAttribute('aria-label') ?? '',
    el.getAttribute('placeholder') ?? '',
  ].join(' ');
  return SENSITIVE_NAME.test(identifiers);
}

/**
 * How a typed value should be described in the event log.
 *
 * @param el the field that was typed into
 * @param value its current value
 * @param settings the user's allowlist
 */
export function describeValue(
  el: Element,
  value: string,
  settings: RedactionSettings = DEFAULT_REDACTION,
): string {
  if (isSensitiveField(el)) return 'a value (hidden: sensitive field)';

  const type = (el.getAttribute('type') ?? '').toLowerCase();
  if (type === 'checkbox' || type === 'radio') {
    return (el as HTMLInputElement).checked ? 'checked' : 'unchecked';
  }

  if (value.length === 0) return 'cleared it';

  const fieldName = (el.getAttribute('name') ?? el.getAttribute('id') ?? '').toLowerCase();
  const allowed = settings.allowValuesFor.some((a) => a.toLowerCase() === fieldName);
  if (allowed) return `"${scrubText(value)}"`;

  // The shape of a value is usually enough to reproduce a bug — "typed 3 characters
  // into a field expecting 6" is the kind of detail that matters — without the content.
  return `${value.length} character${value.length === 1 ? '' : 's'}`;
}

/** Remove recognisable personal data from free text. */
export function scrubText(text: string): string {
  let out = text;
  for (const { pattern, replacement } of PII_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Strip a URL to path only.
 *
 * Query strings routinely carry tokens, session ids, emails and search terms. The path
 * is what identifies the request in a bug report; the parameters are risk with little
 * diagnostic value.
 */
export function scrubUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const query = url.search ? ` (+${new URLSearchParams(url.search).size} params)` : '';
    return `${url.origin}${url.pathname}${query}`;
  } catch {
    return scrubText(raw);
  }
}

/**
 * Parse a box of entries typed by a tester into a redaction list.
 *
 * Newline *or* comma separated, because both are what people actually type into a field
 * listing hostnames. Entries are lower-cased and de-duplicated: `isBlockedHost` compares
 * against a hostname, which `URL` already lower-cases, and `describeValue` lower-cases
 * the field name it looks up — so an entry saved in mixed case would silently never
 * match anything, which is the worst way for a blocklist to fail.
 */
export function parseRedactionList(raw: string): string[] {
  const entries = new Set<string>();
  for (const entry of raw.split(/[\n,]/)) {
    const trimmed = entry.trim().toLowerCase();
    if (trimmed) entries.add(trimmed);
  }
  return [...entries];
}

/** True when recording on this host is forbidden by the user's settings. */
export function isBlockedHost(url: string, settings: RedactionSettings): boolean {
  try {
    const host = new URL(url).hostname;
    return settings.blockedHosts.some(
      (blocked) => host === blocked || host.endsWith(`.${blocked}`),
    );
  } catch {
    return false;
  }
}
