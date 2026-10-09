---
name: web-summarizer
description: Summarize web page content from URLs or search keywords. Use when the user asks to summarize, read, extract key points from, or compare web pages; or when the user provides one or more URLs and wants a summary; or when the user asks to search and summarize a topic.
---

# Web Summarizer

Fetch and summarize web content into structured, readable summaries. Supports single URLs, multiple URLs for comparison, and keyword-driven search-then-summarize workflows.

## Input Modes

### Mode 1 — Single URL

User provides one URL to summarize.

### Mode 2 — Multiple URLs

User provides several URLs; produce individual summaries then a comparison or aggregated view.

### Mode 3 — Keyword Search

User provides a topic or keyword; search the web first, then summarize the top results.

## Workflow

### Step 1: Fetch Content

For each URL:

1. **Try `web_fetch` first** — faster, handles most static pages and documents (HTML, PDF, Word, etc.)
2. **Fall back to `browser`** if:
   - `web_fetch` returns empty or very short content (< 200 characters of meaningful text)
   - The page appears to be JS-rendered (e.g., React/Vue SPA with no server-side content)
   - The user mentions the page requires login or interaction

   Browser fallback steps:

   ```
   browser(action="navigate", url="<URL>")
   browser(action="get_text")
   ```

For keyword search (Mode 3):

1. `web_search(query="<keyword>", count=5)`
2. Fetch the top 3–5 result URLs using the process above

### Step 2: Generate Summary

For each fetched page, produce a structured summary:

```
## 网页摘要：[页面标题]
**来源**：[URL]

**关键要点**：
- [核心要点 1]
- [核心要点 2]
- [核心要点 3]
...

**详细摘要**：
[2–4 段连贯的概括，涵盖主要论点、数据、结论]
```

For multiple URLs, add a **综合对比** section at the end:

```
## 综合对比

| 维度 | [来源 1] | [来源 2] | [来源 3] |
|------|----------|----------|----------|
| 核心观点 | ... | ... | ... |
| 数据/结论 | ... | ... | ... |
| 适用场景 | ... | ... | ... |

**综合结论**：[跨来源的整合性结论]
```

### Step 3: Knowledge Base (optional)

If the user explicitly requests saving (e.g., "保存到知识库", "存入知识库", "记录下来"), invoke the **knowledge-wiki** skill to persist the summary as a knowledge page.

## Guidelines

- **Be concise**: Capture the essence, not every detail. Summaries should be scannable.
- **Preserve numbers**: Always include specific data, statistics, or metrics from the source.
- **Note limitations**: If content was truncated, JS-blocked, or paywalled, tell the user clearly.
- **Language**: Respond in the same language the user used to make the request.
- **Length**: Key points should be 3–7 bullets; detailed summary 100–300 words per source.

## Error Handling

| Situation                                       | Response                                                    |
| ----------------------------------------------- | ----------------------------------------------------------- |
| `web_fetch` fails with network error            | Retry once; if still failing, try `browser`                 |
| Browser can't access page (login required)      | Inform the user; ask if they can share the content directly |
| Content is mostly ads/navigation (< 10% useful) | Say so; ask user if they want a different source            |
| PDF or document too large                       | Summarize the first portion; note it was truncated          |
