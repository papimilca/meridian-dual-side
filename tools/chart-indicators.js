import { config } from "../config.js";
import { log } from "../logger.js";
import { agentMeridianJson, getAgentMeridianHeaders } from "./agent-meridian.js";
import { safeNumber } from "../utils/number.js";

const DEFAULT_INTERVALS = ["5_MINUTE"];
const DEFAULT_CANDLES = 298;

// Local indicator computation (1_MINUTE) uses these defaults
const LOCAL_BOLLINGER_PERIOD = 20;
const LOCAL_BOLLINGER_MULTIPLIER = 2;
const LOCAL_SUPERTREND_PERIOD = 10;
const LOCAL_SUPERTREND_MULTIPLIER = 3;
const LOCAL_FIB_LOOKBACK = 100;
const GECKO_TERMINAL_BASE = "https://api.geckoterminal.com/api/v2";
const BIRDEYE_API_BASE = "https://public-api.birdeye.so";

const INTERVAL_MS = {
  "1_MINUTE": 60 * 1000,
  "5_MINUTE": 5 * 60 * 1000,
  "15_MINUTE": 15 * 60 * 1000,
};

function normalizeIntervals(intervals) {
  const list = Array.isArray(intervals) ? intervals : DEFAULT_INTERVALS;
  return list
    .map((value) => String(value || "").trim().toUpperCase())
    .filter((value) => ["1_MINUTE", "5_MINUTE", "15_MINUTE"].includes(value));
}

function safeNum(value) {
  return safeNumber(value, null);
}

function extractCandleTime(candle) {
  if (!candle || typeof candle !== "object") return null;
  for (const key of ["timestamp", "time", "startTime", "openTime", "start", "closeTime"]) {
    const value = Number(candle[key]);
    if (Number.isFinite(value) && value > 0) {
      // Support seconds or milliseconds timestamps
      return value < 1e12 ? value * 1000 : value;
    }
  }
  return null;
}

function indicatorHistory(payload) {
  if (Array.isArray(payload?.candles)) return payload.candles;
  if (Array.isArray(payload?.history)) return payload.history;
  return null;
}

/**
 * Validate that the indicator payload is actually usable before trusting it:
 * - latest candle exists with a valid close
 * - RSI / Bollinger / Supertrend are formed (not null)
 * - enough candle history for the indicators to be meaningful
 * - latest candle is not stale
 * Returns an array of issues (empty = ready).
 */
function validateIndicatorReadiness(payload, interval) {
  const issues = [];
  const latest = payload?.latest || {};
  const candle = latest?.candle || {};

  const close = safeNum(candle.close);
  if (close == null || close <= 0) issues.push("latest candle has no valid close price");
  if (safeNum(latest?.rsi?.value) == null) issues.push("RSI not formed yet");

  const bollinger = latest?.bollinger || {};
  if (
    safeNum(bollinger.lower) == null ||
    safeNum(bollinger.middle) == null ||
    safeNum(bollinger.upper) == null
  ) {
    issues.push("Bollinger bands not formed yet");
  }
  if (safeNum(latest?.supertrend?.value) == null) issues.push("Supertrend not formed yet");

  const history = indicatorHistory(payload);
  const minCandles = Number(config.indicators.minCandles ?? 50);
  if (history != null && minCandles > 0 && history.length < minCandles) {
    issues.push(`insufficient candle history (${history.length}/${minCandles} candles)`);
  }

  const candleTime = extractCandleTime(candle);
  if (candleTime != null) {
    const intervalMs = INTERVAL_MS[interval] ?? INTERVAL_MS["5_MINUTE"];
    const maxAgeIntervals = Number(config.indicators.maxCandleAgeIntervals ?? 3);
    const ageMs = Date.now() - candleTime;
    if (maxAgeIntervals > 0 && ageMs > intervalMs * maxAgeIntervals) {
      issues.push(
        `latest candle is stale (${Math.round(ageMs / 60000)}m old, limit ${Math.round((intervalMs * maxAgeIntervals) / 60000)}m)`,
      );
    }
  }

  return issues;
}

/**
 * Entry-side safety guard against deploying into a vertical pump / ATH spike.
 * Blocks entry when close is far above the upper Bollinger band or RSI is
 * extremely overbought, regardless of the entry preset result.
 */
function entrySafetyRejection(summary) {
  const maxSpikePct = Number(config.indicators.maxSpikePct ?? 20);
  const maxEntryRsi = Number(config.indicators.maxEntryRsi ?? 95);
  const { close, upperBand, rsi } = summary || {};

  if (maxSpikePct > 0 && close != null && upperBand != null && upperBand > 0) {
    const spikePct = (close / upperBand - 1) * 100;
    if (spikePct > maxSpikePct) {
      return `price spike guard: close is ${spikePct.toFixed(1)}% above the upper Bollinger band (limit ${maxSpikePct}%) — refusing entry into an overextended/ATH move`;
    }
  }
  if (maxEntryRsi > 0 && rsi != null && rsi >= maxEntryRsi) {
    return `RSI guard: RSI ${rsi} >= ${maxEntryRsi} — refusing entry into an overextended/ATH move`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Local indicator computation for 1_MINUTE (Agent Meridian API only serves
// 5_MINUTE / 15_MINUTE). Candles come from the public GeckoTerminal OHLCV
// endpoint and indicators are computed locally, producing a payload shaped
// exactly like the API response so validation/presets work unchanged.
// ---------------------------------------------------------------------------

async function resolvePoolAddressByMint(mint) {
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(mint)}&sort_by=${encodeURIComponent("tvl:desc")}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`pool lookup failed (${res.status})`);
  const payload = await res.json();
  const pools = Array.isArray(payload) ? payload : payload?.data || [];
  // Verify the resolved pool actually matches the requested base mint
  const match = pools.find((p) => p?.token_x?.address === mint || p?.mint_x === mint);
  const addr = match?.address || match?.pool_address;
  if (!addr) throw new Error("no pool found for mint");
  return addr;
}

async function fetchOneMinuteCandles(poolAddress, limit) {
  const capped = Math.min(Math.max(Number(limit) || DEFAULT_CANDLES, 10), 1000);
  const url = `${GECKO_TERMINAL_BASE}/networks/solana/pools/${poolAddress}/ohlcv/minute?aggregate=1&currency=token&limit=${capped}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`GeckoTerminal OHLCV failed (${res.status})`);
  const payload = await res.json();
  const list = payload?.data?.attributes?.ohlcv_list || [];
  // ohlcv_list is newest-first; normalize to oldest-first candle objects
  return list
    .map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }))
    .filter((c) => Number.isFinite(Number(c.close)) && Number(c.close) > 0)
    .reverse();
}

/**
 * Birdeye OHLCV fallback (token mint, 1m, USD-denominated). Used when the
 * public GeckoTerminal endpoint is rate-limited (429) or unavailable so that
 * strictMode does not block entries on a transient upstream failure.
 */
async function fetchBirdeyeOneMinuteCandles(mint, limit) {
  const apiKey = config.indicators.birdeyeApiKey;
  if (!apiKey) throw new Error("Birdeye fallback not configured (indicators.birdeyeApiKey missing)");
  if (!mint) throw new Error("Birdeye fallback needs a mint address");
  const capped = Math.min(Math.max(Number(limit) || DEFAULT_CANDLES, 10), 1000);
  const timeTo = Math.floor(Date.now() / 1000);
  const timeFrom = timeTo - capped * 60;
  const url = `${BIRDEYE_API_BASE}/defi/ohlcv?address=${mint}&type=1m&time_from=${timeFrom}&time_to=${timeTo}`;
  const res = await fetch(url, { headers: { "X-API-KEY": apiKey, "x-chain": "solana", Accept: "application/json" } });
  if (!res.ok) throw new Error(`Birdeye OHLCV failed (${res.status})`);
  const items = (await res.json())?.data?.items || [];
  // Birdeye returns oldest-first; v is USD volume. Same candle shape as GeckoTerminal.
  return items
    .map((c) => ({ time: c.unixTime, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v }))
    .filter((c) => Number.isFinite(Number(c.close)) && Number(c.close) > 0);
}

/** GeckoTerminal candles with Birdeye fallback; both failing throws a combined error. */
async function fetchOneMinuteCandlesWithFallback(mint, poolAddress, limit) {
  try {
    return await fetchOneMinuteCandles(poolAddress, limit);
  } catch (error) {
    try {
      const candles = await fetchBirdeyeOneMinuteCandles(mint, limit);
      log("indicators_warn", `GeckoTerminal OHLCV failed (${error.message}) — using Birdeye fallback (${candles.length} candles)`);
      return candles;
    } catch (fallbackError) {
      throw new Error(`${error.message}; Birdeye fallback failed: ${fallbackError.message}`);
    }
  }
}

function computeRsiSeries(closes, length) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length <= length || length < 1) return rsi;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= length; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) gain += delta;
    else loss -= delta;
  }
  gain /= length;
  loss /= length;
  rsi[length] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = length + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    gain = (gain * (length - 1) + Math.max(delta, 0)) / length;
    loss = (loss * (length - 1) + Math.max(-delta, 0)) / length;
    rsi[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return rsi;
}

function computeBollingerAt(candles, index, period = LOCAL_BOLLINGER_PERIOD, multiplier = LOCAL_BOLLINGER_MULTIPLIER) {
  if (index < period - 1) return null;
  const closes = candles.slice(index - period + 1, index + 1).map((c) => Number(c.close));
  const mean = closes.reduce((a, b) => a + b, 0) / period;
  const variance = closes.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { lower: mean - multiplier * sd, middle: mean, upper: mean + multiplier * sd };
}

function computeSupertrendSeries(candles, period = LOCAL_SUPERTREND_PERIOD, multiplier = LOCAL_SUPERTREND_MULTIPLIER) {
  const n = candles.length;
  const result = new Array(n).fill(null);
  if (n < period + 1) return result;

  const atr = new Array(n).fill(null);
  let atrValue = null;
  let prevClose = Number(candles[0].close);
  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const high = Number(c.high);
    const low = Number(c.low);
    const close = Number(c.close);
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    atrValue = atrValue == null ? tr : (atrValue * (period - 1) + tr) / period;
    atr[i] = atrValue;
    prevClose = close;
  }

  let finalUpper = null;
  let finalLower = null;
  let direction = 1;
  for (let i = 0; i < n; i++) {
    if (atr[i] == null) continue;
    const high = Number(candles[i].high);
    const low = Number(candles[i].low);
    const close = Number(candles[i].close);
    const mid = (high + low) / 2;
    const basicUpper = mid + multiplier * atr[i];
    const basicLower = mid - multiplier * atr[i];

    if (finalUpper == null || finalLower == null) {
      finalUpper = basicUpper;
      finalLower = basicLower;
    } else {
      const prevCloseValue = Number(candles[i - 1].close);
      finalUpper = prevCloseValue > finalUpper ? basicUpper : Math.min(basicUpper, finalUpper);
      finalLower = prevCloseValue < finalLower ? basicLower : Math.max(basicLower, finalLower);
    }

    if (close > finalUpper) direction = 1;
    else if (close < finalLower) direction = -1;

    result[i] = {
      value: direction === 1 ? finalLower : finalUpper,
      direction: direction === 1 ? "bullish" : "bearish",
    };
  }
  return result;
}

function computeFibonacciLevels(candles, lookback = LOCAL_FIB_LOOKBACK) {
  const slice = candles.slice(-lookback);
  if (slice.length < 2) return {};
  const high = Math.max(...slice.map((c) => Number(c.high)));
  const low = Math.min(...slice.map((c) => Number(c.low)));
  const range = high - low;
  if (!(range > 0)) return {};
  // Retracement levels measured down from the swing high (standard dip-reclaim view)
  return {
    "0.500": high - 0.5 * range,
    "0.618": high - 0.618 * range,
    "0.786": high - 0.786 * range,
  };
}

function buildLocalIndicatorPayload(candles, rsiLength) {
  const n = candles.length;
  const last = n - 1;
  if (n < 2) return { candles, latest: {} };

  const rsiSeries = computeRsiSeries(candles.map((c) => Number(c.close)), rsiLength);
  const stSeries = computeSupertrendSeries(candles);
  const rsi = rsiSeries[last];
  const st = stSeries[last];
  const prevSt = stSeries[last - 1];
  const bollinger = computeBollingerAt(candles, last) || {};

  return {
    candles,
    latest: {
      candle: candles[last],
      previousCandle: candles[last - 1] || {},
      rsi: rsi == null ? {} : { value: rsi },
      bollinger,
      supertrend: st ? { value: st.value, direction: st.direction } : {},
      states: {
        supertrendBreakUp: !!(st && prevSt && st.direction === "bullish" && prevSt.direction !== "bullish"),
        supertrendBreakDown: !!(st && prevSt && st.direction === "bearish" && prevSt.direction !== "bearish"),
      },
      fibonacci: { levels: computeFibonacciLevels(candles) },
    },
  };
}

async function fetchLocalOneMinutePayload(mint, poolAddress) {
  let resolvedPool = poolAddress || null;
  if (!resolvedPool) resolvedPool = await resolvePoolAddressByMint(mint);
  const candles = await fetchOneMinuteCandlesWithFallback(
    mint,
    resolvedPool,
    config.indicators.candles ?? DEFAULT_CANDLES,
  );
  return buildLocalIndicatorPayload(candles, config.indicators.rsiLength ?? 2);
}

/**
 * Hard gate on 1-minute USD volume (mirrors the GMGN "vol 1m" reference).
 * Requires BOTH the last completed minute AND the average of the last 3
 * completed minutes to be >= config.indicators.minVolume1mUsd.
 *
 * Scope (config.indicators.volume1mScope):
 * - "token" (default): GMGN-style token-wide volume — sums 1m candle volume
 *   across ALL pools of the token (capped at the 5 highest-volume pools).
 *   This matters because a token's activity often concentrates on one
 *   market (e.g. a Raydium pool) while the Meteora DLMM pool stays quiet.
 * - "pool": only the deploy pool's own 1m volume (strictest for fee capture,
 *   but much lower numbers than GMGN shows).
 *
 * Data comes from GeckoTerminal with currency=usd, so the volume field is
 * already USD-denominated. Minutes without trades count as $0 (GMGN-faithful:
 * a quiet minute is low volume, not a skipped minute).
 */
export async function checkOneMinuteVolume({ mint, poolAddress, scope } = {}) {
  const minVolume1mUsd = Number(config.indicators.minVolume1mUsd ?? 0);
  if (!(minVolume1mUsd > 0)) {
    return { enabled: false, ok: true, reason: "1m volume gate disabled" };
  }

  const effectiveScope = String(scope || config.indicators.volume1mScope || "token").toLowerCase();

  if (effectiveScope === "token") {
    if (!mint) {
      return { enabled: true, ok: false, reason: "token-scope 1m volume check needs a mint address" };
    }
    let volumesByMinute = null;
    try {
      const pools = await fetchGtPoolsForMint(mint);
      const top = pools.sort((a, b) => b.volumeH24Usd - a.volumeH24Usd).slice(0, 5);
      if (top.length === 0) {
        return {
          enabled: true,
          ok: false,
          scope: "token",
          lastVolumeUsd: 0,
          avg3VolumeUsd: 0,
          minVolume1mUsd,
          reason: "no pools found for this token — cannot verify 1m volume",
        };
      }
      const results = await Promise.allSettled(top.map((p) => fetchOneMinuteVolumeRows(p.address, 5)));
      volumesByMinute = new Map();
      for (const entry of results) {
        if (entry.status !== "fulfilled") continue;
        for (const [timeSec, volumeUsd] of entry.value) {
          if (!Number.isFinite(volumeUsd) || volumeUsd < 0) continue;
          volumesByMinute.set(timeSec, (volumesByMinute.get(timeSec) || 0) + volumeUsd);
        }
      }
      // All pool fetches failed (e.g. GeckoTerminal 429) — fall back to Birdeye.
      if (results.every((entry) => entry.status === "rejected")) {
        volumesByMinute = null;
      } else {
        return evaluateOneMinuteVolumeGate(volumesByMinute, minVolume1mUsd, "token", top.length);
      }
    } catch (error) {
      log("indicators_warn", `GeckoTerminal token pools lookup failed (${error.message}) — trying Birdeye fallback`);
    }
    // Birdeye is token-level, so its 1m USD volume already covers all markets.
    const candles = await fetchBirdeyeOneMinuteCandles(mint, 5);
    volumesByMinute = new Map(
      candles
        .map((c) => [Number(c.time), Number(c.volume)])
        .filter(([time, volume]) => Number.isFinite(time) && Number.isFinite(volume) && volume >= 0),
    );
    return evaluateOneMinuteVolumeGate(volumesByMinute, minVolume1mUsd, "token", 1);
  }

  // Pool scope: only the deploy pool's own candles
  let resolvedPool = poolAddress || null;
  if (!resolvedPool) {
    if (!mint) {
      return { enabled: true, ok: false, reason: "no mint or pool address to check 1m volume" };
    }
    resolvedPool = await resolvePoolAddressByMint(mint);
  }
  let rows;
  try {
    rows = await fetchOneMinuteVolumeRows(resolvedPool, 5);
  } catch (error) {
    log("indicators_warn", `GeckoTerminal OHLCV failed (${error.message}) — using Birdeye fallback for 1m volume`);
    const candles = await fetchBirdeyeOneMinuteCandles(mint, 5);
    rows = candles.map((c) => [Number(c.time), Number(c.volume)]);
  }
  const volumesByMinute = new Map(rows.map(([timeSec, volumeUsd]) => [timeSec, volumeUsd]));
  return evaluateOneMinuteVolumeGate(volumesByMinute, minVolume1mUsd, "pool", 1);
}

/**
 * Fetch recent 1-minute candles from GeckoTerminal (currency=usd → volume is
 * already USD). Returns newest-first rows of [timestampSec, volumeUsd],
 * including the in-progress candle.
 */
async function fetchOneMinuteVolumeRows(poolAddress, limit = 5) {
  const url = `${GECKO_TERMINAL_BASE}/networks/solana/pools/${poolAddress}/ohlcv/minute?aggregate=1&currency=usd&limit=${limit}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`GeckoTerminal OHLCV failed (${res.status})`);
  const list = (await res.json())?.data?.attributes?.ohlcv_list || [];
  // ohlcv_list is newest-first: [time, open, high, low, close, volume]
  return list
    .map(([time, , , , , volume]) => [Number(time), Number(volume)])
    .filter(([time, volume]) => Number.isFinite(time) && Number.isFinite(volume));
}

/**
 * All GeckoTerminal pools for a token mint, with their 24h USD volume
 * (used to pick the highest-volume markets for the token-wide 1m check).
 */
async function fetchGtPoolsForMint(mint) {
  const url = `${GECKO_TERMINAL_BASE}/networks/solana/tokens/${mint}/pools`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`GeckoTerminal token pools lookup failed (${res.status})`);
  const data = (await res.json())?.data || [];
  return data
    .map((p) => {
      const a = p?.attributes || {};
      return { address: a.address, name: a.name, volumeH24Usd: Number(a.volume_usd?.h24) || 0 };
    })
    .filter((p) => p.address);
}

/**
 * Shared gate evaluation over per-minute USD volume totals.
 * The last 3 completed minute slots are used (the in-progress minute is
 * excluded so a deploy early in a minute is not judged on partial data).
 * Minutes with no trades count as $0.
 */
function evaluateOneMinuteVolumeGate(volumesByMinute, minVolume1mUsd, scope, poolsChecked) {
  const nowSec = Date.now() / 1000;
  const currentMinuteStart = Math.floor(nowSec / 60) * 60;
  const slots = [currentMinuteStart - 60, currentMinuteStart - 120, currentMinuteStart - 180];
  const slotVolumes = slots.map((slot) => volumesByMinute.get(slot) || 0);
  const lastVolumeUsd = slotVolumes[0];
  const avg3VolumeUsd = (slotVolumes[0] + slotVolumes[1] + slotVolumes[2]) / 3;
  const ok = lastVolumeUsd >= minVolume1mUsd && avg3VolumeUsd >= minVolume1mUsd;

  const newestCandleSec = volumesByMinute.size > 0 ? Math.max(...volumesByMinute.keys()) : null;
  let reason;
  if (ok) {
    reason = `1m volume OK (${scope}): last $${Math.round(lastVolumeUsd).toLocaleString("en-US")}, avg3 $${Math.round(avg3VolumeUsd).toLocaleString("en-US")} >= $${minVolume1mUsd.toLocaleString("en-US")}`;
  } else if (newestCandleSec != null && nowSec - newestCandleSec > 180 && lastVolumeUsd === 0) {
    reason = `no trades in the last ${Math.round((nowSec - newestCandleSec) / 60)} minutes (${scope}) — too quiet for fast in/out (needs >= $${minVolume1mUsd.toLocaleString("en-US")}/min)`;
  } else {
    reason = `1m volume too low (${scope}): last $${Math.round(lastVolumeUsd).toLocaleString("en-US")}, avg3 $${Math.round(avg3VolumeUsd).toLocaleString("en-US")} — both must be >= $${minVolume1mUsd.toLocaleString("en-US")} (token is too illiquid for fast in/out)`;
  }

  return {
    enabled: true,
    ok,
    scope,
    poolsChecked,
    lastVolumeUsd,
    avg3VolumeUsd,
    minVolume1mUsd,
    reason,
  };
}

function buildSignalSummary(payload) {
  const latest = payload?.latest || {};
  const candle = latest?.candle || {};
  const previousCandle = latest?.previousCandle || {};
  const rsi = safeNum(latest?.rsi?.value);
  const bollinger = latest?.bollinger || {};
  const supertrend = latest?.supertrend || {};
  const fibonacciLevels = latest?.fibonacci?.levels || {};
  return {
    close: safeNum(candle.close),
    previousClose: safeNum(previousCandle.close),
    rsi,
    lowerBand: safeNum(bollinger.lower),
    middleBand: safeNum(bollinger.middle),
    upperBand: safeNum(bollinger.upper),
    supertrendValue: safeNum(supertrend.value),
    supertrendDirection: String(supertrend.direction || "unknown"),
    supertrendBreakUp: !!latest?.states?.supertrendBreakUp,
    supertrendBreakDown: !!latest?.states?.supertrendBreakDown,
    fib50: safeNum(fibonacciLevels["0.500"]),
    fib618: safeNum(fibonacciLevels["0.618"]),
    fib786: safeNum(fibonacciLevels["0.786"]),
  };
}

function evaluatePreset(side, preset, payload) {
  const summary = buildSignalSummary(payload);
  const oversold = Number(config.indicators.rsiOversold ?? 30);
  const overbought = Number(config.indicators.rsiOverbought ?? 80);
  const close = summary.close;
  const previousClose = summary.previousClose;
  const lowerBand = summary.lowerBand;
  const upperBand = summary.upperBand;
  const rsi = summary.rsi;
  const isBullish = summary.supertrendDirection === "bullish";
  const isBearish = summary.supertrendDirection === "bearish";
  const crossedUp = (level) =>
    level != null &&
    close != null &&
    previousClose != null &&
    previousClose < level &&
    close >= level;
  const crossedDown = (level) =>
    level != null &&
    close != null &&
    previousClose != null &&
    previousClose > level &&
    close <= level;

  switch (preset) {
    case "supertrend_break":
      return side === "entry"
        ? {
            confirmed: summary.supertrendBreakUp || (isBullish && close != null && summary.supertrendValue != null && close >= summary.supertrendValue),
            reason: summary.supertrendBreakUp ? "Supertrend flipped bullish" : "Price is above bullish Supertrend",
            signal: summary,
          }
        : {
            confirmed: summary.supertrendBreakDown || (isBearish && close != null && summary.supertrendValue != null && close <= summary.supertrendValue),
            reason: summary.supertrendBreakDown ? "Supertrend flipped bearish" : "Price is below bearish Supertrend",
            signal: summary,
          };
    case "rsi_reversal":
      return side === "entry"
        ? {
            confirmed: rsi != null && rsi <= oversold,
            reason: `RSI ${rsi ?? "n/a"} <= oversold ${oversold}`,
            signal: summary,
          }
        : {
            confirmed: rsi != null && rsi >= overbought,
            reason: `RSI ${rsi ?? "n/a"} >= overbought ${overbought}`,
            signal: summary,
          };
    case "bollinger_reversion":
      return side === "entry"
        ? {
            confirmed: close != null && lowerBand != null && close <= lowerBand,
            reason: `Close ${close ?? "n/a"} <= lower band ${lowerBand ?? "n/a"}`,
            signal: summary,
          }
        : {
            confirmed: close != null && upperBand != null && close >= upperBand,
            reason: `Close ${close ?? "n/a"} >= upper band ${upperBand ?? "n/a"}`,
            signal: summary,
          };
    case "rsi_plus_supertrend":
      return side === "entry"
        ? {
            confirmed:
              (rsi != null && rsi <= oversold) &&
              (summary.supertrendBreakUp || isBullish),
            reason: `RSI oversold with bullish Supertrend context`,
            signal: summary,
          }
        : {
            confirmed:
              (rsi != null && rsi >= overbought) &&
              (summary.supertrendBreakDown || isBearish),
            reason: `RSI overbought with bearish Supertrend context`,
            signal: summary,
          };
    case "supertrend_or_rsi":
      return side === "entry"
        ? {
            confirmed:
              summary.supertrendBreakUp ||
              (isBullish && close != null && summary.supertrendValue != null && close >= summary.supertrendValue) ||
              (rsi != null && rsi <= oversold),
            reason: "Supertrend bullish confirmation or RSI oversold",
            signal: summary,
          }
        : {
            confirmed:
              summary.supertrendBreakDown ||
              (isBearish && close != null && summary.supertrendValue != null && close <= summary.supertrendValue) ||
              (rsi != null && rsi >= overbought),
            reason: "Supertrend bearish confirmation or RSI overbought",
            signal: summary,
          };
    case "bb_plus_rsi":
      return side === "entry"
        ? {
            confirmed:
              close != null &&
              lowerBand != null &&
              close <= lowerBand &&
              rsi != null &&
              rsi <= oversold,
            reason: "Close at/below lower band with RSI oversold",
            signal: summary,
          }
        : {
            confirmed:
              close != null &&
              upperBand != null &&
              close >= upperBand &&
              rsi != null &&
              rsi >= overbought,
            reason: "Close at/above upper band with RSI overbought",
            signal: summary,
          };
    case "bb_plus_rsi_plus_supertrend":
      return side === "entry"
        ? {
            confirmed:
              close != null &&
              lowerBand != null &&
              close <= lowerBand &&
              rsi != null &&
              rsi <= oversold &&
              (summary.supertrendBreakUp || isBullish),
            reason: "Close at/below lower band + RSI oversold + Supertrend green",
            signal: summary,
          }
        : {
            confirmed:
              close != null &&
              upperBand != null &&
              close >= upperBand &&
              rsi != null &&
              rsi >= overbought &&
              (summary.supertrendBreakDown || isBearish),
            reason: "Close at/above upper band + RSI overbought + Supertrend red",
            signal: summary,
          };
    case "fibo_reclaim":
      return side === "entry"
        ? {
            confirmed:
              crossedUp(summary.fib618) ||
              crossedUp(summary.fib50) ||
              crossedUp(summary.fib786),
            reason: "Price reclaimed a key Fibonacci level",
            signal: summary,
          }
        : {
            confirmed:
              crossedUp(summary.fib618) ||
              crossedUp(summary.fib50),
            reason: "Price reclaimed a key Fibonacci level upward",
            signal: summary,
          };
    case "fibo_reject":
      return side === "entry"
        ? {
            confirmed:
              crossedDown(summary.fib618) ||
              crossedDown(summary.fib50),
            reason: "Price rejected from a key Fibonacci level",
            signal: summary,
          }
        : {
            confirmed:
              crossedDown(summary.fib618) ||
              crossedDown(summary.fib50) ||
              crossedDown(summary.fib786),
            reason: "Price rejected below a key Fibonacci level",
            signal: summary,
          };
    default:
      return {
        confirmed: false,
        reason: `Unknown preset ${preset}`,
        signal: summary,
      };
  }
}

async function fetchChartIndicatorsForMint(
  mint,
  {
    interval,
    candles = config.indicators.candles ?? DEFAULT_CANDLES,
    rsiLength = config.indicators.rsiLength ?? 2,
    refresh = false,
  } = {},
) {
  const normalizedInterval = String(interval || "15_MINUTE").trim().toUpperCase();
  const search = new URLSearchParams({
    interval: normalizedInterval,
    candles: String(candles),
    rsiLength: String(rsiLength),
  });
  if (refresh) search.set("refresh", "1");

  return agentMeridianJson(`/chart-indicators/${mint}?${search.toString()}`, {
    headers: getAgentMeridianHeaders(),
  });
}

export async function confirmIndicatorPreset({
  mint,
  side,
  preset = side === "entry" ? config.indicators.entryPreset : config.indicators.exitPreset,
  intervals = config.indicators.intervals,
  refresh = false,
  pool = null,
} = {}) {
  if (!config.indicators.enabled || !mint || !preset) {
    return { enabled: false, confirmed: true, reason: "Indicators disabled or not configured", intervals: [] };
  }

  const targets = normalizeIntervals(intervals);
  if (targets.length === 0) {
    return { enabled: false, confirmed: true, reason: "No indicator intervals configured", intervals: [] };
  }

  const strict = !!config.indicators.strictMode;
  const results = [];
  for (const interval of targets) {
    try {
      let payload;
      if (interval === "1_MINUTE") {
        // Agent Meridian only serves 5/15_MINUTE — fetch 1m candles from
        // GeckoTerminal and compute indicators locally.
        payload = await fetchLocalOneMinutePayload(mint, pool);
      } else {
        payload = await fetchChartIndicatorsForMint(mint, { interval, refresh });
      }
      const readinessIssues = validateIndicatorReadiness(payload, interval);
      if (readinessIssues.length > 0) {
        log(
          "indicators_warn",
          `Indicator data not ready for ${mint.slice(0, 8)} ${interval}: ${readinessIssues.join("; ")}`,
        );
        results.push({
          interval,
          ok: true,
          confirmed: false,
          reason: `Indicator data not ready: ${readinessIssues.join("; ")}`,
          signal: null,
          latest: payload?.latest || null,
        });
        continue;
      }
      const evaluation = evaluatePreset(side, preset, payload);
      let confirmed = !!evaluation.confirmed;
      let reason = evaluation.reason;
      if (confirmed && side === "entry") {
        const safetyRejection = entrySafetyRejection(evaluation.signal);
        if (safetyRejection) {
          confirmed = false;
          reason = safetyRejection;
        }
      }
      results.push({
        interval,
        ok: true,
        confirmed,
        reason,
        signal: evaluation.signal,
        latest: payload?.latest || null,
      });
    } catch (error) {
      log("indicators_warn", `Indicator fetch failed for ${mint.slice(0, 8)} ${interval}: ${error.message}`);
      results.push({
        interval,
        ok: false,
        confirmed: null,
        reason: error.message,
        signal: null,
        latest: null,
      });
    }
  }

  const successful = results.filter((entry) => entry.ok);
  if (successful.length === 0) {
    if (strict) {
      return {
        enabled: true,
        confirmed: false,
        skipped: true,
        preset,
        side,
        reason: `Indicator API unavailable and strictMode is on — entry blocked (${results.map((entry) => entry.reason).join("; ")})`,
        intervals: results,
      };
    }
    return {
      enabled: true,
      confirmed: true,
      skipped: true,
      preset,
      side,
      reason: "Indicator API unavailable; falling back to existing logic",
      intervals: results,
    };
  }

  const requireAll = !!config.indicators.requireAllIntervals;
  const failedCount = results.length - successful.length;
  const confirmed = requireAll
    ? (strict ? results : successful).every((entry) => entry.confirmed)
    : strict
      ? failedCount === 0 && successful.some((entry) => entry.confirmed)
      : successful.some((entry) => entry.confirmed);

  const reason = confirmed
    ? `${preset} confirmed on ${successful.filter((entry) => entry.confirmed).map((entry) => entry.interval).join(", ")}`
    : `${preset} not confirmed on ${successful.map((entry) => entry.interval).join(", ")}${failedCount > 0 && strict ? ` (${failedCount} interval fetch failed, strictMode blocks unverified entry)` : ""}`;

  return {
    enabled: true,
    confirmed,
    skipped: false,
    preset,
    side,
    requireAllIntervals: requireAll,
    reason,
    intervals: results,
  };
}
