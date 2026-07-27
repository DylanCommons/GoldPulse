import { FeedSource } from "./types";

/**
 * Free RSS feeds that matter for the gold (XAU/USD) price.
 * All verified reachable without a paid licence. If a feed starts returning
 * 403/404, drop it here — the fetcher is resilient to individual failures.
 *
 * The Federal Reserve feed is the single highest-value free source: rate
 * decisions, minutes and Fed-speaker text move gold more than anything else.
 */
export const SOURCES: FeedSource[] = [
  {
    id: "fed",
    name: "Federal Reserve",
    url: "https://www.federalreserve.gov/feeds/press_all.xml",
    weight: 1.0,
    kind: "central-bank",
  },
  {
    id: "investing-commodities",
    name: "Investing.com · Commodities",
    url: "https://www.investing.com/rss/news_11.rss",
    weight: 0.9,
    kind: "gold",
  },
  {
    id: "yahoo-gold",
    name: "Yahoo Finance · Gold (GC=F)",
    url: "https://feeds.finance.yahoo.com/rss/2.0/headline?s=GC=F&region=US&lang=en-US",
    weight: 0.9,
    kind: "gold",
  },
  {
    id: "investing-news",
    name: "Investing.com · Markets",
    url: "https://www.investing.com/rss/news_1.rss",
    weight: 0.6,
    kind: "news",
  },
  {
    id: "dj-markets",
    name: "Dow Jones · Markets",
    url: "https://feeds.content.dowjones.io/public/rss/RSSMarketsMain",
    weight: 0.7,
    kind: "news",
  },
  {
    id: "mw-top",
    name: "MarketWatch · Top Stories",
    url: "https://feeds.content.dowjones.io/public/rss/mw_topstories",
    weight: 0.6,
    kind: "news",
  },
  {
    id: "mining",
    name: "Mining.com",
    url: "https://www.mining.com/feed/",
    weight: 0.5,
    kind: "gold",
  },
];
