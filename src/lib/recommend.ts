import { Conviction, GoldLevels, Stance, TradeIdea } from "./types";

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function rrOf(entry: number, target: number, stop: number): number {
  const risk = Math.abs(entry - stop);
  return risk ? Math.abs(target - entry) / risk : 0;
}

/**
 * Generate with-trend, level-triggered trade plans from the computed levels.
 * Deterministic — direction follows the EMA trend (never counter-trend in a
 * clean trend), entries sit at pivot levels, stops are ATR-buffered beyond the
 * trigger, targets are the next level in the trend's direction. In a range we
 * offer lower-conviction fades back to the pivot and flag the no-chop rule.
 *
 * These are plans, not signals: the trader still confirms the ICC continuation.
 */
export function generateRecommendations(l: GoldLevels, newsBias: Stance = "neutral"): TradeIdea[] {
  const price = l.price;
  if (!price || l.levels.length === 0) return [];
  const atr = l.atr14 ?? price * 0.005;
  const buf = Math.max(atr * 0.5, price * 0.0006);

  const resAbove = l.levels.filter((x) => x.price > price).sort((a, b) => a.price - b.price);
  const supBelow = l.levels.filter((x) => x.price < price).sort((a, b) => b.price - a.price);
  const pivot = l.levels.find((x) => x.kind === "pivot");

  const id = (dir: string, tag: string) => `${l.timeframe}:${dir}:${tag}:${l.asOf.slice(0, 13)}`;
  const ideas: TradeIdea[] = [];

  const add = (idea: TradeIdea) => {
    if (idea.rr >= 1 && idea.target !== idea.entry) ideas.push(idea);
  };

  if (l.trend === "bearish" && resAbove.length && supBelow.length) {
    const e = resAbove[0];
    const t = supBelow[0];
    const stop = e.price + buf;
    add({
      id: id("short", e.label),
      direction: "short",
      setupType: "trend-retest",
      triggerLabel: e.label,
      targetLabel: t.label,
      entry: e.price,
      target: t.price,
      stop: round1(stop),
      rr: round1(rrOf(e.price, t.price, stop)),
      conviction: newsBias === "bearish" ? "high" : "medium",
      rationale: `Downtrend — sell a retest of ${e.label} on a bearish continuation, targeting ${t.label}.`,
    });
    if (supBelow.length >= 2) {
      const brk = supBelow[0];
      const t2 = supBelow[1];
      const stop2 = brk.price + buf;
      add({
        id: id("short-brk", brk.label),
        direction: "short",
        setupType: "trend-breakout",
        triggerLabel: brk.label,
        targetLabel: t2.label,
        entry: brk.price,
        target: t2.price,
        stop: round1(stop2),
        rr: round1(rrOf(brk.price, t2.price, stop2)),
        conviction: "medium",
        rationale: `Downtrend — short a clean break-and-continuation below ${brk.label}, targeting ${t2.label}.`,
      });
    }
  } else if (l.trend === "bullish" && resAbove.length && supBelow.length) {
    const e = supBelow[0];
    const t = resAbove[0];
    const stop = e.price - buf;
    add({
      id: id("long", e.label),
      direction: "long",
      setupType: "trend-retest",
      triggerLabel: e.label,
      targetLabel: t.label,
      entry: e.price,
      target: t.price,
      stop: round1(stop),
      rr: round1(rrOf(e.price, t.price, stop)),
      conviction: newsBias === "bullish" ? "high" : "medium",
      rationale: `Uptrend — buy a retest of ${e.label} on a bullish continuation, targeting ${t.label}.`,
    });
    if (resAbove.length >= 2) {
      const brk = resAbove[0];
      const t2 = resAbove[1];
      const stop2 = brk.price - buf;
      add({
        id: id("long-brk", brk.label),
        direction: "long",
        setupType: "trend-breakout",
        triggerLabel: brk.label,
        targetLabel: t2.label,
        entry: brk.price,
        target: t2.price,
        stop: round1(stop2),
        rr: round1(rrOf(brk.price, t2.price, stop2)),
        conviction: "medium",
        rationale: `Uptrend — buy a break-and-continuation above ${brk.label}, targeting ${t2.label}.`,
      });
    }
  } else if (pivot) {
    // Ranging: low-conviction reversion to the pivot from the outer levels.
    const rr = resAbove[Math.min(1, resAbove.length - 1)];
    if (rr) {
      const stop = rr.price + buf;
      add({
        id: id("range-short", rr.label),
        direction: "short",
        setupType: "range-fade",
        triggerLabel: rr.label,
        targetLabel: "Pivot",
        entry: rr.price,
        target: pivot.price,
        stop: round1(stop),
        rr: round1(rrOf(rr.price, pivot.price, stop)),
        conviction: "low",
        rationale: `Ranging — fade ${rr.label} back toward the pivot. Lower conviction: mind your no-chop rule.`,
      });
    }
    const sl = supBelow[Math.min(1, supBelow.length - 1)];
    if (sl) {
      const stop = sl.price - buf;
      add({
        id: id("range-long", sl.label),
        direction: "long",
        setupType: "range-fade",
        triggerLabel: sl.label,
        targetLabel: "Pivot",
        entry: sl.price,
        target: pivot.price,
        stop: round1(stop),
        rr: round1(rrOf(sl.price, pivot.price, stop)),
        conviction: "low",
        rationale: `Ranging — fade ${sl.label} back toward the pivot. Lower conviction: mind your no-chop rule.`,
      });
    }
  }

  return ideas.slice(0, 3);
}
