import { useEffect, useState } from "react";
import { Card } from "../components/Card";
import { hasCredential } from "../lib/credentials";
import { computeClaudeUsage, type UsageSummary } from "../lib/usage";

function formatCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function DailyCostChart({ days }: { days: UsageSummary["days"] }) {
  if (days.length === 0) {
    return <p className="text-sm text-neutral-500">No Claude Code activity in the last 30 days.</p>;
  }
  const max = Math.max(...days.map((d) => d.cost_usd), 0.01);
  return (
    <div className="flex h-32 items-end gap-1">
      {days.map((d) => (
        <div key={d.date} className="group relative flex-1">
          <div
            className="w-full rounded-t-sm bg-white/20 transition-colors group-hover:bg-white/40"
            style={{ height: `${Math.max((d.cost_usd / max) * 100, 2)}%` }}
          />
          <div className="pointer-events-none absolute bottom-full left-1/2 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded bg-neutral-900 px-2 py-1 text-[12px] text-neutral-100 shadow group-hover:block">
            {d.date} · {formatCost(d.cost_usd)}
          </div>
        </div>
      ))}
    </div>
  );
}

function ModelBreakdown({ models }: { models: UsageSummary["by_model"] }) {
  if (models.length === 0) {
    return <p className="text-sm text-neutral-500">Nothing to show yet.</p>;
  }
  const total = models.reduce((sum, m) => sum + m.cost_usd, 0) || 1;
  return (
    <ul className="flex flex-col gap-2">
      {models.map((m) => (
        <li key={m.model} className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">{m.model}</span>
            <span className="text-neutral-400">{formatCost(m.cost_usd)}</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-white/10">
            <div
              className="h-1.5 rounded-full bg-white/50"
              style={{ width: `${(m.cost_usd / total) * 100}%` }}
            />
          </div>
          <span className="text-xs text-neutral-500">
            {formatTokens(m.input_tokens)} in · {formatTokens(m.output_tokens)} out ·{" "}
            {formatTokens(m.cache_read_tokens)} cache read
          </span>
        </li>
      ))}
    </ul>
  );
}

function ClaudeCodeUsage() {
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setData(await computeClaudeUsage());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Claude Code</h3>
        <button
          onClick={refresh}
          className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-neutral-300 hover:bg-white/10"
        >
          Refresh
        </button>
      </div>

      {loading && <p className="text-sm text-neutral-400">Loading...</p>}
      {!loading && error && <p className="text-sm text-rose-400">{error}</p>}

      {!loading && !error && data && (
        <>
          <div className="flex gap-6">
            <div>
              <p className="text-xs uppercase tracking-wide text-neutral-500">
                Last {data.window_days} days
              </p>
              <p className="text-2xl font-semibold">{formatCost(data.total_cost_usd)}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-neutral-500">Input</p>
              <p className="text-2xl font-semibold">{formatTokens(data.total_input_tokens)}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-neutral-500">Output</p>
              <p className="text-2xl font-semibold">{formatTokens(data.total_output_tokens)}</p>
            </div>
          </div>

          <DailyCostChart days={data.days} />
          <ModelBreakdown models={data.by_model} />

          <p className="text-xs text-neutral-500">
            Estimated from local session logs under ~/.claude/projects using public per-model
            pricing — not official billing, just a rough day-to-day guide.
          </p>
        </>
      )}
    </Card>
  );
}

function JevUsage() {
  const [configured, setConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    hasCredential("jev.api_key").then(setConfigured);
  }, []);

  return (
    <Card className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">Jev</h3>
      {configured === false && (
        <p className="text-sm text-neutral-500">
          No Jev API key set in Settings yet — add one there to enable this section.
        </p>
      )}
      {configured === true && (
        <p className="text-sm text-neutral-500">
          Jev API key is set, but usage/cost reporting isn't wired up yet — Jev's usage API
          details weren't available when this was built. Share the endpoint/docs and this can be
          connected.
        </p>
      )}
    </Card>
  );
}

export function Usage() {
  return (
    <div className="flex flex-col gap-4 p-6">
      <h2 className="text-lg font-semibold text-neutral-100">Usage</h2>
      <ClaudeCodeUsage />
      <JevUsage />
    </div>
  );
}
