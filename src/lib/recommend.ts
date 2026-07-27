import { Conviction, GoldLevels, PriceLevel, Stance, TradeIdea, TradeDirection } from "./types";

// Dylan's rules: minimum 3R, tight (structural) stops.
const MIN_RR = 3;
const STOP_ATR_MULT = 0.15; // tight stop = a small fraction of daily ATR…
const STOP_MIN_PCT = 0.0004; // …with a small floor so it's never zero.

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Choose a take-profit that banks into a real level AND clears MIN_RR: the
 * nearest level in the trade's direction that sits at least MIN_RR × risk away.
 * If no level is far enough, project a measured MIN_RR target.
 */
function pickTarget(
  entry: number,
  dir: TradeDirection,
  candidates: PriceLevel[],
  risk: number
): { price: number; label: string; rr: number } {
  const need = MIN_RR * risk;
  for (const lv of candidates) {
    const dist = Math.abs(lv.price - entry);
    if (dist >= need) return { price: lv.price, label: lv.label, rr: round1(dist / risk) };
  }
  const price = dir === "short" ? entry - need : entry + need;
  return { price: round1(price), label: `${MIN_RR}R`, rr: MIN_RR };
}

/**
 * With-trend, level-triggered trade plans — each ≥3R with a tight structural
 * stop just beyond the trigger level. Deterministic: direction follows the EMA
 * trend, entries sit at pivots, targets bank into the next qualifying level.
 * Plans, not signals — the trader still confirms the ICC continuation.
 */
export function generateRecommendations(l: GoldLevels, newsBias: Stance = "neutral"): TradeIdea[] {
  const price = l.price;
  if (!price || l.levels.length === 0) return [];
  const atr = l.atr14 ?? price * 0.005;
  const buf = Math.max(atr * STOP_ATR_MULT, price * STOP_MIN_PCT); // tight stop distance = risk

  const resAbove = l.levels.filter((x) => x.price > price).sort((a, b) => a.price - b.price);
  const supBelow = l.levels.filter((x) => x.price < price).sort((a, b) => b.price - a.price);
  const below = (from: number) => l.levels.filter((x) => x.price < from).sort((a, b) => b.price - a.price);
  const above = (from: number) => l.levels.filter((x) => x.price > from).sort((a, b) => a.price - b.price);
  const pivot = l.levels.find((x) => x.kind === "pivot");

  const id = (dir: string, tag: string) => `${l.timeframe}:${dir}:${tag}:${l.asOf.slice(0, 13)}`;
  const ideas: TradeIdea[] = [];

  const mk = (
    dir: TradeDirection,
    setupType: TradeIdea["setupType"],
    entryLvl: PriceLevel,
    candidates: PriceLevel[],
    conviction: Conviction,
    rationale: string
  ) => {
    const stop = dir === "short" ? entryLvl.price + buf : entryLvl.price - buf;
    const risk = Math.abs(entryLvl.price - stop);
    const tgt = pickTarget(entryLvl.price, dir, candidates, risk);
    if (tgt.rr < MIN_RR) return; // guard — only ≥3R plans
    ideas.push({
      id: id(dir + "-" + setupType, entryLvl.label),
      direction: dir,
      setupType,
      triggerLabel: entryLvl.label,
      targetLabel: tgt.label,
      entry: entryLvl.price,
      target: tgt.price,
      stop: round1(stop),
      rr: tgt.rr,
      conviction,
      rationale,
    });
  };

  if (l.trend === "bearish" && resAbove.length) {
    const e = resAbove[0];
    mk(
      "short",
      "trend-retest",
      e,
      below(e.price),
      newsBias === "bearish" ? "high" : "medium",
      `Downtrend — sell a retest of ${e.label} on a bearish continuation; tight stop just above, run to the next level.`
    );
    if (supBelow.length) {
      const brk = supBelow[0];
      mk(
        "short",
        "trend-breakout",
        brk,
        below(brk.price),
        "medium",
        `Downtrend — short a clean break-and-continuation below ${brk.label}; tight stop back above it.`
      );
    }
  } else if (l.trend === "bullish" && supBelow.length) {
    const e = supBelow[0];
    mk(
      "long",
      "trend-retest",
      e,
      above(e.price),
      newsBias === "bullish" ? "high" : "medium",
      `Uptrend — buy a retest of ${e.label} on a bullish continuation; tight stop just below, run to the next level.`
    );
    if (resAbove.length) {
      const brk = resAbove[0];
      mk(
        "long",
        "trend-breakout",
        brk,
        above(brk.price),
        "medium",
        `Uptrend — buy a break-and-continuation above ${brk.label}; tight stop back below it.`
      );
    }
  } else if (pivot) {
    // Ranging: low-conviction fades, still held to ≥3R with a tight stop.
    const rr = resAbove[Math.min(1, resAbove.length - 1)];
    if (rr) {
      mk(
        "short",
        "range-fade",
        rr,
        below(rr.price),
        "low",
        `Ranging — fade ${rr.label} lower with a tight stop. Lower conviction: mind your no-chop rule.`
      );
    }
    const sl = supBelow[Math.min(1, supBelow.length - 1)];
    if (sl) {
      mk(
        "long",
        "range-fade",
        sl,
        above(sl.price),
        "low",
        `Ranging — fade ${sl.label} higher with a tight stop. Lower conviction: mind your no-chop rule.`
      );
    }
  }

  return ideas.filter((i) => i.rr >= MIN_RR).slice(0, 3);
}
