import { XMLParser } from "fast-xml-parser";
import { SOURCES } from "./sources";
import { FeedSource, NewsItem } from "./types";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
});

function toArray<T>(x: T | T[] | undefined | null): T[] {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  mdash: "—",
  ndash: "–",
  hellip: "…",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name] ?? m);
}

function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function parseDate(d?: string): string {
  if (!d) return new Date().toISOString();
  const t = Date.parse(d);
  return isNaN(t) ? new Date().toISOString() : new Date(t).toISOString();
}

function textOf(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && "#text" in (v as Record<string, unknown>)) {
    return String((v as Record<string, unknown>)["#text"] ?? "");
  }
  return String(v);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function linkOf(raw: any): string {
  if (!raw) return "";
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const alt = raw.find((l) => l?.["@_rel"] === "alternate") ?? raw[0];
    return alt?.["@_href"] ?? "";
  }
  return raw["@_href"] ?? textOf(raw);
}

function stableId(sourceId: string, link: string, title: string): string {
  return `${sourceId}::${link || title}`;
}

async function fetchOne(src: FeedSource): Promise<NewsItem[]> {
  try {
    const res = await fetch(src.url, {
      headers: { "User-Agent": "Mozilla/5.0 (GoldPulse; news reader)" },
      // Always hit the network; we do our own de-duplication + caching.
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const data = parser.parse(xml);

    const items: NewsItem[] = [];
    const channel = data?.rss?.channel;
    const feed = data?.feed; // Atom

    if (channel) {
      for (const it of toArray<Record<string, unknown>>(channel.item)) {
        const title = stripHtml(textOf(it.title));
        if (!title) continue;
        const link = linkOf(it.link);
        items.push({
          id: stableId(src.id, link, title),
          title,
          link,
          source: src.name,
          sourceId: src.id,
          publishedAt: parseDate(textOf(it.pubDate) || textOf(it["dc:date"])),
          summary: stripHtml(textOf(it.description)).slice(0, 400),
        });
      }
    } else if (feed) {
      for (const it of toArray<Record<string, unknown>>(feed.entry)) {
        const title = stripHtml(textOf(it.title));
        if (!title) continue;
        const link = linkOf(it.link);
        items.push({
          id: stableId(src.id, link, title),
          title,
          link,
          source: src.name,
          sourceId: src.id,
          publishedAt: parseDate(textOf(it.updated) || textOf(it.published)),
          summary: stripHtml(textOf(it.summary) || textOf(it.content)).slice(0, 400),
        });
      }
    }
    return items;
  } catch {
    // A single dead feed must never break the whole request.
    return [];
  }
}

/** Fetch every source in parallel, de-duplicate, and sort newest-first. */
export async function fetchAllNews(limit = 80): Promise<NewsItem[]> {
  const batches = await Promise.all(SOURCES.map(fetchOne));
  const byId = new Map<string, NewsItem>();
  for (const item of batches.flat()) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  return Array.from(byId.values())
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, limit);
}
