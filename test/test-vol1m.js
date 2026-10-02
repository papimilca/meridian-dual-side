/**
 * Live test for the 1-minute volume gate (checkOneMinuteVolume).
 * No wallet required — read-only API calls.
 *
 * Run with a token CA (mint address):
 *   node test/test-vol1m.js <mint_address>
 *
 * Options:
 *   --pool <pool_address>   check a specific pool address instead of mint
 *   --min <usd>             override the volume threshold (default: config 30000)
 *   --scope token|pool      check only one scope (default: both, for comparison)
 *   --raw                   also print raw last-5 candles per pool
 *
 * Scopes:
 *   token = GMGN-style: sum of 1m volume across ALL pools of the token (top 5 by 24h volume)
 *   pool  = only the Meteora DLMM pool the bot would deploy into
 *
 * Examples:
 *   node test/test-vol1m.js GAwhcphCqCv5bKHmCiN4VDdNWfbXJL4npmkc8L3Q9S9H
 *   node test/test-vol1m.js GAwhcphCqCv5bKHmCiN4VDdNWfbXJL4npmkc8L3Q9S9H --min 30000 --raw
 */

import { parseArgs } from "util";
import { config } from "../config.js";
import { checkOneMinuteVolume } from "../tools/chart-indicators.js";

const GECKO_TERMINAL_BASE = "https://api.geckoterminal.com/api/v2";

function fmtUsd(value) {
  if (value == null || !Number.isFinite(value)) return "n/a";
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function fmtTime(unixSec) {
  return new Date(Number(unixSec) * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

async function fetchRawCandles(poolAddress, limit = 5) {
  const url = `${GECKO_TERMINAL_BASE}/networks/solana/pools/${poolAddress}/ohlcv/minute?aggregate=1&currency=usd&limit=${limit}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`GeckoTerminal OHLCV failed (${res.status})`);
  const payload = await res.json();
  // newest-first: [time, open, high, low, close, volume] — volume is USD
  return payload?.data?.attributes?.ohlcv_list || [];
}

async function resolvePoolByMint(mint) {
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(mint)}&sort_by=${encodeURIComponent("tvl:desc")}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`pool lookup failed (${res.status})`);
  const payload = await res.json();
  const pools = Array.isArray(payload) ? payload : payload?.data || [];
  const match = pools.find((p) => p?.token_x?.address === mint || p?.mint_x === mint);
  const addr = match?.address || match?.pool_address;
  if (!addr) throw new Error("no Meteora DLMM pool found for this CA");
  return { poolAddress: addr, symbol: match?.token_x?.symbol || match?.name || "?" };
}

async function printResult(label, result) {
  console.log(`\n[${label}]`);
  console.log(`  ok:            ${result.ok ? "PASS ✅" : "FAIL ❌"}`);
  console.log(`  last 1m vol:   ${fmtUsd(result.lastVolumeUsd)}`);
  console.log(`  avg 3m vol:    ${fmtUsd(result.avg3VolumeUsd)}`);
  console.log(`  pools checked: ${result.poolsChecked ?? "-"}`);
  console.log(`  threshold:     ${fmtUsd(result.minVolume1mUsd)}`);
  console.log(`  reason:        ${result.reason}`);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      pool: { type: "string" },
      min: { type: "string" },
      scope: { type: "string" },
      raw: { type: "boolean", default: false },
    },
  });

  const target = positionals[0] || values.pool;
  if (!target) {
    console.error("Usage: node test/test-vol1m.js <mint_ca> [--pool <addr>] [--min <usd>] [--scope token|pool] [--raw]");
    process.exit(1);
  }

  if (values.min != null) {
    const min = Number(values.min);
    if (!Number.isFinite(min) || min < 0) {
      console.error(`Invalid --min value: ${values.min}`);
      process.exit(1);
    }
    config.indicators.minVolume1mUsd = min;
  }

  const scopeFilter = values.scope ? String(values.scope).toLowerCase() : null;
  if (scopeFilter && !["token", "pool"].includes(scopeFilter)) {
    console.error(`Invalid --scope value: ${values.scope} (use token or pool)`);
    process.exit(1);
  }

  console.log("=== 1-Minute Volume Gate Live Test ===\n");
  console.log(`Threshold (minVolume1mUsd): ${fmtUsd(config.indicators.minVolume1mUsd)} / minute`);
  console.log(`Rule: last minute AND avg of last 3 completed minutes must both pass\n`);

  // Resolve the Meteora deploy pool (positional arg = mint CA; --pool = pool address)
  let poolAddress = values.pool || null;
  let symbol = "?";
  let mint = null;
  if (!poolAddress) {
    mint = target;
    console.log(`Resolving deploy pool for CA: ${mint}`);
    const resolved = await resolvePoolByMint(mint);
    poolAddress = resolved.poolAddress;
    symbol = resolved.symbol;
  } else {
    symbol = "pool arg";
  }
  console.log(`Deploy pool (Meteora): ${poolAddress} (${symbol})`);

  // Raw candle dump for the deploy pool (compare with GMGN "vol 1m")
  if (values.raw) {
    console.log(`\nLast 5 raw 1m candles — deploy pool (currency=usd, newest first):`);
    const candles = await fetchRawCandles(poolAddress, 5);
    for (const [t, , , , c, v] of candles) {
      console.log(`  ${fmtTime(t)}  close=$${Number(c).toFixed(8)}  vol=${fmtUsd(Number(v))}`);
    }
  }

  // Run the gate — both scopes by default so the difference is visible
  let finalOk = true;
  const scopes = scopeFilter ? [scopeFilter] : ["token", "pool"];
  for (const scope of scopes) {
    if (scope === "pool" && !poolAddress) continue;
    try {
      const result = await checkOneMinuteVolume({ mint, poolAddress, scope });
      await printResult(scope === "token" ? "TOKEN scope (GMGN-style, all pools)" : "POOL scope (deploy pool only)", result);
      finalOk = finalOk && result.ok;
    } catch (err) {
      console.error(`\n[${scope}] ERROR: ${err.message}`);
      finalOk = false;
    }
  }

  console.log(`\n=== Deploy would be ${finalOk ? "ALLOWED" : "BLOCKED"} by the 1m volume gate (${scopes.join(" + ")} scope) ===`);
  process.exit(finalOk ? 0 : 2);
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
