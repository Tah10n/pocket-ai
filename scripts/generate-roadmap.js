#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const ROADMAP_START = "<!-- ROADMAP:START -->";
const ROADMAP_END = "<!-- ROADMAP:END -->";

const BUCKETS = [
  { heading: "Now", label: "roadmap:now" },
  { heading: "Next", label: "roadmap:next" },
  { heading: "Later", label: "roadmap:later" },
];

const getNewline = (text) => (text.includes("\r\n") ? "\r\n" : "\n");

const normalizeIssueTitle = (title) => title.replace(/\s+/g, " ").trim();

const escapeMarkdownLinkText = (text) =>
  text.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");

const parseArgs = () => {
  const args = new Set(process.argv.slice(2));
  return {
    checkOnly: args.has("--check"),
  };
};

const fetchSearchResults = async ({ token, query }) => {
  const url = new URL("https://api.github.com/search/issues");
  url.searchParams.set("q", query);
  url.searchParams.set("sort", "updated");
  url.searchParams.set("order", "desc");
  url.searchParams.set("per_page", "100");

  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "pocket-ai-roadmap-generator",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub API error ${response.status} ${response.statusText}: ${body}`
    );
  }

  const data = await response.json();
  return Array.isArray(data.items) ? data.items : [];
};

const fetchRoadmapBucketItems = async ({ repo, token, label }) => {
  const query = `repo:${repo} is:issue is:open label:"${label}"`;
  const items = await fetchSearchResults({ token, query });

  return items.map((item) => ({
    title: normalizeIssueTitle(item.title || ""),
    url: item.html_url,
    number: item.number,
  }));
};

const renderBucket = ({ heading, items, newline }) => {
  const lines = [`### ${heading}`, ""];

  if (!items.length) {
    lines.push("- _No items_", "");
    return lines.join(newline);
  }

  for (const item of items) {
    const safeTitle = escapeMarkdownLinkText(item.title || "");
    lines.push(`- [${safeTitle}](${item.url}) (#${item.number})`);
  }

  lines.push("");
  return lines.join(newline);
};

const renderRoadmap = ({ buckets, newline }) => {
  return buckets.map((bucket) => renderBucket({ ...bucket, newline })).join(newline);
};

const replaceRoadmapSection = ({ content, newline, replacement }) => {
  const startIndex = content.indexOf(ROADMAP_START);
  const endIndex = content.indexOf(ROADMAP_END);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(
      `Could not find roadmap markers in README (expected ${ROADMAP_START} and ${ROADMAP_END}).`
    );
  }

  const before = content.slice(0, startIndex + ROADMAP_START.length);
  const after = content.slice(endIndex);

  const normalizedReplacement = replacement
    .replace(/\r?\n/g, newline)
    .trimEnd();

  return [before, normalizedReplacement, after].join(newline);
};

const main = async () => {
  const { checkOnly } = parseArgs();

  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error("Missing env var GITHUB_REPOSITORY (expected: owner/repo).");
    process.exit(1);
  }

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    console.error("Missing env var GITHUB_TOKEN (or GH_TOKEN).");
    process.exit(1);
  }

  const readmePath = path.resolve(process.cwd(), "README.md");
  const original = fs.readFileSync(readmePath, "utf8");
  const newline = getNewline(original);

  const bucketResults = await Promise.all(
    BUCKETS.map(async (bucket) => ({
      heading: bucket.heading,
      label: bucket.label,
      items: await fetchRoadmapBucketItems({ repo, token, label: bucket.label }),
    }))
  );

  const generated = renderRoadmap({
    buckets: bucketResults.map((b) => ({ heading: b.heading, items: b.items })),
    newline,
  });

  const updated = replaceRoadmapSection({
    content: original,
    newline,
    replacement: generated,
  });

  if (updated === original) {
    console.log("README Roadmap is already up to date.");
    return;
  }

  if (checkOnly) {
    console.error("README Roadmap is out of date. Run: npm run roadmap:update");
    process.exit(1);
  }

  fs.writeFileSync(readmePath, updated, "utf8");
  console.log("Updated README Roadmap section.");
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
