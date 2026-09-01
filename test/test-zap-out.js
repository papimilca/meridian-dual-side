/**
 * Test: Zap-out close path simulation (dry — no tx sent to mainnet)
 *
 * This script tests the @meteora-ag/zap-sdk integration WITHOUT actually
 * closing any position. It:
 *   1. Fetches your open DLMM positions (from your real wallet)
 *   2. For the first position, builds the remove-liquidity tx
 *   3. Fetches a Jupiter quote for base token → SOL
 *   4. Builds the atomic zap-out transaction via zapOutThroughJupiter()
 *   5. Simulates the combined transaction (simulateTransaction, NOT send)
 *   6. Reports success/failure with logs
 *
 * Usage:
 *   node test/test-zap-out.js                 # use first open position
 *   node test/test-zap-out.js <position_addr> # specify a position
 *
 * Requirements:
 *   - .env with WALLET_PRIVATE_KEY, RPC_URL, JUPITER_API_KEY
 *   - At least one open DLMM position with liquidity
 *   - DRY_RUN does NOT matter — this script bypasses the dry-run gate
 */

import "dotenv/config";
import { Connection, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import BN from "bn.js";
import { Zap, getJupiterQuote, getJupiterSwapInstruction, getTokenProgramFromMint } from "@meteora-ag/zap-sdk";
import DLMM from "@meteora-ag/dlmm";
import bs58 from "bs58";
import { getJupiterApiKey, getJupiterApiUrl } from "../tools/wallet.js";
import { config } from "../config.js";

// Colors for terminal output
const C = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
};
const c = (s, color) => `${color}${s}${C.reset}`;

function log(label, msg) {
  const ts = new Date().toISOString().split("T")[1].slice(0, 8);
  console.log(`${c(`[${ts}]`, C.dim)} ${c(label.padEnd(12), C.cyan)} ${msg}`);
}

async function main() {
  const targetPosition = process.argv[2] || null;

  // ── Init wallet + connection ────────────────────────────────
  if (!process.env.WALLET_PRIVATE_KEY) {
    console.error(c("ERROR: WALLET_PRIVATE_KEY not set in .env", C.red));
    process.exit(1);
  }

  const wallet = bs58.decode(process.env.WALLET_PRIVATE_KEY);
  // Import Keypair dynamically to avoid loading full dlmm.js
  const { Keypair } = await import("@solana/web3.js");
  const keypair = Keypair.fromSecretKey(wallet);
  const connection = new Connection(process.env.RPC_URL, "confirmed");
  const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

  console.log(c("\n════════════════════════════════════════════════════════════", C.cyan));
  console.log(c("  Zap-Out Close Path — Simulation Test (no tx sent)", C.cyan));
  console.log(c("════════════════════════════════════════════════════════════\n", C.cyan));
  console.log(`${c("Wallet:", C.yellow)} ${keypair.publicKey.toString()}`);
  console.log(`${c("RPC:", C.yellow)}     ${process.env.RPC_URL}`);
  console.log(`${c("Jupiter:", C.yellow)}  ${getJupiterApiUrl()} (key: ${getJupiterApiKey()?.slice(0, 8) || "none"}...)`);
  console.log();

  // ── Fetch all positions ──────────────────────────────────────
  log("init", "Fetching your DLMM positions...");
  const allPositions = await DLMM.getAllLbPairPositionsByUser(connection, keypair.publicKey);

  const entries = [];
  for (const [lbPairKey, posData] of Object.entries(allPositions)) {
    for (const pos of posData.lbPairPositionsData || []) {
      entries.push({ pool: lbPairKey, position: pos.publicKey.toString(), data: pos });
    }
  }

  if (entries.length === 0) {
    console.error(c("\n✗ No open DLMM positions found in this wallet.", C.red));
    console.error(c("  Deploy a position first (even in non-dry-run with small amount), then re-run.", C.yellow));
    process.exit(1);
  }

  console.log(c(`Found ${entries.length} position(s):`, C.green));
  for (const e of entries) {
    const binData = e.data?.positionData?.positionBinData || [];
    const hasLiq = binData.some(b => new BN(b.positionXAmount || "0").gt(new BN(0)) || new BN(b.positionYAmount || "0").gt(new BN(0)));
    const marker = (targetPosition === e.position || (!targetPosition && entries.indexOf(e) === 0)) ? c(" ← TARGET", C.yellow) : "";
    console.log(`  • ${e.position.slice(0, 8)}... pool=${e.pool.slice(0, 8)}... ${hasLiq ? c("has liquidity", C.green) : c("empty", C.dim)}${marker}`);
  }

  // ── Pick target position ────────────────────────────────────
  let target = entries.find(e => e.position === targetPosition);
  if (!target && !targetPosition) target = entries[0];
  if (!target) {
    console.error(c(`\n✗ Position ${targetPosition} not found in wallet.`, C.red));
    process.exit(1);
  }

  console.log(c(`\nTarget: ${target.position}`, C.cyan));

  // ── Load DLMM pool ──────────────────────────────────────────
  log("init", `Loading pool ${target.pool.slice(0, 8)}...`);
  const pool = await DLMM.create(connection, new PublicKey(target.pool));
  const tokenXMint = pool.lbPair.tokenXMint;
  const tokenYMint = pool.lbPair.tokenYMint;
  const isXBase = !tokenXMint.equals(SOL_MINT);
  console.log(`  tokenX: ${tokenXMint.toString().slice(0, 8)}... ${isXBase ? c("(base)", C.yellow) : "(SOL)"}`);
  console.log(`  tokenY: ${tokenYMint.toString().slice(0, 8)}... ${tokenYMint.equals(SOL_MINT) ? c("(SOL)", C.green) : ""}`);

  // ── Get position data + bin range ───────────────────────────
  const positionPubKey = new PublicKey(target.position);
  const positionData = await pool.getPosition(positionPubKey);
  const processed = positionData?.positionData;
  if (!processed) {
    console.error(c("✗ Could not load position data.", C.red));
    process.exit(1);
  }

  const binIds = (processed.positionBinData || []).map(b => b.binId);
  const fromBin = Math.min(...binIds);
  const toBin = Math.max(...binIds);
  console.log(`  bins: ${fromBin} → ${toBin} (${binIds.length} bins)`);

  // ── Calculate total withdrawable amounts ────────────────────
  let totalX = new BN(0);
  let totalY = new BN(0);
  for (const bin of processed.positionBinData || []) {
    totalX = totalX.add(new BN(bin.positionXAmount || "0"));
    totalY = totalY.add(new BN(bin.positionYAmount || "0"));
  }
  console.log(`  amountX: ${totalX.toString()} lamports`);
  console.log(`  amountY: ${totalY.toString()} lamports`);

  if (totalX.eq(new BN(0)) && totalY.eq(new BN(0))) {
    console.error(c("\n✗ Position has no liquidity to remove.", C.red));
    process.exit(1);
  }

  // ── Step 1: Build remove liquidity tx ────────────────────────
  log("step1", "Building removeLiquidity tx (shouldClaimAndClose=true)...");
  const removeTxs = await pool.removeLiquidity({
    user: keypair.publicKey,
    position: positionPubKey,
    fromBinId: fromBin,
    toBinId: toBin,
    bps: new BN(10000),
    shouldClaimAndClose: true,
  });
  const removeTxArray = Array.isArray(removeTxs) ? removeTxs : [removeTxs];
  log("step1", c(`✓ Built ${removeTxArray.length} remove tx(s)`, C.green));

  // ── Step 2: Jupiter quote for base token → SOL ──────────────
  const swapMint = isXBase ? tokenXMint : (tokenYMint.equals(SOL_MINT) ? null : tokenXMint);
  const swapAmount = isXBase ? totalX : totalY;

  if (!swapMint || swapMint.equals(SOL_MINT) || swapAmount.eq(new BN(0))) {
    log("step2", c("⏭ No base token to swap (position is quote-side only or base is SOL) — skip zap-out", C.yellow));
    console.log(c("\n✓ Remove liquidity tx built successfully. No swap needed.", C.green));
    console.log(c("  The position would close with just the remove tx(s).", C.dim));
    console.log(c("\n─────────────────────────────────────────────", C.cyan));
    console.log(c("Result: ZAP-OUT NOT REQUIRED (no base token to swap)", C.green));
    console.log(c("─────────────────────────────────────────────\n", C.cyan));
    process.exit(0);
  }

  log("step2", `Fetching Jupiter quote: ${swapMint.toString().slice(0, 8)}... → SOL (${swapAmount.toString()} lamports)`);

  const jupiterConfig = {
    jupiterApiUrl: getJupiterApiUrl(),
    jupiterApiKey: getJupiterApiKey(),
  };

  const slippageBps = Number(config.management?.zapOutSlippageBps ?? 500);
  const maxAccounts = Number(config.management?.zapOutMaxAccounts ?? 50);

  const quote = await getJupiterQuote(
    swapMint,
    SOL_MINT,
    swapAmount,
    maxAccounts,
    slippageBps,
    false, true, true, false,
    jupiterConfig,
  );

  if (!quote) {
    console.error(c("\n✗ Jupiter returned no quote for this token pair.", C.red));
    console.error(c("  Possible causes: low liquidity token, no route, token program mismatch.", C.dim));
    process.exit(1);
  }

  console.log(c("  ✓ Quote received:", C.green));
  console.log(`    inAmount:  ${quote.inAmount}`);
  console.log(`    outAmount: ${quote.outAmount} (≈ ${Number(quote.outAmount) / 1e9} SOL)`);
  console.log(`    priceImpactPct: ${quote.priceImpactPct ?? "n/a"}`);

  // ── Step 3: Build swap instruction ──────────────────────────
  log("step3", "Building Jupiter swap instruction...");
  const swapInstructionResponse = await getJupiterSwapInstruction(
    keypair.publicKey,
    quote,
    jupiterConfig,
  );
  log("step3", c("✓ Swap instruction built", C.green));

  // ── Step 4: Build atomic zap-out tx ──────────────────────────
  log("step4", "Building zapOutThroughJupiter tx...");
  const zapClient = new Zap(connection, jupiterConfig);

  const inputTokenProgram = await getTokenProgramFromMint(connection, swapMint);
  const outputTokenProgram = await getTokenProgramFromMint(connection, SOL_MINT);

  const zapOutTx = await zapClient.zapOutThroughJupiter({
    user: keypair.publicKey,
    inputMint: swapMint,
    outputMint: SOL_MINT,
    inputTokenProgram,
    outputTokenProgram,
    jupiterSwapResponse: swapInstructionResponse,
    maxSwapAmount: new BN(quote.inAmount),
    percentageToZapOut: 100,
  });
  log("step4", c("✓ Zap-out transaction built", C.green));

  // ── Step 5: Combine + simulate (NO SEND) ────────────────────
  log("step5", "Combining remove + zap-out into single transaction...");

  const combinedTx = new Transaction();
  for (const tx of removeTxArray) {
    combinedTx.add(...tx.instructions);
  }
  combinedTx.add(zapOutTx);

  const { blockhash } = await connection.getLatestBlockhash();
  combinedTx.recentBlockhash = blockhash;
  combinedTx.feePayer = keypair.publicKey;

  log("step5", "Simulating transaction (no send)...");
  const simulation = await connection.simulateTransaction(combinedTx, [keypair]);

  if (simulation.value.err) {
    console.error(c("\n✗ Simulation FAILED:", C.red));
    console.error(`  Error: ${JSON.stringify(simulation.value.err)}`);
    const logs = simulation.value.logs || [];
    console.error(c("\n  Logs:", C.dim));
    for (const line of logs.slice(-20)) {
      console.error(`  ${line}`);
    }
    console.log(c("\n─────────────────────────────────────────────", C.red));
    console.log(c("Result: ZAP-OUT SIMULATION FAILED", C.red));
    console.log(c("─────────────────────────────────────────────\n", C.red));
    process.exit(1);
  }

  console.log(c("\n✓ Simulation SUCCEEDED!", C.green));
  console.log(c("  The combined remove+swap transaction would execute on-chain.", C.green));
  const logs = simulation.value.logs || [];
  const unitsConsumed = simulation.value.unitsConsumed;
  console.log(`  Compute units: ${unitsConsumed?.toLocaleString() || "n/a"}`);

  console.log(c("\n─────────────────────────────────────────────", C.cyan));
  console.log(c("Result: ZAP-OUT SIMULATION PASSED ✓", C.green));
  console.log(c("─────────────────────────────────────────────\n", C.cyan));
  console.log(c("Next steps:", C.yellow));
  console.log("  1. Set DRY_RUN=false in .env");
  console.log("  2. Close a real position via /close or let management trigger it");
  console.log("  3. Check logs for 'Zap-out:' prefix to confirm fast path is used");
}

main().catch(err => {
  console.error(c("\n✗ Fatal error:", C.red), err.message);
  if (err.stack) console.error(c(err.stack, C.dim));
  process.exit(1);
});
