import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import erb from "highlight.js/lib/languages/erb";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import ruby from "highlight.js/lib/languages/ruby";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

// Syntax colors for the review page's diff (token colors are in index.css under .code).
// Lines are highlighted one at a time, so constructs spanning lines (heredocs, block
// comments) only color their first line; fine for reading a diff.

const LANGUAGES = { bash, css, erb, javascript, json, ruby, scss, sql, typescript, xml, yaml };
for (const [name, lang] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, lang);

const BY_EXTENSION: Record<string, keyof typeof LANGUAGES> = {
  rb: "ruby",
  rake: "ruby",
  gemspec: "ruby",
  ru: "ruby",
  jbuilder: "ruby",
  erb: "erb",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  sql: "sql",
  css: "css",
  scss: "scss",
  html: "xml",
  xml: "xml",
  svg: "xml",
  sh: "bash",
};

const BY_NAME: Record<string, keyof typeof LANGUAGES> = {
  Gemfile: "ruby",
  Rakefile: "ruby",
  Guardfile: "ruby",
  Capfile: "ruby",
};

export function languageFor(path: string): string | null {
  const name = path.split("/").pop() ?? path;
  if (BY_NAME[name]) return BY_NAME[name];
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return BY_EXTENSION[ext] ?? null;
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** HTML for one piece of code (escaped, so safe for dangerouslySetInnerHTML). */
export function highlight(code: string, language: string | null): string {
  if (!language) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}
