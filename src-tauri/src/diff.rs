use serde::{Deserialize, Serialize};

// Unified diffs (Bitbucket's PR diff, GitLab's per-file diffs) parsed into files, hunks and
// numbered lines. The review page renders these, the prompt numbers its lines from them, and
// review.rs checks Claude's findings against them.

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum LineKind {
    Ctx,
    Add,
    Del,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DiffLine {
    pub kind: LineKind,
    pub old: Option<u32>,
    pub new: Option<u32>,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Hunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Added,
    Deleted,
    Renamed,
    Modified,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DiffFile {
    /// The new path, or the old one for a deleted file.
    pub path: String,
    pub old_path: String,
    pub status: FileStatus,
    pub binary: bool,
    pub additions: u32,
    pub deletions: u32,
    pub hunks: Vec<Hunk>,
}

impl DiffFile {
    /// `binary` means no text diff came back (binary, or too large for the API).
    pub fn new(old_path: &str, new_path: &str, status: FileStatus, hunks: Vec<Hunk>, binary: bool) -> Self {
        let count = |kind| hunks.iter().flat_map(|h| &h.lines).filter(|l| l.kind == kind).count() as u32;
        let path = if status == FileStatus::Deleted { old_path } else { new_path };
        DiffFile {
            path: path.to_string(),
            old_path: old_path.to_string(),
            status,
            binary,
            additions: count(LineKind::Add),
            deletions: count(LineKind::Del),
            hunks,
        }
    }
}

fn hunk_range(spec: &str) -> Option<(u32, u32)> {
    let (start, len) = spec.split_once(',').unwrap_or((spec, "1"));
    Some((start.parse().ok()?, len.parse().ok()?))
}

/// `@@ -10,6 +10,9 @@ def foo` → (10, 6, 10, 9).
fn parse_hunk_header(line: &str) -> Option<(u32, u32, u32, u32)> {
    let rest = line.strip_prefix("@@ -")?;
    let (ranges, _) = rest.split_once(" @@")?;
    let (old, new) = ranges.split_once(" +")?;
    let (old_start, old_len) = hunk_range(old)?;
    let (new_start, new_len) = hunk_range(new)?;
    Some((old_start, old_len, new_start, new_len))
}

/// The hunks of one file's diff (everything from its first `@@`). Each hunk ends when its line
/// counts are used up, so a blank trailing line isn't mistaken for context.
pub fn parse_hunks(text: &str) -> Vec<Hunk> {
    let mut hunks = Vec::new();
    let mut lines = text.lines().peekable();
    while let Some(line) = lines.next() {
        let Some((mut old, mut old_left, mut new, mut new_left)) = parse_hunk_header(line) else {
            continue;
        };
        let mut hunk = Hunk { header: line.to_string(), lines: Vec::new() };
        while old_left > 0 || new_left > 0 {
            let Some(line) = lines.next() else { break };
            // An empty line is a context line whose leading space was trimmed.
            let (marker, body) = match line.chars().next() {
                Some(c) => (c, line[c.len_utf8()..].to_string()),
                None => (' ', String::new()),
            };
            match marker {
                '+' => {
                    hunk.lines.push(DiffLine { kind: LineKind::Add, old: None, new: Some(new), text: body });
                    new += 1;
                    new_left = new_left.saturating_sub(1);
                }
                '-' => {
                    hunk.lines.push(DiffLine { kind: LineKind::Del, old: Some(old), new: None, text: body });
                    old += 1;
                    old_left = old_left.saturating_sub(1);
                }
                '\\' => {} // "\ No newline at end of file"
                _ => {
                    hunk.lines.push(DiffLine { kind: LineKind::Ctx, old: Some(old), new: Some(new), text: body });
                    old += 1;
                    new += 1;
                    old_left = old_left.saturating_sub(1);
                    new_left = new_left.saturating_sub(1);
                }
            }
        }
        while lines.peek().is_some_and(|l| l.starts_with('\\')) {
            lines.next();
        }
        hunks.push(hunk);
    }
    hunks
}

fn strip_side(path: &str, prefix: &str) -> Option<String> {
    let path = path.split('\t').next().unwrap_or(path).trim_end();
    if path == "/dev/null" {
        return None;
    }
    Some(path.strip_prefix(prefix).unwrap_or(path).to_string())
}

/// A whole `git diff`, split on its `diff --git` headers.
pub fn parse_unified(text: &str) -> Vec<DiffFile> {
    let mut sections: Vec<String> = Vec::new();
    for line in text.lines() {
        if line.starts_with("diff --git ") || sections.is_empty() {
            sections.push(String::new());
        }
        let section = sections.last_mut().unwrap();
        section.push_str(line);
        section.push('\n');
    }
    sections.iter().filter_map(|s| parse_file(s)).collect()
}

fn parse_file(section: &str) -> Option<DiffFile> {
    let first = section.lines().next()?;
    // Fallback paths from `diff --git a/x b/y`, used when there are no ---/+++ lines.
    let (mut old_path, mut new_path) = first
        .strip_prefix("diff --git a/")
        .and_then(|r| r.split_once(" b/"))
        .map(|(a, b)| (a.to_string(), b.to_string()))?;
    let mut status = FileStatus::Modified;
    let mut binary = false;
    for line in section.lines().take_while(|l| !l.starts_with("@@")) {
        if line.starts_with("new file mode") {
            status = FileStatus::Added;
        } else if line.starts_with("deleted file mode") {
            status = FileStatus::Deleted;
        } else if let Some(p) = line.strip_prefix("rename from ") {
            old_path = p.to_string();
            status = FileStatus::Renamed;
        } else if let Some(p) = line.strip_prefix("rename to ") {
            new_path = p.to_string();
        } else if line.starts_with("Binary files ") || line == "GIT binary patch" {
            binary = true;
        } else if let Some(p) = line.strip_prefix("--- ") {
            match strip_side(p, "a/") {
                Some(p) => old_path = p,
                None => status = FileStatus::Added,
            }
        } else if let Some(p) = line.strip_prefix("+++ ") {
            match strip_side(p, "b/") {
                Some(p) => new_path = p,
                None => status = FileStatus::Deleted,
            }
        }
    }
    Some(DiffFile::new(&old_path, &new_path, status, parse_hunks(section), binary))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIFF: &str = "diff --git a/app/models/invoice.rb b/app/models/invoice.rb
index 1111111..2222222 100644
--- a/app/models/invoice.rb
+++ b/app/models/invoice.rb
@@ -1,4 +1,5 @@ class Invoice
 class Invoice < ApplicationRecord
-  belongs_to :patient
+  belongs_to :patient, optional: true
+  has_many :lines

   def total
@@ -20,2 +21,2 @@ def total
-    0
+    lines.sum(:amount)
   end
diff --git a/db/migrate/1_add.rb b/db/migrate/1_add.rb
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/db/migrate/1_add.rb
@@ -0,0 +1,2 @@
+class Add < ActiveRecord::Migration[7.1]
+end
\\ No newline at end of file
diff --git a/logo.png b/logo.png
deleted file mode 100644
Binary files a/logo.png and /dev/null differ
diff --git a/old name.rb b/new name.rb
similarity index 100%
rename from old name.rb
rename to new name.rb
";

    #[test]
    fn parses_files_hunks_and_line_numbers() {
        let files = parse_unified(DIFF);
        assert_eq!(files.len(), 4);

        let invoice = &files[0];
        assert_eq!(invoice.path, "app/models/invoice.rb");
        assert_eq!(invoice.status, FileStatus::Modified);
        assert_eq!((invoice.additions, invoice.deletions), (3, 2));
        assert_eq!(invoice.hunks.len(), 2);
        let first = &invoice.hunks[0].lines;
        assert_eq!(first.len(), 6);
        // The blank context line (trimmed to "") keeps both counters moving.
        assert_eq!((first[4].kind, first[4].old, first[4].new), (LineKind::Ctx, Some(3), Some(4)));
        assert_eq!((first[5].old, first[5].new), (Some(4), Some(5)));
        let second = &invoice.hunks[1].lines;
        assert_eq!((second[1].kind, second[1].new, second[1].text.as_str()), (LineKind::Add, Some(21), "    lines.sum(:amount)"));

        let migration = &files[1];
        assert_eq!(migration.status, FileStatus::Added);
        assert_eq!(migration.additions, 2);

        assert_eq!((files[2].path.as_str(), files[2].status, files[2].binary), ("logo.png", FileStatus::Deleted, true));
        assert_eq!((files[3].old_path.as_str(), files[3].path.as_str()), ("old name.rb", "new name.rb"));
        assert_eq!(files[3].status, FileStatus::Renamed);
    }
}
