export type Stance = "bullish" | "bearish" | "neutral";

export interface FeedSource {
  id: string;
  name: string;
  url: string;
  /** Relevance weight for gold, 0-1. Used to prioritise classification + brief. */
  weight: number;
  kind: "news" | "central-bank" | "gold";
}

export interface NewsItem {
  id: string;
  title: string;
  link: string;
  source: string;
  sourceId: string;
  /** ISO timestamp. */
  publishedAt: string;
  summary?: string;
}

export interface Classification {
  stance: Stance;
  /** 0-1 how confident the model is in the stance. */
  confidence: number;
  /** 0-5 how market-moving this is for gold specifically. */
  impact: number;
  /** One-line explanation of the transmission to the gold price. */
  rationale: string;
}

export interface ClassifiedItem extends NewsItem {
  classification?: Classification;
}

export interface BriefDriver {
  title: string;
  detail: string;
  stance: Stance;
}

export interface Brief {
  generatedAt: string;
  /** Headline verdict, e.g. "Gold leaning bullish into US session". */
  headline: string;
  bias: Stance;
  /** Markdown, a few short paragraphs. */
  summary: string;
  drivers: BriefDriver[];
  /** Things to watch today (events, levels, catalysts). */
  watchlist: string[];
}

export type EventImpact = "high" | "medium" | "low" | "none";

export interface CalendarEvent {
  title: string;
  country: string;
  /** ISO timestamp of the release. */
  date: string;
  impact: EventImpact;
  forecast: string | null;
  previous: string | null;
  /** Present once the number is released. */
  actual: string | null;
}

export interface Quote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePct: number;
  dayHigh: number | null;
  dayLow: number | null;
  currency: string;
}
