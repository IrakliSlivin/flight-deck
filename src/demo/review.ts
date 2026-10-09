// Demo mode's PR review: every PR gets the same small Rails diff, and "reviewing" it returns a
// canned review after a few seconds. One PR (#415) starts out already reviewed.
import type { BitbucketPr } from "../lib/bitbucket";
import type { Decision, DiffFile, DiffLine, PrDiff, Review, ReviewSummary, SavedReview } from "../lib/review";
import { bitbucketPrs, gitlabPrs } from "./data";

/** A one-hunk file from diff rows ("+", "-" or " " then the code). */
function file(
  path: string,
  status: DiffFile["status"],
  oldStart: number,
  newStart: number,
  header: string,
  rows: string[],
): DiffFile {
  let old = oldStart;
  let neu = newStart;
  const lines: DiffLine[] = rows.map((row) => {
    const text = row.slice(1);
    if (row[0] === "+") return { kind: "add", old: null, new: neu++, text };
    if (row[0] === "-") return { kind: "del", old: old++, new: null, text };
    return { kind: "ctx", old: old++, new: neu++, text };
  });
  const count = (kind: DiffLine["kind"]) => lines.filter((l) => l.kind === kind).length;
  const oldLen = count("ctx") + count("del");
  const newLen = count("ctx") + count("add");
  return {
    path,
    old_path: path,
    status,
    binary: false,
    additions: count("add"),
    deletions: count("del"),
    hunks: [{ header: `@@ -${oldStart},${oldLen} +${newStart},${newLen} @@ ${header}`, lines }],
  };
}

const FILES: DiffFile[] = [
  file(
    "app/controllers/invoices_controller.rb",
    "modified",
    12,
    12,
    "class InvoicesController < ApplicationController",
    [
      "   def index",
      "     @invoices = current_account.invoices.order(created_at: :desc)",
      "   end",
      "+",
      "+  def export",
      "+    invoices = Invoice.where(\"status = '#{params[:status]}'\")",
      "+    csv = CSV.generate do |rows|",
      "+      rows << export_columns",
      "+      invoices.each do |invoice|",
      "+        rows << [invoice.number, invoice.patient.name, invoice.total]",
      "+      end",
      "+    end",
      '+    send_data csv, filename: "invoices-#{Date.current}.csv"',
      "+  end",
      " ",
      "   private",
    ],
  ),
  file("db/migrate/20261008093000_add_exported_at_to_invoices.rb", "added", 0, 1, "", [
    "+class AddExportedAtToInvoices < ActiveRecord::Migration[7.1]",
    "+  def change",
    "+    add_column :invoices, :exported_at, :datetime",
    "+    add_index :invoices, :exported_at",
    "+  end",
    "+end",
  ]),
  file("config/routes.rb", "modified", 8, 8, "Rails.application.routes.draw do", [
    "   resources :patients",
    "-  resources :invoices, only: [:index, :show]",
    "+  resources :invoices, only: [:index, :show] do",
    "+    get :export, on: :collection",
    "+  end",
    "   resources :payments",
  ]),
  file("spec/requests/invoices_export_spec.rb", "added", 0, 1, "", [
    '+require "rails_helper"',
    "+",
    '+RSpec.describe "Invoice export" do',
    '+  it "returns a CSV" do',
    "+    sign_in create(:user)",
    '+    get export_invoices_path(status: "paid")',
    '+    expect(response.media_type).to eq("text/csv")',
    "+  end",
    "+end",
  ]),
  file("Gemfile.lock", "modified", 210, 210, "GEM", ["     csv (3.3.0)", "-    rack (3.1.7)", "+    rack (3.1.8)"]),
];

const REVIEW: Review = {
  summary:
    "Adds a CSV export of invoices with a status filter, plus an exported_at column. The export builds SQL from a request param and isn't scoped to the current account, so as written it leaks every account's invoices.",
  verdict: "request_changes",
  risk: "high",
  key_changes: [
    {
      file: "app/controllers/invoices_controller.rb",
      importance: "high",
      summary: "New export action: queries invoices by status and streams them as CSV.",
    },
    {
      file: "db/migrate/20261008093000_add_exported_at_to_invoices.rb",
      importance: "medium",
      summary: "Adds and indexes invoices.exported_at, a large table.",
    },
    { file: "config/routes.rb", importance: "low", summary: "Routes GET /invoices/export to the new action." },
  ],
  findings: [
    {
      file: "app/controllers/invoices_controller.rb",
      side: "new",
      start_line: 17,
      end_line: 17,
      severity: "blocker",
      category: "security",
      title: "SQL injection, and the export isn't scoped to the account",
      explanation:
        "params[:status] is interpolated straight into SQL, and the query starts from Invoice instead of current_account.invoices, so any signed-in user can export every account's invoices (or anything else, via the injection).",
      suggestion: "    invoices = current_account.invoices.where(status: params[:status])",
      anchored: true,
      posted_url: "",
    },
    {
      file: "app/controllers/invoices_controller.rb",
      side: "new",
      start_line: 20,
      end_line: 21,
      severity: "major",
      category: "performance",
      title: "N+1 on patient, and every invoice loaded at once",
      explanation:
        "invoice.patient runs one query per row, and each loads the whole result set into memory. Preload patients and iterate in batches.",
      suggestion:
        "      invoices.includes(:patient).find_each do |invoice|\n        rows << [invoice.number, invoice.patient.name, invoice.total]",
      anchored: true,
      posted_url: "",
    },
    {
      file: "db/migrate/20261008093000_add_exported_at_to_invoices.rb",
      side: "new",
      start_line: 4,
      end_line: 4,
      severity: "major",
      category: "data",
      title: "Index build locks writes on invoices",
      explanation:
        "A plain add_index blocks inserts and updates for the whole build. On Postgres, add it concurrently (and outside the migration's transaction with disable_ddl_transaction!).",
      suggestion: "    add_index :invoices, :exported_at, algorithm: :concurrently",
      anchored: true,
      posted_url: "",
    },
    {
      file: "spec/requests/invoices_export_spec.rb",
      side: "new",
      start_line: 40,
      end_line: 44,
      severity: "minor",
      category: "tests",
      title: "No spec for the status filter or another account's invoices",
      explanation:
        "The spec only checks the content type. Add cases that the filter applies and that another account's invoices are left out; the second would have caught the blocker above.",
      suggestion: "",
      anchored: false,
      posted_url: "",
    },
  ],
};

const allPrs = (): BitbucketPr[] => [
  ...bitbucketPrs.authored,
  ...bitbucketPrs.reviewing,
  ...gitlabPrs.authored,
  ...gitlabPrs.reviewing,
];

export function demoDiff(url: string): PrDiff {
  const pr = allPrs().find((p) => p.url === url);
  return {
    title: pr?.title ?? "Demo pull request",
    description: "",
    author: pr?.author ?? "Ada Lovelace",
    source_branch: "feature/invoice-export",
    dest_branch: "main",
    head_sha: "3f9c2e1",
    files: FILES,
  };
}

const saved: Record<string, SavedReview> = {};
const cancelled = new Set<string>();

function save(url: string, reviewedAt: Date): SavedReview {
  const review: SavedReview = {
    provider: "bitbucket",
    url,
    reviewed_at: reviewedAt.toISOString(),
    pr: demoDiff(url),
    omitted: [{ path: "Gemfile.lock", reason: "lock file" }],
    review: structuredClone(REVIEW),
    decision: null,
  };
  saved[url] = review;
  return review;
}

const seeded = bitbucketPrs.reviewing.find((p) => p.id === 415);
if (seeded) save(seeded.url, new Date(Date.now() - 2 * 60 * 60 * 1000));

export const getReview = (url: string) => (saved[url] ? structuredClone(saved[url]) : null);

export const listReviews = (): ReviewSummary[] =>
  Object.values(saved).map((s) => ({
    url: s.url,
    head_sha: s.pr.head_sha,
    reviewed_at: s.reviewed_at,
    verdict: s.review.verdict,
    findings: s.review.findings.length,
    blockers: s.review.findings.filter((f) => f.severity === "blocker").length,
  }));

export async function runReview(url: string): Promise<SavedReview> {
  cancelled.delete(url);
  await new Promise((r) => setTimeout(r, 6000));
  if (cancelled.delete(url)) throw "Review cancelled.";
  return save(url, new Date());
}

export const cancel = (url: string) => void cancelled.add(url);

let commentId = 1000;
const commentUrl = (url: string) => `${url}#comment-${commentId++}`;

export function postComment(url: string, finding: number): SavedReview {
  const review = saved[url];
  review.review.findings[finding].posted_url = commentUrl(url);
  return structuredClone(review);
}

export function submitDecision(url: string, kind: Decision["kind"], body: string): SavedReview {
  const review = saved[url];
  if (kind === "approve" && review.pr.author === "Ada Lovelace")
    throw "Bitbucket refused (400 Bad Request): You can't approve your own pull request.";
  review.decision = { kind, at: new Date().toISOString(), comment_url: body.trim() ? commentUrl(url) : "" };
  return structuredClone(review);
}
