use futures::future::join_all;
use serde::Serialize;
use std::time::Duration;

const REQUEST_TIMEOUT_SECS: u64 = 15;
const MAX_ITEMS_PER_SOURCE: usize = 15;
const SUMMARY_MAX_CHARS: usize = 220;

/// (source name, feed URL). Anthropic has no official blog RSS, so Claude news
/// comes from the Claude Code release feed plus Hacker News.
const SOURCES: &[(&str, &str)] = &[
    ("Claude Code", "https://github.com/anthropics/claude-code/releases.atom"),
    ("Hacker News", "https://hnrss.org/newest?q=AI+OR+LLM+OR+Claude+OR+Anthropic&points=50"),
    ("OpenAI", "https://openai.com/news/rss.xml"),
    ("Google DeepMind", "https://deepmind.google/blog/rss.xml"),
    ("Hugging Face", "https://huggingface.co/blog/feed.xml"),
    ("Simon Willison", "https://simonwillison.net/atom/everything/"),
    ("TechCrunch AI", "https://techcrunch.com/category/artificial-intelligence/feed/"),
    ("The Verge AI", "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml"),
];

#[derive(Serialize)]
pub struct NewsItem {
    title: String,
    url: String,
    source: String,
    published: Option<String>,
    summary: Option<String>,
}

#[derive(Serialize)]
pub struct NewsFeed {
    items: Vec<NewsItem>,
    failed_sources: Vec<String>,
}

/// Feed summaries are often HTML; reduce to a short plain-text snippet.
fn to_snippet(html: &str) -> Option<String> {
    let mut text = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                text.push(' ');
            }
            _ if !in_tag => text.push(c),
            _ => {}
        }
    }
    let text = text
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ");
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    if collapsed.chars().count() <= SUMMARY_MAX_CHARS {
        return Some(collapsed);
    }
    let cut: String = collapsed.chars().take(SUMMARY_MAX_CHARS).collect();
    Some(format!("{}…", cut.trim_end()))
}

async fn fetch_source(
    client: &reqwest::Client,
    name: &str,
    url: &str,
) -> Result<Vec<NewsItem>, String> {
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let feed = feed_rs::parser::parse(&bytes[..]).map_err(|e| e.to_string())?;

    Ok(feed
        .entries
        .into_iter()
        .take(MAX_ITEMS_PER_SOURCE)
        .filter_map(|entry| {
            let title = entry.title.map(|t| t.content)?.trim().to_string();
            let url = entry.links.first()?.href.clone();
            let published = entry.published.or(entry.updated).map(|d| d.to_rfc3339());
            let summary = entry
                .summary
                .map(|s| s.content)
                .or_else(|| entry.content.and_then(|c| c.body))
                .and_then(|s| to_snippet(&s));
            Some(NewsItem {
                title,
                url,
                source: name.to_string(),
                published,
                summary,
            })
        })
        .collect())
}

#[tauri::command]
pub async fn fetch_ai_news() -> Result<NewsFeed, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .user_agent("flight-deck/0.1")
        .build()
        .map_err(|e| e.to_string())?;

    let results = join_all(
        SOURCES
            .iter()
            .map(|(name, url)| fetch_source(&client, name, url)),
    )
    .await;

    let mut items = Vec::new();
    let mut failed_sources = Vec::new();
    for ((name, _), result) in SOURCES.iter().zip(results) {
        match result {
            Ok(mut v) => items.append(&mut v),
            Err(_) => failed_sources.push(name.to_string()),
        }
    }

    Ok(NewsFeed {
        items: most_relevant(items),
        failed_sources,
    })
}

const TOP_N: usize = 30;
const MAX_PER_SOURCE: usize = 5;
const PRIMARY_KEYWORDS: &[&str] = &["claude", "anthropic"];
const SECONDARY_KEYWORDS: &[&str] = &[
    "llm", "gpt", "gemini", "openai", "model", "agent", "reasoning", "benchmark", "open-source",
];

/// Relevance = recency (halves every day) plus a boost for Claude/Anthropic and
/// other core-AI keywords in the title. At most `MAX_PER_SOURCE` per source so
/// one busy feed can't crowd out the rest.
fn relevance(item: &NewsItem, now: chrono::DateTime<chrono::Utc>) -> f64 {
    let recency = item
        .published
        .as_deref()
        .and_then(|p| chrono::DateTime::parse_from_rfc3339(p).ok())
        .map(|d| {
            let age_hours = (now - d.with_timezone(&chrono::Utc)).num_minutes().max(0) as f64 / 60.0;
            1.0 / (1.0 + age_hours / 24.0)
        })
        .unwrap_or(0.0);

    let title = item.title.to_lowercase();
    let boost = if PRIMARY_KEYWORDS.iter().any(|k| title.contains(k)) {
        1.0
    } else if SECONDARY_KEYWORDS.iter().any(|k| title.contains(k)) {
        0.3
    } else {
        0.0
    };
    recency + boost
}

fn most_relevant(items: Vec<NewsItem>) -> Vec<NewsItem> {
    let now = chrono::Utc::now();
    let mut scored: Vec<(f64, NewsItem)> = items.into_iter().map(|i| (relevance(&i, now), i)).collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut per_source: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    scored
        .into_iter()
        .filter(|(_, item)| {
            let count = per_source.entry(item.source.clone()).or_insert(0);
            *count += 1;
            *count <= MAX_PER_SOURCE
        })
        .take(TOP_N)
        .map(|(_, item)| item)
        .collect()
}
