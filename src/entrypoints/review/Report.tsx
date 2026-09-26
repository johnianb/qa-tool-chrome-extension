/**
 * The written report: the tester's note, the Generate button, the result, and editing.
 *
 * Every field is editable here. The constraint that the *model* may not invent a step
 * does not apply to the person who performed them — a tester correcting a reworded step
 * or supplying the expected result the model was forbidden to guess at is the review
 * this page exists for. What the tool owes the reader is honesty about which happened,
 * so an edit sets `report.edited`, and every export says so.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatOffset, type BugReport, type Session } from '@/core/session';
import { PROVIDER_NAMES, getSettings, hasApiKey, type Settings } from '@/core/settings';
import { updateSession } from '@/core/storage/db';
import { generateReport } from '@/services/ai';
import { EXPECTED_NOT_STATED } from '@/services/report-schema';

const SEVERITIES: BugReport['severity'][] = ['blocker', 'major', 'minor', 'trivial'];

export function ReportPanel({
  session,
  settings,
  onChanged,
}: {
  session: Session;
  settings: Settings | null;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  // Selecting a different recording must not leave the previous one's failure, token
  // count or half-finished edit sitting under it, attributed to the wrong session.
  useEffect(() => {
    setError(null);
    setUsage(null);
    setEditing(false);
  }, [session.id]);

  const generate = useCallback(async () => {
    setBusy(true);
    setError(null);
    setUsage(null);
    try {
      // Read settings fresh rather than trusting the prop: the tester may have just
      // pasted a key into the panel above without this component re-rendering.
      const current = settings ?? (await getSettings());
      const { report, usage: used } = await generateReport(session, current);
      await updateSession(session.id, (stored) => {
        stored.report = report;
        stored.status = 'reported';
      });
      setUsage(`${used.inputTokens.toLocaleString()} in / ${used.outputTokens.toLocaleString()} out`);
      onChanged();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }, [session, settings, onChanged]);

  const save = useCallback(
    async (next: BugReport) => {
      await updateSession(session.id, (stored) => {
        stored.report = next;
      });
      setEditing(false);
      onChanged();
    },
    [session.id, onChanged],
  );

  const ready = settings === null || hasApiKey(settings);
  /*
    Named before the settings have loaded too — the button must not flash a different
    model's name on the way in, so it falls back to the default provider's.
  */
  const writer = PROVIDER_NAMES[settings?.provider ?? 'anthropic'];

  return (
    <section className="mt-5 rounded-xl border border-neutral-200 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">
          Report
          {session.report?.edited && (
            <span className="ml-2 font-normal text-neutral-500">edited by hand</span>
          )}
        </h3>
        <div className="flex items-center gap-3">
          {usage && <span className="text-xs text-neutral-500 tabular-nums">{usage}</span>}
          {session.report && !editing && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:border-neutral-500"
            >
              Edit
            </button>
          )}
          <button
            type="button"
            onClick={() => void generate()}
            disabled={busy || !ready || editing || session.status === 'recording'}
            className="rounded-lg border border-neutral-900 bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-40"
          >
            {busy ? 'Writing…' : `${session.report ? 'Rewrite' : 'Write'} with ${writer}`}
          </button>
        </div>
      </div>

      <TesterNote session={session} onSaved={onChanged} />

      {!ready && (
        <p className="mt-3 text-sm text-neutral-500">
          Add a{writer === 'Claude' ? 'n Anthropic' : ' Gemini'} API key in Report
          generation settings to write reports.
        </p>
      )}

      {error && (
        <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {editing && session.report ? (
        <ReportEditor
          report={session.report}
          onSave={(next) => void save(next)}
          onCancel={() => setEditing(false)}
        />
      ) : session.report ? (
        <ReportBody report={session.report} />
      ) : (
        !busy && (
          <p className="mt-3 text-sm text-neutral-500">
            No report yet. The steps, console errors and failed requests above are already
            a usable report on their own — this writes them up, judges severity, and says
            where to start looking.
          </p>
        )
      )}
    </section>
  );
}

/**
 * The tester's one-line answer to "what went wrong?".
 *
 * The highest-value field in the whole tool and the only one no amount of capture can
 * supply. It decides the report title, and it is the *only* thing permitted to become
 * the expected result — without it the report says so rather than inventing a spec.
 *
 * Saved on blur: a keystroke-by-keystroke write to IndexedDB would contend with the
 * session record for no benefit.
 */
function TesterNote({ session, onSaved }: { session: Session; onSaved: () => void }) {
  const [text, setText] = useState(session.testerNote ?? '');

  // Resync when a different recording is selected, or this one is reloaded.
  useEffect(() => setText(session.testerNote ?? ''), [session.id, session.testerNote]);

  const save = useCallback(async () => {
    const next = text.trim();
    if (next === (session.testerNote ?? '').trim()) return;
    await updateSession(session.id, (stored) => {
      stored.testerNote = next;
    });
    onSaved();
  }, [text, session.id, session.testerNote, onSaved]);

  return (
    <label className="mt-3 block">
      <span className="block text-sm font-medium">What went wrong?</span>
      <span className="mb-1.5 block text-xs text-neutral-500">
        One line, in your words. This becomes the expected result — leave it empty and the
        report will say the expected behaviour is unknown rather than guess at it.
      </span>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void save()}
        rows={2}
        placeholder="The order total stayed at ₱0 after I applied the discount."
        className="w-full resize-y rounded-lg border border-neutral-300 px-3 py-2 text-sm"
      />
    </label>
  );
}

/** The editable form. Lists are edited as text, one item per line. */
interface Draft {
  title: string;
  summary: string;
  preconditions: string;
  steps: Array<{ action: string; atMs: number }>;
  expectedResult: string;
  actualResult: string;
  severity: BugReport['severity'];
  suspectedArea: string;
  evidence: string;
}

function toDraft(report: BugReport): Draft {
  return {
    title: report.title,
    summary: report.summary,
    preconditions: report.preconditions.join('\n'),
    steps: report.stepsToReproduce.map((step) => ({ action: step.action, atMs: step.atMs })),
    // A tester filling in the expected result the model was forbidden to guess at is
    // the whole point of review, so the sentinel is cleared rather than presented as
    // text to delete.
    expectedResult: report.expectedResult === EXPECTED_NOT_STATED ? '' : report.expectedResult,
    actualResult: report.actualResult,
    severity: report.severity,
    suspectedArea: report.suspectedArea,
    evidence: report.evidence.join('\n'),
  };
}

function fromDraft(draft: Draft): Omit<BugReport, 'edited'> {
  return {
    title: draft.title.trim(),
    summary: draft.summary.trim(),
    preconditions: lines(draft.preconditions),
    // Renumbered so a removed step does not leave a gap. `atMs` is never editable: it
    // comes from the captured event and is what makes the step seek the video.
    stepsToReproduce: draft.steps
      .filter((step) => step.action.trim())
      .map((step, index) => ({ n: index + 1, action: step.action.trim(), atMs: step.atMs })),
    expectedResult: draft.expectedResult.trim() || EXPECTED_NOT_STATED,
    actualResult: draft.actualResult.trim(),
    severity: draft.severity,
    suspectedArea: draft.suspectedArea.trim(),
    evidence: lines(draft.evidence),
  };
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function ReportEditor({
  report,
  onSave,
  onCancel,
}: {
  report: BugReport;
  onSave: (next: BugReport) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(report));

  useEffect(() => setDraft(toDraft(report)), [report]);

  const set = useCallback(
    <K extends keyof Draft>(key: K, value: Draft[K]) =>
      setDraft((current) => ({ ...current, [key]: value })),
    [],
  );

  /**
   * Whether anything actually changed.
   *
   * `edited` is a claim made to whoever reads the ticket, so it is set only when the
   * content differs — opening the editor and pressing Save must not relabel an
   * untouched report as human-written.
   */
  const changed = useMemo(() => {
    const { edited: _edited, ...original } = report;
    return JSON.stringify(fromDraft(draft)) !== JSON.stringify(original);
  }, [draft, report]);

  return (
    <div className="mt-4 border-t border-neutral-200 pt-4">
      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
        <Field label="Title">
          <input
            type="text"
            value={draft.title}
            onChange={(e) => set('title', e.target.value)}
            className="w-full rounded-lg border border-neutral-300 px-3 py-1.5 text-sm"
          />
        </Field>
        <Field label="Severity">
          <select
            value={draft.severity}
            onChange={(e) => set('severity', e.target.value as BugReport['severity'])}
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm"
          >
            {SEVERITIES.map((severity) => (
              <option key={severity} value={severity}>
                {severity}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="Summary" className="mt-4">
        <Area value={draft.summary} rows={3} onChange={(value) => set('summary', value)} />
      </Field>

      <Field label="Preconditions" hint="One per line. Leave empty for none." className="mt-4">
        <Area
          value={draft.preconditions}
          rows={2}
          onChange={(value) => set('preconditions', value)}
        />
      </Field>

      <Field
        label="Steps to reproduce"
        hint="Reword freely; the timestamp stays tied to the captured event. Remove a step to drop it."
        className="mt-4"
      >
        <ol className="space-y-2">
          {draft.steps.map((step, index) => (
            <li key={`${step.atMs}-${index}`} className="flex items-start gap-2">
              <span className="w-4 shrink-0 pt-2 text-right text-xs text-neutral-400 tabular-nums">
                {index + 1}
              </span>
              <textarea
                value={step.action}
                rows={1}
                onChange={(e) =>
                  set(
                    'steps',
                    draft.steps.map((other, i) =>
                      i === index ? { ...other, action: e.target.value } : other,
                    ),
                  )
                }
                className="min-w-0 flex-1 resize-y rounded-lg border border-neutral-300 px-3 py-1.5 text-sm"
              />
              <span className="shrink-0 pt-2 text-xs text-neutral-400 tabular-nums">
                {formatOffset(step.atMs)}
              </span>
              <button
                type="button"
                onClick={() => set('steps', draft.steps.filter((_, i) => i !== index))}
                aria-label={`Remove step ${index + 1}`}
                className="shrink-0 px-1 pt-1.5 text-sm text-neutral-400 hover:text-red-600"
              >
                ✕
              </button>
            </li>
          ))}
        </ol>
        {draft.steps.length === 0 && (
          <p className="text-sm text-neutral-500">
            Every step was removed. Cancel to restore them, or write the report again.
          </p>
        )}
      </Field>

      <Field
        label="Expected result"
        hint={`Empty becomes "${EXPECTED_NOT_STATED}" — the tool will not invent one, but you can state it.`}
        className="mt-4"
      >
        <Area
          value={draft.expectedResult}
          rows={2}
          onChange={(value) => set('expectedResult', value)}
        />
      </Field>

      <Field label="Actual result" className="mt-4">
        <Area value={draft.actualResult} rows={3} onChange={(value) => set('actualResult', value)} />
      </Field>

      <Field label="Suspected area" className="mt-4">
        <input
          type="text"
          value={draft.suspectedArea}
          onChange={(e) => set('suspectedArea', e.target.value)}
          className="w-full rounded-lg border border-neutral-300 px-3 py-1.5 text-sm"
        />
      </Field>

      <Field
        label="Evidence"
        hint="One per line. These are quoted log lines — check before rewording them."
        className="mt-4"
      >
        <Area value={draft.evidence} rows={4} onChange={(value) => set('evidence', value)} />
      </Field>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={() => onSave({ ...fromDraft(draft), edited: report.edited || changed })}
          className="rounded-lg border border-neutral-900 bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700"
        >
          Save
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:border-neutral-500"
        >
          Cancel
        </button>
        <span className="text-xs text-neutral-500">
          {changed ? 'Saving marks this report as edited by hand.' : 'No changes yet.'}
        </span>
      </div>
    </div>
  );
}

function Area({
  value,
  rows,
  onChange,
}: {
  value: string;
  rows: number;
  onChange: (value: string) => void;
}) {
  return (
    <textarea
      value={value}
      rows={rows}
      onChange={(e) => onChange(e.target.value)}
      className="w-full resize-y rounded-lg border border-neutral-300 px-3 py-2 text-sm"
    />
  );
}

function Field({
  label,
  hint,
  className = '',
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <span className="block text-sm font-medium">{label}</span>
      {hint && <span className="mb-1.5 block text-xs text-neutral-500">{hint}</span>}
      {children}
    </div>
  );
}

function ReportBody({ report }: { report: BugReport }) {
  return (
    <article className="mt-4 border-t border-neutral-200 pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-base font-semibold">{report.title}</h4>
        <SeverityTag severity={report.severity} />
      </div>

      <p className="mt-2 text-sm leading-relaxed">{report.summary}</p>

      {report.preconditions.length > 0 && (
        <Block title="Preconditions">
          <ul className="list-disc pl-5">
            {report.preconditions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </Block>
      )}

      <Block title="Steps to reproduce">
        <ol className="list-decimal pl-5">
          {report.stepsToReproduce.map((step) => (
            <li key={step.n}>
              {step.action}{' '}
              <span className="text-neutral-400 tabular-nums">{formatOffset(step.atMs)}</span>
            </li>
          ))}
        </ol>
      </Block>

      <Block title="Expected result">
        <p className={report.expectedResult === EXPECTED_NOT_STATED ? 'text-neutral-500' : ''}>
          {report.expectedResult}
        </p>
      </Block>

      <Block title="Actual result">
        <p>{report.actualResult}</p>
      </Block>

      <Block title="Suspected area">
        <p>{report.suspectedArea}</p>
      </Block>

      {report.evidence.length > 0 && (
        <Block title="Evidence">
          <ul className="list-disc pl-5">
            {report.evidence.map((item) => (
              <li key={item} className="break-words">
                {item}
              </li>
            ))}
          </ul>
        </Block>
      )}
    </article>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <h5 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{title}</h5>
      <div className="mt-1 space-y-1 text-sm leading-relaxed">{children}</div>
    </div>
  );
}

function SeverityTag({ severity }: { severity: BugReport['severity'] }) {
  const tone = {
    blocker: 'border-red-300 bg-red-50 text-red-700',
    major: 'border-orange-300 bg-orange-50 text-orange-700',
    minor: 'border-amber-300 bg-amber-50 text-amber-700',
    trivial: 'border-neutral-300 bg-neutral-50 text-neutral-600',
  }[severity];

  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${tone}`}>
      {severity}
    </span>
  );
}
