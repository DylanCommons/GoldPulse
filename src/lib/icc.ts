import { fetchGoldLevels } from "./levels";
import { IccState, TradeIdea, Trend } from "./types";

interface Candle {
  t: number;
  high: number;
  low: number;
  close: number;
}
interface Swing {
  i: number;
  price: number;
  type: "H" | "L";
  t: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function num(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

const MIN_RR = 3;

async function fetch15m(): Promise<Candle[] | null> {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=15m&range=5d";
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (GoldPulse; icc)" },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const r = data?.chart?.result?.[0];
    const q = r?.indicators?.quote?.[0];
    const ts: number[] = r?.timestamp ?? [];
    if (!q || ts.length < 20) return null;
    const c: Candle[] = [];
    for (let i = 0; i < ts.length; i++) {
      const high = num(q.high?.[i]);
      const low = num(q.low?.[i]);
      const close = num(q.close?.[i]);
      if (high == null || low == null || close == null) continue;
      c.push({ t: ts[i] * 1000, high, low, close });
    }
    return c.length >= 20 ? c : null;
  } catch {
    return null;
  }
}

function atr15(c: Candle[], period = 14): number | null {
  if (c.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < c.length; i++) {
    trs.push(Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close)));
  }
  const last = trs.slice(-period);
  return last.reduce((a, b) => a + b, 0) / period;
}

// Fractal swing detection: a swing high/low is an extreme over ±k bars.
// Consecutive same-type swings are collapsed to the most extreme, leaving a
// clean alternating H/L sequence (market structure).
function detectSwings(c: Candle[], k = 2): Swing[] {
  const raw: Swing[] = [];
  for (let i = k; i < c.length - k; i++) {
    let hi = true;
    let lo = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (c[j].high >= c[i].high) hi = false;
      if (c[j].low <= c[i].low) lo = false;
    }
    if (hi) raw.push({ i, price: c[i].high, type: "H", t: c[i].t });
    if (lo) raw.push({ i, price: c[i].low, type: "L", t: c[i].t });
  }
  raw.sort((a, b) => a.i - b.i || (a.type === "H" ? -1 : 1));
  const out: Swing[] = [];
  for (const s of raw) {
    const last = out[out.length - 1];
    if (!last || last.type !== s.type) out.push(s);
    else if (s.type === "H" ? s.price > last.price : s.price < last.price) out[out.length - 1] = s;
  }
  return out;
}

/**
 * Build ICC continuation setups (Indication → Correction → Continuation) from
 * 15m structure, with the higher-timeframe trend. Entry is the break of the
 * last swing low (sell) / swing high (buy); stop sits beyond the correction's
 * extreme; target is a prior swing low/high (real demand/supply) clearing 3R.
 */
function buildIccSetups(sw: Swing[], trend: string, price: number, atr: number): TradeIdea[] {
  if (sw.length < 4 || !price) return [];
  const buf = Math.max(atr * 0.1, price * 0.0003);
  const ideas: TradeIdea[] = [];

  if (trend === "bearish") {
    // correction high = most recent swing high; entry trigger = the swing low before it.
    let hiIdx = -1;
    for (let i = sw.length - 1; i >= 0; i--) if (sw[i].type === "H") { hiIdx = i; break; }
    if (hiIdx > 0) {
      let loIdx = -1;
      for (let i = hiIdx - 1; i >= 0; i--) if (sw[i].type === "L") { loIdx = i; break; }
      if (loIdx >= 0) {
        const corrHigh = sw[hiIdx];
        const trig = sw[loIdx];
        const stop = corrHigh.price + buf;
        const risk = stop - trig.price;
        // Valid pending continuation: price sits in the correction, not yet triggered/invalidated.
        if (risk > 0 && price > trig.price && price < stop) {
          const need = MIN_RR * risk;
          const lows = sw.filter((s) => s.type === "L" && s.price < trig.price).sort((a, b) => b.price - a.price);
          let target: number | null = null;
          let tlabel = "";
          for (const lo of lows) if (trig.price - lo.price >= need) { target = lo.price; tlabel = "prior demand"; break; }
          if (target == null) { target = trig.price - need; tlabel = `${MIN_RR}R`; }
          const rr = round1((trig.price - target) / risk);
          if (rr >= MIN_RR) {
            ideas.push({
              id: `icc:short:${trig.i}`,
              direction: "short",
              setupType: "trend-retest",
              triggerLabel: "continuation",
              targetLabel: tlabel,
              entry: round1(trig.price),
              target: round1(target),
              stop: round1(stop),
              rr,
              conviction: "medium",
              rationale: `ICC sell — downtrend, price corrected up to ${round1(corrHigh.price)}. Short the break below the last swing low ${round1(trig.price)}; stop above the correction high ${round1(corrHigh.price)}; target prior demand at ${round1(target)}.`,
            });
          }
        }
      }
    }
  } else if (trend === "bullish") {
    let loIdx = -1;
    for (let i = sw.length - 1; i >= 0; i--) if (sw[i].type === "L") { loIdx = i; break; }
    if (loIdx > 0) {
      let hiIdx = -1;
      for (let i = loIdx - 1; i >= 0; i--) if (sw[i].type === "H") { hiIdx = i; break; }
      if (hiIdx >= 0) {
        const corrLow = sw[loIdx];
        const trig = sw[hiIdx];
        const stop = corrLow.price - buf;
        const risk = trig.price - stop;
        if (risk > 0 && price < trig.price && price > stop) {
          const need = MIN_RR * risk;
          const highs = sw.filter((s) => s.type === "H" && s.price > trig.price).sort((a, b) => a.price - b.price);
          let target: number | null = null;
          let tlabel = "";
          for (const h of highs) if (h.price - trig.price >= need) { target = h.price; tlabel = "prior supply"; break; }
          if (target == null) { target = trig.price + need; tlabel = `${MIN_RR}R`; }
          const rr = round1((target - trig.price) / risk);
          if (rr >= MIN_RR) {
            ideas.push({
              id: `icc:long:${trig.i}`,
              direction: "long",
              setupType: "trend-retest",
              triggerLabel: "continuation",
              targetLabel: tlabel,
              entry: round1(trig.price),
              target: round1(target),
              stop: round1(stop),
              rr,
              conviction: "medium",
              rationale: `ICC buy — uptrend, price corrected down to ${round1(corrLow.price)}. Long the break above the last swing high ${round1(trig.price)}; stop below the correction low ${round1(corrLow.price)}; target prior supply at ${round1(target)}.`,
            });
          }
        }
      }
    }
  }
  return ideas.slice(0, 2);
}

/**
 * Classify where price sits in the ICC sequence, so we can alert the trader as
 * it develops: indication (fresh impulse extreme) → correction (pullback formed)
 * → setup (continuation armed). Signature changes on each transition for dedup.
 */
function computeIccState(sw: Swing[], trend: Trend, price: number, setups: TradeIdea[]): IccState {
  if (trend !== "bearish" && trend !== "bullish") {
    return {
      phase: "none",
      trend,
      signature: "none",
      note: "No clear daily trend — ICC needs a with-trend read. Stand aside.",
    };
  }
  if (setups.length > 0) {
    const s = setups[0];
    return {
      phase: "setup",
      trend,
      direction: s.direction,
      signature: `set:${trend}:${s.entry}:${s.stop}`,
      note: `Setup armed — ${s.direction} on the break of ${s.entry} → target ${s.target} (${s.rr}R). Confirm the continuation.`,
      trigger: s.entry,
      correctionExtreme: s.stop,
      target: s.target,
    };
  }
  const Ls = sw.filter((s) => s.type === "L");
  const Hs = sw.filter((s) => s.type === "H");

  if (trend === "bearish") {
    const lastL = Ls[Ls.length - 1];
    const prevL = Ls[Ls.length - 2];
    const lastH = Hs[Hs.length - 1];
    const freshLL = lastL && prevL && lastL.price < prevL.price;
    if (freshLL && lastH && lastH.i > lastL.i) {
      return {
        phase: "correction",
        trend,
        direction: "short",
        signature: `cor:bear:${lastH.i}`,
        note: `Correction underway — price pulled up to ${round1(lastH.price)} after a lower low. Watch for the continuation setup.`,
        correctionExtreme: round1(lastH.price),
      };
    }
    if (freshLL) {
      return {
        phase: "indication",
        trend,
        direction: "short",
        signature: `ind:bear:${lastL.i}`,
        note: `Indication — new lower low at ${round1(lastL.price)}. Impulse down; watch for a correction to short into.`,
      };
    }
    return { phase: "none", trend, signature: `none:bear:${lastL ? lastL.i : 0}`, note: "Downtrend, but no fresh ICC sequence yet." };
  }

  const lastH = Hs[Hs.length - 1];
  const prevH = Hs[Hs.length - 2];
  const lastL = Ls[Ls.length - 1];
  const freshHH = lastH && prevH && lastH.price > prevH.price;
  if (freshHH && lastL && lastL.i > lastH.i) {
    return {
      phase: "correction",
      trend,
      direction: "long",
      signature: `cor:bull:${lastL.i}`,
      note: `Correction underway — price pulled down to ${round1(lastL.price)} after a higher high. Watch for the continuation setup.`,
      correctionExtreme: round1(lastL.price),
    };
  }
  if (freshHH) {
    return {
      phase: "indication",
      trend,
      direction: "long",
      signature: `ind:bull:${lastH.i}`,
      note: `Indication — new higher high at ${round1(lastH.price)}. Impulse up; watch for a correction to long into.`,
    };
  }
  return { phase: "none", trend, signature: `none:bull:${lastH ? lastH.i : 0}`, note: "Uptrend, but no fresh ICC sequence yet." };
}

export async function fetchIccSetups(): Promise<{ setups: TradeIdea[]; state: IccState }> {
  const [levels, c15] = await Promise.all([fetchGoldLevels("daily"), fetch15m()]);
  if (!levels || !c15) {
    return { setups: [], state: { phase: "none", trend: "mixed", signature: "none", note: "Structure data unavailable." } };
  }
  const atr = atr15(c15) ?? levels.price * 0.002;
  const sw = detectSwings(c15, 2);
  const setups = buildIccSetups(sw, levels.trend, levels.price, atr);
  const state = computeIccState(sw, levels.trend, levels.price, setups);
  return { setups, state };
}
