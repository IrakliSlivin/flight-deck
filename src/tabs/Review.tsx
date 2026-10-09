import { Fragment, createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Card, GhostButton, SectionHeader } from "../components/Card";
import { highlight, languageFor } from "../lib/highlight";
import { PROVIDER_NAME, type PrProvider, type PullRequest } from "../lib/prs";
import {
  SEVERITIES,
  cancelReview,
  fetchPrDiff,
  findingCommentBody,
  getPrReview,
  postFindingComment,
  startReview,
  submitDecision,
  useReviews,
  type DecisionKind,
  type DiffFile,
  type DiffLine,
  type Finding,
  type PrDiff,
  type Review as ReviewResult,
  type SavedReview,
  type Severity,
} from "../lib/review";

const SEVERITY_META: Record<Severity, { label: string; color: string; text: string }> = {
  blocker: { label: "Blocker", color: "#fb7185", text: "text-rose-300" },
  major: { label: "Major", color: "#fbbf24", text: "text-amber-300" },
  minor: { label: "Minor", color: "#38bdf8", text: "text-sky-300" },
  nit: { label: "Nit", color: "#94a3b8", text: "text-slate-400" },
};

const VERDICT_META: Record<ReviewResult["verdict"], { label: string; className: string }> = {
  approve: { label: "Looks good to merge", className: "bg-emerald-400/15 text-emerald-300" },
  comment: { label: "Worth a comment", className: "bg-sky-400/15 text-sky-300" },
  request_changes: { label: "Changes needed", className: "bg-rose-400/15 text-rose-300" },
};

const RISK_TEXT: Record<ReviewResult["risk"], string> = {
  low: "text-emerald-300",
  medium: "text-amber-300",
  high: "text-rose-300",
};

const STATUS_LETTER: Record<DiffFile["status"], { letter: string; className: string }> = {
  added: { letter: "A", className: "text-emerald-400" },
  modified: { letter: "M", className: "text-amber-300" },
  deleted: { letter: "D", className: "text-rose-400" },
  renamed: { letter: "R", className: "text-sky-300" },
};

/** Files longer than this start collapsed unless the review points at them. */
const OPEN_LINES = 400;

const rank = (s: Severity) => SEVERITIES.indexOf(s);

/** Whether a finding covers a diff line (on the finding's side). */
function covers(f: Finding, line: DiffLine): boolean {
  const n = f.side === "new" ? (line.kind === "del" ? null : line.new) : line.kind === "add" ? null : line.old;
  return n !== null && n >= f.start_line && n <= f.end_line;
}

/** Whether a finding's card goes right after this line (its last covered line). */
function endsAt(f: Finding, line: DiffLine): boolean {
  const n = f.side === "new" ? (line.kind === "del" ? null : line.new) : line.kind === "add" ? null : line.old;
  return n === f.end_line;
}

function lineCount(file: DiffFile) {
  return file.hunks.reduce((n, h) => n + h.lines.length, 0);
}

function splitPath(path: string): [string, string] {
  const i = path.lastIndexOf("/");
  return i < 0 ? ["", path] : [path.slice(0, i + 1), path.slice(i + 1)];
}

function formatAgo(iso: string): string {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function SeverityBadge({ severity }: { severity: Severity }) {
  const meta = SEVERITY_META[severity];
  return (
    <span
      className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider"
      style={{ color: meta.color, background: `${meta.color}1f` }}
    >
      {meta.label}
    </span>
  );
}

function CodeBlock({ code, language, tone }: { code: string; language: string | null; tone: "del" | "add" }) {
  return (
    <pre
      className={`code overflow-x-auto rounded-md px-3 py-2 font-mono text-[12px] leading-5 ${
        tone === "add" ? "bg-emerald-400/[0.07] text-slate-200" : "bg-rose-400/[0.07] text-slate-300"
      }`}
      dangerouslySetInnerHTML={{ __html: highlight(code, language) }}
    />
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <GhostButton
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "Copied" : "Copy"}
    </GhostButton>
  );
}

/** What a finding card needs to post itself to the PR. */
interface PostingContext {
  provider: PrProvider;
  url: string;
  /** The saved review's findings, to find a card's index. */
  findings: Finding[];
  /** New commits since the review, so a line comment may land on moved code. */
  stale: boolean;
  /** A (re-)review is running; it will replace the saved review, so posting waits. */
  busy: boolean;
}

const Posting = createContext<PostingContext | null>(null);

function PostedLink({ url, label }: { url: string; label: string }) {
  return (
    <button onClick={() => openUrl(url)} className="font-mono text-[11px] text-emerald-300 hover:text-emerald-200">
      ✓ {label} ↗
    </button>
  );
}

/** "Comment on PR": an editable draft of the finding's comment, posted on its line. */
function FindingComment({ finding }: { finding: Finding }) {
  const ctx = useContext(Posting);
  const [draft, setDraft] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!ctx) return null;
  const index = ctx.findings.indexOf(finding);
  if (index < 0) return null;
  if (finding.posted_url) {
    return (
      <div className="mt-2.5 flex justify-end">
        <PostedLink url={finding.posted_url} label={`Commented on ${PROVIDER_NAME[ctx.provider]}`} />
      </div>
    );
  }
  if (draft === null) {
    return (
      <div className="mt-2.5 flex justify-end">
        <GhostButton onClick={() => setDraft(findingCommentBody(finding, ctx.provider))}>Comment on PR</GhostButton>
      </div>
    );
  }

  async function post() {
    setPosting(true);
    setError(null);
    try {
      await postFindingComment(ctx!.url, index, draft!);
    } catch (e) {
      setError(String(e));
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="mt-2.5 rounded-md border border-white/[0.08] bg-black/20 p-2">
      <p className="mb-1.5 font-mono text-[10px] text-slate-500">
        {finding.anchored
          ? `On line ${finding.end_line}${finding.side === "old" ? " (removed)" : ""} of ${finding.file}`
          : "On the PR (this finding isn't on a line in the diff)"}
        {ctx.stale && finding.anchored && " · new commits since the review, the line may have moved"}
      </p>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={Math.min(14, draft.split("\n").length + 1)}
        className="w-full resize-y rounded border border-white/10 bg-[#0b1018] px-2.5 py-2 font-mono text-[12px] leading-5 text-slate-200 outline-none focus:border-amber-300/50"
      />
      {error && <p className="mt-1 whitespace-pre-line text-xs text-rose-300">{error}</p>}
      <div className="mt-1.5 flex justify-end gap-2">
        <GhostButton onClick={() => setDraft(null)}>Cancel</GhostButton>
        <button
          onClick={post}
          disabled={posting || ctx.busy || !draft.trim()}
          className="label rounded-md bg-amber-300 px-2.5 py-1 !text-[11px] text-slate-900 transition hover:bg-amber-200 disabled:opacity-50"
        >
          {posting ? "Posting…" : `Post to ${PROVIDER_NAME[ctx.provider]}`}
        </button>
      </div>
    </div>
  );
}

function FindingCard({ finding, file }: { finding: Finding; file?: DiffFile }) {
  const language = languageFor(finding.file);
  // The code the suggestion replaces: the finding's lines on the new side.
  const before =
    file && finding.side === "new"
      ? file.hunks
          .flatMap((h) => h.lines)
          .filter((l) => covers(finding, l))
          .map((l) => l.text)
          .join("\n")
      : "";
  const lines =
    finding.start_line === finding.end_line ? `L${finding.start_line}` : `L${finding.start_line}–${finding.end_line}`;
  return (
    <div
      className="rounded-lg border border-white/[0.08] bg-[#121824] p-3 font-sans"
      style={{ borderLeft: `3px solid ${SEVERITY_META[finding.severity].color}` }}
    >
      <div className="flex items-center gap-2">
        <SeverityBadge severity={finding.severity} />
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-slate-500">
          {finding.category}
        </span>
        <p className="min-w-0 flex-1 text-sm font-medium text-slate-100">{finding.title}</p>
        {finding.anchored && (
          <span className="shrink-0 font-mono text-[10px] text-slate-500">
            {finding.side === "old" ? "removed " : ""}
            {lines}
          </span>
        )}
      </div>
      <p className="mt-1.5 whitespace-pre-line text-[13px] leading-relaxed text-slate-300">{finding.explanation}</p>
      {finding.suggestion.trim() && (
        <div className="mt-2.5">
          <div className="mb-1 flex items-center justify-between">
            <span className="label !text-[10px] text-slate-500">Suggested fix</span>
            <CopyButton text={finding.suggestion} />
          </div>
          <div className="flex flex-col gap-1">
            {before && <CodeBlock code={before} language={language} tone="del" />}
            <CodeBlock code={finding.suggestion} language={language} tone="add" />
          </div>
        </div>
      )}
      <FindingComment finding={finding} />
    </div>
  );
}

const DECISION_DONE: Record<DecisionKind, string> = {
  approve: "You approved",
  request_changes: "You requested changes",
  comment: "You commented",
};

/** Approve / request changes / comment on the PR, with an optional comment. */
function DecisionCard({ saved, stale, busy }: { saved: SavedReview; stale: boolean; busy: boolean }) {
  const [body, setBody] = useState("");
  const [confirming, setConfirming] = useState<DecisionKind | null>(null);
  const [sending, setSending] = useState<DecisionKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const provider = saved.provider;
  const gitlab = provider === "gitlab";

  // Approve and request changes take a second click, so a stray one doesn't decide.
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(null), 4000);
    return () => clearTimeout(timer);
  }, [confirming]);

  async function decide(kind: DecisionKind) {
    if (kind !== "comment" && confirming !== kind) {
      setConfirming(kind);
      return;
    }
    setConfirming(null);
    setSending(kind);
    setError(null);
    try {
      await submitDecision(saved.url, kind, body);
      setBody("");
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(null);
    }
  }

  const needsComment = gitlab && !body.trim();
  const disabled = !!sending || busy;
  const last = saved.decision;

  return (
    <Card tone="glass" delay={90}>
      <SectionHeader
        title="Your review"
        right={
          last && (
            <span className="flex items-center gap-3 font-mono text-[11px] text-slate-400">
              {DECISION_DONE[last.kind]} {formatAgo(last.at)}
              {last.comment_url && <PostedLink url={last.comment_url} label="comment" />}
            </span>
          )
        }
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        placeholder={`Comment on the ${gitlab ? "MR" : "PR"} (optional${gitlab ? ", required to request changes" : ""})`}
        className="w-full resize-y rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-amber-300/50"
      />
      {error && <p className="mt-1.5 whitespace-pre-line text-xs text-rose-300">{error}</p>}
      {stale && (
        <p className="mt-1.5 text-xs text-amber-200">
          New commits since this review: approving now also approves code Claude hasn't seen.
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setBody(saved.review.summary)}
          className="font-mono text-[11px] text-slate-500 transition hover:text-amber-200"
        >
          ✦ Use Claude's summary
        </button>
        <span className="ml-auto" />
        <GhostButton onClick={() => !disabled && body.trim() && decide("comment")}>
          {sending === "comment" ? "Posting…" : "Comment"}
        </GhostButton>
        <button
          onClick={() => decide("request_changes")}
          disabled={disabled || needsComment}
          title={
            gitlab
              ? "GitLab's API has no request-changes state: this withdraws your approval and posts the comment"
              : undefined
          }
          className="label rounded-md border border-rose-400/40 bg-rose-400/10 px-3 py-1.5 !text-[11px] text-rose-200 transition hover:bg-rose-400/20 disabled:opacity-40"
        >
          {sending === "request_changes"
            ? "Sending…"
            : confirming === "request_changes"
              ? "Confirm request changes"
              : "Request changes"}
        </button>
        <button
          onClick={() => decide("approve")}
          disabled={disabled}
          className="label rounded-md border border-emerald-400/40 bg-emerald-400/15 px-3 py-1.5 !text-[11px] text-emerald-200 transition hover:bg-emerald-400/25 disabled:opacity-40"
        >
          {sending === "approve" ? "Approving…" : confirming === "approve" ? "Confirm approve" : "Approve"}
        </button>
      </div>
    </Card>
  );
}

const ROW_TONE: Record<DiffLine["kind"], string> = {
  add: "bg-emerald-400/[0.07]",
  del: "bg-rose-400/[0.07]",
  ctx: "",
};

const MARKER: Record<DiffLine["kind"], string> = { add: "+", del: "−", ctx: "" };

function DiffTable({ file, findings }: { file: DiffFile; findings: Finding[] }) {
  const language = languageFor(file.path);
  const html = useMemo(() => file.hunks.map((h) => h.lines.map((l) => highlight(l.text, language))), [file, language]);
  return (
    <table className="code w-full table-fixed border-collapse font-mono text-[12px] leading-5">
      <colgroup>
        <col className="w-12" />
        <col className="w-12" />
        <col />
      </colgroup>
      <tbody>
        {file.hunks.map((hunk, h) => (
          <Fragment key={h}>
            <tr>
              <td colSpan={3} className="truncate bg-sky-400/[0.05] px-3 py-1 text-[11px] text-slate-500">
                {hunk.header}
              </td>
            </tr>
            {hunk.lines.map((line, i) => {
              const marks = findings.filter((f) => covers(f, line));
              const worst = marks.length
                ? marks.reduce((a, b) => (rank(a.severity) <= rank(b.severity) ? a : b))
                : null;
              const ending = findings.filter((f) => endsAt(f, line));
              const color = worst ? SEVERITY_META[worst.severity].color : null;
              return (
                <Fragment key={i}>
                  <tr
                    className={ROW_TONE[line.kind]}
                    style={color ? { backgroundImage: `linear-gradient(${color}1a, ${color}1a)` } : undefined}
                  >
                    <td
                      className="select-none pr-2 text-right align-top text-slate-600"
                      style={color ? { boxShadow: `inset 3px 0 0 ${color}` } : undefined}
                    >
                      {line.old ?? ""}
                    </td>
                    <td className="select-none pr-2 text-right align-top text-slate-600">{line.new ?? ""}</td>
                    <td className="relative whitespace-pre-wrap break-all pr-3 pl-5 align-top text-slate-200">
                      <span
                        className={`absolute left-1.5 select-none ${line.kind === "add" ? "text-emerald-400" : "text-rose-400"}`}
                      >
                        {MARKER[line.kind]}
                      </span>
                      <span dangerouslySetInnerHTML={{ __html: html[h][i] || " " }} />
                    </td>
                  </tr>
                  {ending.map((f, k) => (
                    <tr key={`f${k}`}>
                      <td colSpan={3} className="px-3 py-2">
                        <FindingCard finding={f} file={file} />
                      </td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

function FileCard({
  file,
  index,
  findings,
  keyChange,
  open,
  onToggle,
}: {
  file: DiffFile;
  index: number;
  findings: Finding[];
  keyChange?: ReviewResult["key_changes"][number];
  open: boolean;
  onToggle: () => void;
}) {
  const [dir, name] = splitPath(file.path);
  const status = STATUS_LETTER[file.status];
  return (
    <div id={`review-file-${index}`} className="glass scroll-mt-3 overflow-hidden rounded-2xl">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-white/[0.02]"
      >
        <span className={`text-[10px] text-slate-500 transition ${open ? "rotate-90" : ""}`}>▶</span>
        <span className={`font-mono text-[11px] font-semibold ${status.className}`}>{status.letter}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[13px]">
          <span className="text-slate-500">{dir}</span>
          <span className="text-slate-100">{name}</span>
          {file.status === "renamed" && <span className="text-slate-500"> ← {file.old_path}</span>}
        </span>
        {SEVERITIES.map((s) => {
          const n = findings.filter((f) => f.severity === s).length;
          return n ? (
            <span key={s} className={`font-mono text-[11px] ${SEVERITY_META[s].text}`} title={SEVERITY_META[s].label}>
              ● {n}
            </span>
          ) : null;
        })}
        <span className="shrink-0 font-mono text-[11px]">
          <span className="text-emerald-400">+{file.additions}</span>{" "}
          <span className="text-rose-400">−{file.deletions}</span>
        </span>
      </button>
      {keyChange && (
        <p className="flex gap-2 border-t border-white/[0.05] px-4 py-2 text-[13px] text-slate-300">
          <span className="text-amber-300">✦</span>
          <span>{keyChange.summary}</span>
        </p>
      )}
      {open && (
        <div className="border-t border-white/[0.05]">
          {file.binary ? (
            <p className="px-4 py-3 font-mono text-xs text-slate-500">
              No text diff (binary, or too large for the API).
            </p>
          ) : file.hunks.length === 0 ? (
            <p className="px-4 py-3 font-mono text-xs text-slate-500">Renamed without changes.</p>
          ) : (
            <DiffTable file={file} findings={findings} />
          )}
        </div>
      )}
    </div>
  );
}

function ReviewSummaryCard({ saved, onJump }: { saved: SavedReview; onJump: (path: string) => void }) {
  const { review } = saved;
  const verdict = VERDICT_META[review.verdict];
  const loose = review.findings.filter((f) => !f.anchored);
  return (
    <Card tone="glass" delay={60}>
      <div className="flex flex-wrap items-center gap-3">
        <span className={`rounded-full px-3 py-1 font-mono text-[11px] font-semibold ${verdict.className}`}>
          {verdict.label}
        </span>
        <span className="font-mono text-[11px] text-slate-500">
          risk <span className={RISK_TEXT[review.risk]}>{review.risk}</span>
        </span>
        <span className="font-mono text-[11px] text-slate-500">reviewed {formatAgo(saved.reviewed_at)}</span>
        <span className="ml-auto flex gap-3">
          {SEVERITIES.map((s) => {
            const n = review.findings.filter((f) => f.severity === s).length;
            return (
              <span key={s} className={`font-mono text-[11px] ${n ? SEVERITY_META[s].text : "text-slate-600"}`}>
                {n} {SEVERITY_META[s].label.toLowerCase()}
                {n === 1 || s === "nit" ? "" : "s"}
              </span>
            );
          })}
        </span>
      </div>
      <p className="mt-3 text-[15px] leading-relaxed text-slate-200">{review.summary}</p>

      {review.key_changes.length > 0 && (
        <div className="mt-4">
          <SectionHeader title="Read these first" />
          <ul className="flex flex-col">
            {review.key_changes.map((k, i) => {
              const [dir, name] = splitPath(k.file);
              return (
                <li key={i}>
                  <button
                    onClick={() => onJump(k.file)}
                    className="flex w-full items-baseline gap-3 rounded px-1.5 py-1 text-left transition-colors hover:bg-white/[0.04]"
                  >
                    <span
                      className={`h-1.5 w-1.5 shrink-0 -translate-y-0.5 rounded-full ${
                        k.importance === "high"
                          ? "bg-amber-300"
                          : k.importance === "medium"
                            ? "bg-sky-400"
                            : "bg-slate-500"
                      }`}
                    />
                    <span className="w-72 shrink-0 truncate font-mono text-xs" title={k.file}>
                      <span className="text-slate-500">{dir}</span>
                      <span className="text-slate-200">{name}</span>
                    </span>
                    <span className="min-w-0 flex-1 text-xs text-slate-400">{k.summary}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {loose.length > 0 && (
        <div className="mt-4">
          <SectionHeader title="General notes" />
          <div className="flex flex-col gap-2">
            {loose.map((f, i) => (
              <div key={i}>
                <p className="mb-1 font-mono text-[11px] text-slate-500">{f.file}</p>
                <FindingCard finding={f} />
              </div>
            ))}
          </div>
        </div>
      )}

      {saved.omitted.length > 0 && (
        <p className="mt-4 font-mono text-[11px] text-slate-500">
          Not reviewed: {saved.omitted.map((o) => `${o.path} (${o.reason})`).join(", ")}
        </p>
      )}
    </Card>
  );
}

function FileNav({
  files,
  findingsByFile,
  keyFiles,
  onJump,
}: {
  files: { file: DiffFile; index: number }[];
  findingsByFile: Map<string, Finding[]>;
  keyFiles: Set<string>;
  onJump: (index: number) => void;
}) {
  return (
    <nav className="glass sticky top-2 max-h-[calc(100vh-7rem)] self-start overflow-y-auto rounded-2xl p-2">
      <p className="label px-2 pt-1 pb-2 !text-[11px] text-slate-400">Files · {files.length}</p>
      <ul className="flex flex-col">
        {files.map(({ file, index }) => {
          const [, name] = splitPath(file.path);
          const findings = findingsByFile.get(file.path) ?? [];
          const worst = findings.reduce<Severity | null>(
            (w, f) => (w === null || rank(f.severity) < rank(w) ? f.severity : w),
            null,
          );
          return (
            <li key={index}>
              <button
                onClick={() => onJump(index)}
                title={file.path}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-white/[0.04]"
              >
                <span className={`font-mono text-[10px] font-semibold ${STATUS_LETTER[file.status].className}`}>
                  {STATUS_LETTER[file.status].letter}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-slate-300">{name}</span>
                {keyFiles.has(file.path) && <span className="text-[10px] text-amber-300">✦</span>}
                {worst && (
                  <span className={`font-mono text-[10px] ${SEVERITY_META[worst].text}`}>{findings.length}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function Review({ pr, onBack }: { pr: PullRequest; onBack: () => void }) {
  const { running, errors, results } = useReviews();
  const [saved, setSaved] = useState<SavedReview | null | undefined>(undefined);
  const [current, setCurrent] = useState<PrDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [openFiles, setOpenFiles] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(Date.now());
  const autoStarted = useRef(false);

  const startedAt = running[pr.url];
  const result = results[pr.url] ?? saved ?? null;
  const error = errors[pr.url];

  useEffect(() => {
    getPrReview(pr.url)
      .then(setSaved)
      .catch(() => setSaved(null));
    fetchPrDiff(pr.provider, pr.url)
      .then(setCurrent)
      .catch((e) => setDiffError(String(e)));
  }, [pr.provider, pr.url]);

  // Opening a PR that has no review yet starts one.
  useEffect(() => {
    if (saved === null && !results[pr.url] && !startedAt && !error && !autoStarted.current) {
      autoStarted.current = true;
      startReview(pr.provider, pr.url);
    }
  }, [saved, results, startedAt, error, pr.provider, pr.url]);

  useEffect(() => {
    if (!startedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  // The findings' line numbers refer to the reviewed diff, so that is the one shown with them.
  const shown = result?.pr ?? current;
  const stale = !!(result && current && current.head_sha && current.head_sha !== result.pr.head_sha);

  const findingsByFile = useMemo(() => {
    const map = new Map<string, Finding[]>();
    for (const f of result?.review.findings ?? []) {
      if (!f.anchored) continue;
      map.set(f.file, [...(map.get(f.file) ?? []), f]);
    }
    return map;
  }, [result]);

  const keyChanges = useMemo(() => new Map((result?.review.key_changes ?? []).map((k) => [k.file, k])), [result]);

  // Files with findings first (worst first), then the ones Claude says to read, then the rest.
  const orderedFiles = useMemo(() => {
    const files = (shown?.files ?? []).map((file, index) => ({ file, index }));
    const score = (file: DiffFile) => {
      const findings = findingsByFile.get(file.path) ?? [];
      if (findings.length) return Math.min(...findings.map((f) => rank(f.severity)));
      return keyChanges.has(file.path) ? SEVERITIES.length : SEVERITIES.length + 1;
    };
    return files.sort((a, b) => score(a.file) - score(b.file) || a.index - b.index);
  }, [shown, findingsByFile, keyChanges]);

  const isOpen = (file: DiffFile) =>
    openFiles[file.path] ??
    (result ? findingsByFile.has(file.path) || keyChanges.has(file.path) : lineCount(file) <= OPEN_LINES);

  function jumpTo(index: number) {
    const file = shown?.files[index];
    if (!file) return;
    setOpenFiles((o) => ({ ...o, [file.path]: true }));
    requestAnimationFrame(() =>
      document.getElementById(`review-file-${index}`)?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  }

  const jumpToPath = (path: string) => {
    const index = shown?.files.findIndex((f) => f.path === path || f.old_path === path) ?? -1;
    if (index >= 0) jumpTo(index);
  };

  const repo = pr.source_repo.split("/").pop();
  const additions = shown?.files.reduce((n, f) => n + f.additions, 0) ?? 0;
  const deletions = shown?.files.reduce((n, f) => n + f.deletions, 0) ?? 0;

  const posting: PostingContext = {
    provider: pr.provider,
    url: pr.url,
    findings: result?.review.findings ?? [],
    stale,
    busy: !!startedAt,
  };

  return (
    <Posting.Provider value={posting}>
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 pt-2 pb-8">
        <div className="rise flex items-start gap-4">
          <button
            onClick={onBack}
            className="label mt-0.5 shrink-0 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 !text-[11px] text-slate-300 transition hover:text-white"
          >
            ← Pull requests
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold text-slate-100">{pr.title}</h2>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-slate-400">
              <span className="text-slate-300">{repo}</span>
              <span className="text-slate-600">·</span>
              <span>
                {pr.provider === "gitlab" ? "!" : "#"}
                {pr.id}
              </span>
              <span className="text-slate-600">·</span>
              <span>{pr.author}</span>
              {shown && (
                <>
                  <span className="text-slate-600">·</span>
                  <span>
                    {shown.source_branch} → {shown.dest_branch}
                  </span>
                  <span className="text-slate-600">·</span>
                  <span>
                    {shown.files.length} files <span className="text-emerald-400">+{additions}</span>{" "}
                    <span className="text-rose-400">−{deletions}</span>
                  </span>
                </>
              )}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <GhostButton onClick={() => openUrl(pr.url)}>Open in {PROVIDER_NAME[pr.provider]} ↗</GhostButton>
            {startedAt ? (
              <GhostButton onClick={() => cancelReview(pr.url)}>Cancel review</GhostButton>
            ) : (
              saved !== undefined && (
                <GhostButton onClick={() => startReview(pr.provider, pr.url)}>
                  {result ? "✦ Re-review" : "✦ Review with Claude"}
                </GhostButton>
              )
            )}
          </div>
        </div>

        {startedAt && (
          <Card tone="glass" delay={0} className="shimmer">
            <p className="flex items-baseline gap-3 text-sm text-slate-300">
              <span className="text-amber-300">✦</span>
              <span className="blink font-mono text-xs">
                Claude (Opus) is reviewing {shown ? `${shown.files.length} files` : "the diff"}…
              </span>
              <span className="ml-auto font-mono text-xs text-slate-500">{formatElapsed(now - startedAt)}</span>
            </p>
            <p className="mt-1 pl-6 text-xs text-slate-500">
              Usually one to five minutes. You can leave this page; the review keeps running.
            </p>
          </Card>
        )}

        {error && (
          <Card tone="glass" delay={0}>
            <p className="whitespace-pre-line text-sm text-rose-400">{error}</p>
          </Card>
        )}

        {stale && result && (
          <Card tone="glass" delay={0} className="border-amber-300/30">
            <p className="text-sm text-amber-200">
              New commits since this review ({formatAgo(result.reviewed_at)}). The diff below is the reviewed one;
              Re-review to check the latest.
            </p>
          </Card>
        )}

        {result && <ReviewSummaryCard saved={result} onJump={jumpToPath} />}
        {result && <DecisionCard saved={result} stale={stale} busy={!!startedAt} />}

        {!shown ? (
          diffError ? (
            <Card tone="glass">
              <p className="whitespace-pre-line text-sm text-rose-400">{diffError}</p>
            </Card>
          ) : (
            <p className="blink font-mono text-xs text-slate-400">loading the diff…</p>
          )
        ) : (
          <div className="rise grid grid-cols-[240px_minmax(0,1fr)] gap-4" style={{ animationDelay: "120ms" }}>
            <FileNav
              files={orderedFiles}
              findingsByFile={findingsByFile}
              keyFiles={new Set(keyChanges.keys())}
              onJump={jumpTo}
            />
            <div className="flex min-w-0 flex-col gap-3">
              {orderedFiles.map(({ file, index }) => (
                <FileCard
                  key={index}
                  file={file}
                  index={index}
                  findings={findingsByFile.get(file.path) ?? []}
                  keyChange={keyChanges.get(file.path)}
                  open={isOpen(file)}
                  onToggle={() => setOpenFiles((o) => ({ ...o, [file.path]: !isOpen(file) }))}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </Posting.Provider>
  );
}
