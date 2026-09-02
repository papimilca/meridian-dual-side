#!/usr/bin/env node
/**
 * repair-zap-pnl.js — Backfill zeroed close records caused by the zap-out
 * PnL bug (fetchClosedPnL was called without `wallet`, so every zap-out close
 * recorded pnl_usd = 0 / initial_value_usd = 0 into lessons.json and
 * pool-memory.json).
 *
 * The real closed PnL still lives in the Meteora API — this script fetches it
 * per pool, matches by position address, and repairs both files.
 *
 * Usage:
 *   node tools/repair-zap-pnl.js           # apply repair
 *   node tools/repair-zap-pnl.js --dry     # show what would change, write nothing
 */
import fs from "fs";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { repoPath } from "../repo-root.js";

const DRY = process.argv.includes("--dry");

const LESSONS_FILE = repoPath("lessons.json");
const POOL_MEMORY_FILE = repoPath("pool-memory.json");

function maybeNum(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function totals(posEntry) {
  return {
    pnlUsd: maybeNum(posEntry?.pnlUsd) ?? maybeNum(posEntry?.pnl?.value) ?? 0,
    initialUsd: maybeNum(posEntry?.allTimeDeposits?.total?.usd) ?? 0,
    finalUsd: maybeNum(posEntry?.allTimeWithdrawals?.total?.usd) ?? 0,
    feesUsd: maybeNum(posEntry?.allTimeFees?.total?.usd) ?? 0,
  };
}

function pnlPctOf(posEntry) {
  const t = totals(posEntry);
  if (t.initialUsd <= 0) {
    const depositSol = maybeNum(posEntry?.allTimeDeposits?.total?.sol) ?? 0;
    const pnlSol = maybeNum(posEntry?.pnlSol) ?? maybeNum(posEntry?.pnl?.valueNative) ?? 0;
    return depositSol > 0 ? (pnlSol / depositSol) * 100 : null;
  }
  return (t.pnlUsd / t.initialUsd) * 100;
}

async function main() {
  if (!process.env.WALLET_PRIVATE_KEY) {
    console.error("WALLET_PRIVATE_KEY not set — load .env first (e.g. `node --env-file=.env tools/repair-zap-pnl.js --dry`)");
    process.exit(1);
  }
  const wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  const user = wallet.publicKey.toString();
  console.log(`Wallet: ${user}${DRY ? "  [DRY RUN]" : ""}\n`);

  const lessons = JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
  const perf = Array.isArray(lessons.performance) ? lessons.performance : [];

  // Corrupted entries: closed zap-out records written with zeros
  const corrupted = perf.filter(
    (p) =>
      p &&
      p.position &&
      p.pool &&
      (p.pnl_usd ?? null) === 0 &&
      !(p.initial_value_usd > 0) &&
      !(p.final_value_usd > 0)
  );
  console.log(`Performance records: ${perf.length} total, ${corrupted.length} zeroed (candidates for repair)`);

  if (corrupted.length === 0) {
    console.log("Nothing to repair.");
    return;
  }

  // Fetch closed PnL per unique pool
  const pools = [...new Set(corrupted.map((p) => p.pool))];
  const apiByPosition = {};
  for (const pool of pools) {
    const url = `https://dlmm.datapi.meteora.ag/positions/${pool}/pnl?user=${user}&status=closed&pageSize=50&page=1`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`  ✗ ${pool.slice(0, 8)}: API ${res.status}`);
        continue;
      }
      const data = await res.json();
      for (const entry of data.positions || []) {
        if (entry?.positionAddress) apiByPosition[entry.positionAddress] = entry;
      }
      console.log(`  ✓ ${pool.slice(0, 8)}: ${data.positions?.length ?? 0} closed position(s) fetched`);
    } catch (e) {
      console.error(`  ✗ ${pool.slice(0, 8)}: ${e.message}`);
    }
  }

  // Repair lessons.json performance entries
  let fixed = 0;
  const fixedByRecordedAt = {}; // recorded_at -> true (for pool-memory match)
  for (const p of corrupted) {
    const apiEntry = apiByPosition[p.position];
    if (!apiEntry) continue;
    const t = totals(apiEntry);
    const pct = pnlPctOf(apiEntry);
    if (pct == null) continue;

    p.pnl_usd = Math.round(t.pnlUsd * 100) / 100;
    p.pnl_pct = Math.round(pct * 100) / 100;
    p.initial_value_usd = t.initialUsd;
    p.final_value_usd = t.finalUsd;
    p.fees_earned_usd = t.feesUsd;
    p.repaired_from = "meteora-closed-pnl-api";
    fixed++;
    fixedByRecordedAt[p.recorded_at] = true;
    console.log(`  ↻ ${p.pool_name || p.pool.slice(0, 8)} ${p.position.slice(0, 8)}: PnL ${p.pnl_usd >= 0 ? "+" : ""}$${p.pnl_usd} (${p.pnl_pct}%)`);
  }
  console.log(`\nRepaired ${fixed}/${corrupted.length} performance records`);

  if (fixed === 0) {
    console.log("No matching closed positions found in API — nothing written.");
    return;
  }

  // Repair pool-memory.json deploys (match pool + closed_at == perf.recorded_at)
  let poolFixed = 0;
  if (fs.existsSync(POOL_MEMORY_FILE)) {
    const db = JSON.parse(fs.readFileSync(POOL_MEMORY_FILE, "utf8"));
    for (const p of corrupted) {
      if (!fixedByRecordedAt[p.recorded_at]) continue;
      const entry = db[p.pool];
      if (!entry) continue;
      const deploy = entry.deploys?.find(
        (d) => d.pnl_pct === 0 && d.closed_at === p.recorded_at
      );
      if (deploy) {
        deploy.pnl_pct = p.pnl_pct;
        deploy.pnl_usd = p.pnl_usd;
        deploy.fees_earned_usd = p.fees_earned_usd;
        poolFixed++;
      }
      // Recompute aggregates
      const withPnl = entry.deploys.filter((d) => d.pnl_pct != null);
      if (withPnl.length > 0) {
        entry.avg_pnl_pct = Math.round((withPnl.reduce((s, d) => s + d.pnl_pct, 0) / withPnl.length) * 100) / 100;
        entry.win_rate = Math.round((withPnl.filter((d) => d.pnl_pct >= 0).length / withPnl.length) * 100) / 100;
      }
      const last = entry.deploys[entry.deploys.length - 1];
      entry.last_outcome = (last?.pnl_pct ?? 0) >= 0 ? "profit" : "loss";
    }

    if (!DRY) fs.writeFileSync(POOL_MEMORY_FILE, JSON.stringify(db, null, 2));
    console.log(`Pool-memory deploys repaired: ${poolFixed}`);
  }

  if (DRY) {
    console.log("\n[DRY RUN] No files written. Re-run without --dry to apply.");
  } else {
    fs.writeFileSync(LESSONS_FILE, JSON.stringify(lessons, null, 2));
    console.log("\n✓ lessons.json and pool-memory.json updated.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
