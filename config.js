import fs from "fs";
import { REPO_ROOT, repoPath } from "./repo-root.js";
import { getScreeningDefaultsForTimeframe, normalizeTimeframe, scaleScreeningToTimeframe, TIMEFRAME_SCREENING_SCALES } from "./screening-scales.js";

export { REPO_ROOT, repoPath, getScreeningDefaultsForTimeframe, normalizeTimeframe, scaleScreeningToTimeframe, TIMEFRAME_SCREENING_SCALES };

const USER_CONFIG_PATH = repoPath("user-config.json");
const DEFAULT_HIVEMIND_URL = "https://api.agentmeridian.xyz";
const DEFAULT_AGENT_MERIDIAN_API_URL = "https://api.agentmeridian.xyz/api";
const DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY = "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz";
const DEFAULT_HIVEMIND_API_KEY = DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY;

const u = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};
// Default min bins below when user-config.json doesn't set one.
export const MIN_SAFE_BINS_BELOW = 35;
// Absolute hard floor for user-configured min/max/defaultBinsBelow (blocks 0/negative/1-bin ranges).
export const ABS_MIN_BINS_BELOW = 2;

function numericConfig(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const legacyBinsBelow = numericConfig(u.binsBelow);
const configuredMinBinsBelow = numericConfig(u.minBinsBelow) ?? MIN_SAFE_BINS_BELOW;
const configuredMaxBinsBelow = numericConfig(u.maxBinsBelow)
  ?? (legacyBinsBelow != null ? Math.max(legacyBinsBelow, configuredMinBinsBelow) : 69);
const configuredDefaultBinsBelow = numericConfig(u.defaultBinsBelow) ?? legacyBinsBelow ?? configuredMaxBinsBelow;
const strategyMinBinsBelow = Math.max(ABS_MIN_BINS_BELOW, Math.round(configuredMinBinsBelow));
const strategyMaxBinsBelow = Math.max(strategyMinBinsBelow, Math.round(configuredMaxBinsBelow));
const strategyDefaultBinsBelow = Math.max(
  strategyMinBinsBelow,
  Math.min(strategyMaxBinsBelow, Math.round(configuredDefaultBinsBelow)),
);

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL      ||= u.llmBaseUrl;
if (u.llmApiKey)  process.env.LLM_API_KEY       ||= u.llmApiKey;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);
if (u.publicApiKey) process.env.PUBLIC_API_KEY ||= u.publicApiKey;
if (u.agentMeridianApiUrl) process.env.AGENT_MERIDIAN_API_URL ||= u.agentMeridianApiUrl;
if (u.telegramChatId) process.env.TELEGRAM_CHAT_ID ||= String(u.telegramChatId);

const indicatorUserConfig = u.chartIndicators ?? {};

// Optional standalone GMGN config file (mirrors user-config layering)
const GMGN_CONFIG_PATH = repoPath("gmgn-config.json");
const gmgnUserConfig = fs.existsSync(GMGN_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(GMGN_CONFIG_PATH, "utf8"))
  : {};
if (gmgnUserConfig.apiKey || u.gmgnApiKey) {
  process.env.GMGN_API_KEY ||= gmgnUserConfig.apiKey || u.gmgnApiKey;
}

function nonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

const TOKEN_MINTS = {
  SOL:  "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
};

function normalizeQuoteTokens(values) {
  const fallback = Object.keys(TOKEN_MINTS);
  if (!Array.isArray(values)) return fallback;
  const normalized = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    const canonical = TOKEN_MINTS[trimmed.toUpperCase()] ? trimmed.toUpperCase() : trimmed;
    const dedupeKey = canonical.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalized.push(canonical);
  }
  return normalized.length > 0 ? normalized : fallback;
}

export const config = {
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    u.maxPositions    ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    excludeHighSupplyConcentration: u.excludeHighSupplyConcentration ?? true,
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
    minTvl:            u.minTvl            ?? 10_000,
    maxTvl:            u.maxTvl !== undefined ? u.maxTvl : 150_000,
    minVolume:         u.minVolume         ?? 500,
    minOrganic:        u.minOrganic        ?? 60,
    minQuoteOrganic:   u.minQuoteOrganic   ?? 60,
    quoteTokens:       normalizeQuoteTokens(u.quoteTokens),
    minHolders:        u.minHolders        ?? 500,
    minMcap:           u.minMcap           ?? 150_000,
    maxMcap:           u.maxMcap           ?? 10_000_000,
    minBinStep:        u.minBinStep        ?? 80,
    maxBinStep:        u.maxBinStep        ?? 125,
    collectFeeMode:    u.collectFeeMode ?? "both", // both | quote | base | any (any = disable fee-mode filter)
    timeframe:         u.timeframe         ?? "5m",
    category:          u.category          ?? "trending",
    minTokenFeesSol:   u.minTokenFeesSol   ?? 30,  // global fees paid (priority+jito tips). below = bundled/scam
    useDiscordSignals: u.useDiscordSignals ?? false,
    discordSignalMode: u.discordSignalMode ?? "merge", // merge | only
    avoidPvpSymbols:   u.avoidPvpSymbols   ?? true, // avoid exact-symbol rivals with real active pools
    blockPvpSymbols:   u.blockPvpSymbols   ?? false, // hard-filter PVP rivals before the LLM sees them
    maxBotHoldersPct:  u.maxBotHoldersPct  ?? 30,  // max bot holder addresses % (Jupiter audit)
    maxTop10Pct:       u.maxTop10Pct       ?? 60,  // max top 10 holders concentration
    loneCandidateMinDegen: u.loneCandidateMinDegen ?? 50, // degen score that lets a SOLO candidate deploy without a narrative
    allowedLaunchpads: u.allowedLaunchpads ?? [],  // allow-list launchpads, [] = no allow-list
    blockedLaunchpads:  u.blockedLaunchpads  ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
    minTokenAgeHours:   u.minTokenAgeHours   ?? null, // null = no minimum
    maxTokenAgeHours:   u.maxTokenAgeHours   ?? null, // null = no maximum
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? false,
    autoSwapRetryAttempts: u.autoSwapRetryAttempts ?? 3,    // retries for base→SOL auto-swap on Jupiter failure
    autoSwapRetryDelayMs:  u.autoSwapRetryDelayMs  ?? 3000, // delay between auto-swap retries
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    // Directional OOR waits — above = price above range (active_bin > upper_bin),
    // below = price below range (active_bin < lower_bin). Fall back to outOfRangeWaitMinutes.
    outOfRangeWaitMinutesAbove: u.outOfRangeWaitMinutesAbove ?? u.outOfRangeWaitMinutes ?? 30,
    outOfRangeWaitMinutesBelow: u.outOfRangeWaitMinutesBelow ?? u.outOfRangeWaitMinutes ?? 30,
    oorCooldownTriggerCount: u.oorCooldownTriggerCount ?? 3,
    oorCooldownHours:       u.oorCooldownHours       ?? 12,
    repeatDeployCooldownEnabled: u.repeatDeployCooldownEnabled ?? true,
    repeatDeployCooldownTriggerCount: u.repeatDeployCooldownTriggerCount ?? 3,
    repeatDeployCooldownHours: u.repeatDeployCooldownHours ?? 12,
    repeatDeployCooldownScope: u.repeatDeployCooldownScope ?? "token", // pool | token | both
    repeatDeployCooldownMinFeeEarnedPct: u.repeatDeployCooldownMinFeeEarnedPct ?? u.repeatDeployCooldownMinFeeYieldPct ?? 0,
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    stopLossPct:           u.stopLossPct           ?? u.emergencyPriceDropPct ?? -50,
    takeProfitPct:         u.takeProfitPct         ?? u.takeProfitFeePct ?? 5,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 7,
    minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 60, // minutes before low yield can trigger close
    minSolToOpen:          u.minSolToOpen          ?? 0.55,
    deployAmountSol:       u.deployAmountSol       ?? 0.5,
    // true when deployAmountSol was explicitly set (user-config or update_config) → deploy exactly that amount
    deployAmountSolExplicit: numericConfig(u.deployAmountSol) != null,
    gasReserve:            u.gasReserve            ?? 0.2,
    positionSizePct:       u.positionSizePct       ?? 0.35,
    // Trailing take-profit
    trailingTakeProfit:    u.trailingTakeProfit    ?? true,
    trailingTriggerPct:    u.trailingTriggerPct    ?? 3,    // activate trailing at X% PnL
    trailingDropPct:       u.trailingDropPct       ?? 1.5,  // close when drops X% from peak
    pnlSanityMaxDiffPct:   u.pnlSanityMaxDiffPct   ?? 5,    // max allowed diff between reported and derived pnl % before ignoring a tick
    // Partial take-profit — remove a percentage of liquidity to lock profit while
    // letting the rest ride under trailing TP. Fires once when peak PnL reaches
    // the trigger threshold; trailing TP still handles the full exit on reversal.
    partialTakeProfit:     u.partialTakeProfit     ?? false,
    partialTpTriggerPct:   u.partialTpTriggerPct   ?? 6,    // trigger partial close when confirmed peak >= X%
    partialTpClosePct:     u.partialTpClosePct     ?? 50,   // percentage of remaining liquidity to remove (1-100)
    // SOL mode — positions, PnL, and balances reported in SOL instead of USD
    solMode:               u.solMode               ?? false,
    // Zap-out fast close: uses @meteora-ag/zap-sdk to remove liquidity + swap base→SOL
    // atomically in a single transaction, eliminating sequential claim→remove→swap drift.
    zapOutEnabled:         u.zapOutEnabled         ?? true,
    // Slippage tolerance (bps) for the Jupiter swap inside the zap-out tx (500 = 5%)
    zapOutSlippageBps:     u.zapOutSlippageBps     ?? 500,
    // Max accounts for Jupiter quote — keeps tx size reasonable
    zapOutMaxAccounts:     u.zapOutMaxAccounts     ?? 50,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:     u.strategy     ?? "bid_ask",
    minBinsBelow: strategyMinBinsBelow,
    maxBinsBelow: strategyMaxBinsBelow,
    defaultBinsBelow: strategyDefaultBinsBelow,
    dualSide:     u.dualSide     ?? false, // Enable imbalanced/dual-side positions (amount_x_sol + amount_y)
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.managementIntervalMin  ?? 10,
    screeningIntervalMin:   u.screeningIntervalMin   ?? 30,
    healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: u.temperature ?? 0.373,
    maxTokens:   u.maxTokens   ?? 4096,
    maxSteps:    u.maxSteps    ?? 20,
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
    screeningModel:  u.screeningModel  ?? process.env.LLM_MODEL ?? "openrouter/hunter-alpha",
    generalModel:    u.generalModel    ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
  },

  // ─── Darwinian Signal Weighting ───────
  darwin: {
    enabled:        u.darwinEnabled     ?? true,
    windowDays:     u.darwinWindowDays  ?? 60,
    recalcEvery:    u.darwinRecalcEvery ?? 5,    // recalc every N closes
    boostFactor:    u.darwinBoost       ?? 1.05,
    decayFactor:    u.darwinDecay       ?? 0.95,
    weightFloor:    u.darwinFloor       ?? 0.3,
    weightCeiling:  u.darwinCeiling     ?? 2.5,
    minSamples:     u.darwinMinSamples  ?? 10,
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    ...TOKEN_MINTS,
  },

  // ─── HiveMind ─────────────────────────
  hiveMind: {
    url: nonEmptyString(u.hiveMindUrl, DEFAULT_HIVEMIND_URL),
    apiKey: nonEmptyString(u.hiveMindApiKey, process.env.HIVEMIND_API_KEY, DEFAULT_HIVEMIND_API_KEY),
    agentId: u.agentId ?? null,
    pullMode: u.hiveMindPullMode ?? "auto",
  },

  api: {
    url: nonEmptyString(u.agentMeridianApiUrl, process.env.AGENT_MERIDIAN_API_URL, DEFAULT_AGENT_MERIDIAN_API_URL),
    publicApiKey: nonEmptyString(u.publicApiKey, process.env.PUBLIC_API_KEY, DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY),
    lpAgentRelayEnabled: u.lpAgentRelayEnabled ?? false,
  },

  // ─── PnL fetcher / poller (public infra: RPC + Meteora deposits + Jupiter) ──
  pnl: {
    // Live position value comes from on-chain reads on this RPC.
    // Defaults to the official public RPC (allows indexed requests needed by
    // getAllLbPairPositionsByUser / getSignaturesForAddress) so the aggressive
    // poller never burns the main RPC_URL or the LPAgent sponsor budget.
    // publicnode/onfinality block indexed requests on free tier.
    rpcUrl: nonEmptyString(u.pnlRpcUrl, process.env.PNL_RPC_URL, "https://api.mainnet-beta.solana.com"),
    source: nonEmptyString(u.pnlSource, "rpc"), // rpc | meteora (fallback-only)
    pollIntervalSec: Number(u.pnlPollIntervalSec ?? 3),
    depositCacheTtlSec: Number(u.pnlDepositCacheTtlSec ?? 300),
    // Consecutive confirming polls required before a peak is raised or an exit fires.
    // At a 3s poll cadence, 2 ticks ≈ 3-6s — filters single-tick noise without the
    // old fixed 15s setTimeout recheck.
    confirmTicks: Number(u.pnlConfirmTicks ?? 2),
  },

  // ─── Opportunity poller (catches strong pools between screening cycles) ──
  opportunity: {
    enabled: u.opportunityPollEnabled ?? true,
    pollIntervalSec: Number(u.opportunityPollIntervalSec ?? 45),
    limit: Number(u.opportunityPollLimit ?? 10),
    // Pre-gate: only trigger the full deploy decision when the best candidate's
    // Degen Score (0..100) clears this bar — avoids running screening every 45s.
    minScore: Number(u.opportunityMinScore ?? 40),
    // A smart wallet (from the agentmeridian server) sitting on the pool LOWERS the
    // effective minScore by this much — a strong signal nudges a borderline pool through.
    smartWalletScoreBonus: Number(u.opportunitySmartWalletBonus ?? 20),
    // Degen Score targets (each sub-score saturates at its target). Tune to calibrate.
    // Inputs are normalized to a fixed 30m reference window, so these are timeframe-independent.
    targetVolRatio: Number(u.degenTargetVolRatio ?? 20),     // (30m) volume/active_tvl for full trading sub-score
    targetLpCount: Number(u.degenTargetLpCount ?? 40),       // (30m) unique_lps + positions_created for full LP sub-score
    targetFeeRatio: Number(u.degenTargetFeeRatio ?? 0.20),   // (30m) fee/active_tvl for full fee sub-score (tune per timeframe; fees don't normalize as cleanly as volume)
    // active_tvl ($) for full liquidity sub-score. NOT timeframe-scaled. Set near your
    // active-TVL floor (≈ minTvl) so it acts as a dust floor, not a stretch goal — the
    // screening minTvl filter already removes tiny pools.
    targetLiquidity: Number(u.degenTargetLiquidity ?? 20000),
  },

  // ─── GMGN (fee source for minTokenFeesSol gate) ──────────────
  gmgn: {
    apiKey: nonEmptyString(gmgnUserConfig.apiKey, u.gmgnApiKey, process.env.GMGN_API_KEY),
    baseUrl: nonEmptyString(gmgnUserConfig.baseUrl, u.gmgnBaseUrl, "https://openapi.gmgn.ai"),
    requestDelayMs: Number(gmgnUserConfig.requestDelayMs ?? u.gmgnRequestDelayMs ?? 2500),
    maxRetries: Number(gmgnUserConfig.maxRetries ?? u.gmgnMaxRetries ?? 2),
    // gmgn = use GMGN total_fee for global_fees_sol; jupiter = legacy Jupiter fees
    feeSource: nonEmptyString(gmgnUserConfig.feeSource, u.gmgnFeeSource, "gmgn"),
  },

  jupiter: {
    // Internal Jupiter Ultra settings; override by env only, do not expose in user-config.
    apiKey: process.env.JUPITER_API_KEY ?? "",
    referralAccount:
      process.env.JUPITER_REFERRAL_ACCOUNT ??
      "9MzhDUnq3KxecyPzvhguQMMPbooXQ3VAoCMPDnoijwey",
    referralFeeBps: Number(
      process.env.JUPITER_REFERRAL_FEE_BPS ?? 50,
    ),
  },

  indicators: {
    enabled: indicatorUserConfig.enabled ?? false,
    entryPreset: indicatorUserConfig.entryPreset ?? "supertrend_break",
    exitPreset: indicatorUserConfig.exitPreset ?? "supertrend_break",
    rsiLength: indicatorUserConfig.rsiLength ?? 2,
    intervals: Array.isArray(indicatorUserConfig.intervals)
      ? indicatorUserConfig.intervals
      : ["5_MINUTE"],
    candles: indicatorUserConfig.candles ?? 298,
    rsiOversold: indicatorUserConfig.rsiOversold ?? 30,
    rsiOverbought: indicatorUserConfig.rsiOverbought ?? 80,
    requireAllIntervals: indicatorUserConfig.requireAllIntervals ?? false,
    strictMode: indicatorUserConfig.strictMode ?? true,
    minCandles: indicatorUserConfig.minCandles ?? 50,
    maxCandleAgeIntervals: indicatorUserConfig.maxCandleAgeIntervals ?? 3,
    maxSpikePct: indicatorUserConfig.maxSpikePct ?? 20,
    maxEntryRsi: indicatorUserConfig.maxEntryRsi ?? 95,
  },
};

/**
 * Direction-aware OOR wait: how long a position may stay out of range before acting.
 * Above range (price pumped past upper bin) uses outOfRangeWaitMinutesAbove,
 * below range (price dumped past lower bin) uses outOfRangeWaitMinutesBelow.
 */
export function oorWaitMinutesFor(position, mgmt = config.management) {
  const fallback = mgmt.outOfRangeWaitMinutes ?? 30;
  const above = mgmt.outOfRangeWaitMinutesAbove ?? fallback;
  const below = mgmt.outOfRangeWaitMinutesBelow ?? fallback;
  if (position?.active_bin != null && position?.upper_bin != null && position.active_bin > position.upper_bin) return above;
  if (position?.active_bin != null && position?.lower_bin != null && position.active_bin < position.lower_bin) return below;
  return fallback;
}

/**
 * Compute the deploy amount for a given wallet balance.
 *
 * Fixed mode (deployAmountSol explicitly set in user-config or via update_config):
 *   deploy exactly deployAmountSol, capped by maxDeployAmount.
 *
 * Pct mode (deployAmountSol unset) — scales position size with wallet growth (compounding):
 *   clamp(deployable × positionSizePct, floor=deployAmountSol default 0.5, ceil=maxDeployAmount)
 *
 * Pct-mode examples (defaults: gasReserve=0.2, positionSizePct=0.35, floor=0.5):
 *   0.8 SOL wallet → 0.5 SOL deploy  (floor)
 *   2.0 SOL wallet → 0.63 SOL deploy
 *   3.0 SOL wallet → 0.98 SOL deploy
 *   4.0 SOL wallet → 1.33 SOL deploy
 */
export function computeDeployAmount(walletSol) {
  const reserve  = config.management.gasReserve      ?? 0.2;
  const pct      = config.management.positionSizePct ?? 0.35;
  const floor    = config.management.deployAmountSol ?? 0.5;
  const ceil     = config.risk.maxDeployAmount;
  if (config.management.deployAmountSolExplicit) {
    return parseFloat(Math.min(ceil, Math.max(0, floor)).toFixed(2));
  }
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic    = deployable * pct;
  const result     = Math.min(ceil, Math.max(floor, dynamic));
  return parseFloat(result.toFixed(2));
}

/**
 * Reload user-config.json and apply updated screening thresholds to the
 * in-memory config object. Called after threshold evolution so the next
 * agent cycle uses the evolved values without a restart.
 */
export function reloadScreeningThresholds() {
  try {
    if (!fs.existsSync(USER_CONFIG_PATH)) return;
    const fresh = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    const s = config.screening;
    const m = config.management;
    if (fresh.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = fresh.minFeeActiveTvlRatio;
    if (fresh.minTokenFeesSol  != null) s.minTokenFeesSol  = fresh.minTokenFeesSol;
    if (fresh.maxTop10Pct      != null) s.maxTop10Pct      = fresh.maxTop10Pct;
    if (fresh.useDiscordSignals !== undefined) s.useDiscordSignals = fresh.useDiscordSignals;
    if (fresh.discordSignalMode != null) s.discordSignalMode = fresh.discordSignalMode;
    if (fresh.excludeHighSupplyConcentration !== undefined) s.excludeHighSupplyConcentration = fresh.excludeHighSupplyConcentration;
    if (fresh.minOrganic     != null) s.minOrganic     = fresh.minOrganic;
    if (fresh.minQuoteOrganic != null) s.minQuoteOrganic = fresh.minQuoteOrganic;
    if (fresh.quoteTokens !== undefined) s.quoteTokens = normalizeQuoteTokens(fresh.quoteTokens);
    if (fresh.minHolders     != null) s.minHolders     = fresh.minHolders;
    if (fresh.minMcap        != null) s.minMcap        = fresh.minMcap;
    if (fresh.maxMcap        != null) s.maxMcap        = fresh.maxMcap;
    if (fresh.minTvl         != null) s.minTvl         = fresh.minTvl;
    if (fresh.maxTvl         !== undefined) s.maxTvl   = fresh.maxTvl;
    if (fresh.minVolume      != null) s.minVolume      = fresh.minVolume;
    if (fresh.minBinStep     != null) s.minBinStep     = fresh.minBinStep;
    if (fresh.maxBinStep     != null) s.maxBinStep     = fresh.maxBinStep;
    if (fresh.timeframe         != null) s.timeframe         = fresh.timeframe;
    if (fresh.category          != null) s.category          = fresh.category;
    if (fresh.minTokenAgeHours  !== undefined) s.minTokenAgeHours = fresh.minTokenAgeHours;
    if (fresh.maxTokenAgeHours  !== undefined) s.maxTokenAgeHours = fresh.maxTokenAgeHours;
    if (fresh.avoidPvpSymbols   !== undefined) s.avoidPvpSymbols = fresh.avoidPvpSymbols;
    if (fresh.blockPvpSymbols   !== undefined) s.blockPvpSymbols = fresh.blockPvpSymbols;
    if (fresh.maxBotHoldersPct  != null) s.maxBotHoldersPct = fresh.maxBotHoldersPct;
    if (fresh.allowedLaunchpads !== undefined) s.allowedLaunchpads = fresh.allowedLaunchpads;
    if (fresh.blockedLaunchpads !== undefined) s.blockedLaunchpads = fresh.blockedLaunchpads;
    if (fresh.minClaimAmount        != null) m.minClaimAmount        = fresh.minClaimAmount;
    if (fresh.autoSwapAfterClaim    !== undefined) m.autoSwapAfterClaim    = fresh.autoSwapAfterClaim;
    if (fresh.autoSwapRetryAttempts != null) m.autoSwapRetryAttempts = fresh.autoSwapRetryAttempts;
    if (fresh.autoSwapRetryDelayMs  != null) m.autoSwapRetryDelayMs  = fresh.autoSwapRetryDelayMs;
    if (fresh.outOfRangeBinsToClose != null) m.outOfRangeBinsToClose = fresh.outOfRangeBinsToClose;
    if (fresh.outOfRangeWaitMinutes != null) m.outOfRangeWaitMinutes = fresh.outOfRangeWaitMinutes;
    if (fresh.outOfRangeWaitMinutesAbove != null) m.outOfRangeWaitMinutesAbove = fresh.outOfRangeWaitMinutesAbove;
    if (fresh.outOfRangeWaitMinutesBelow != null) m.outOfRangeWaitMinutesBelow = fresh.outOfRangeWaitMinutesBelow;
    if (fresh.oorCooldownTriggerCount != null) m.oorCooldownTriggerCount = fresh.oorCooldownTriggerCount;
    if (fresh.oorCooldownHours       != null) m.oorCooldownHours       = fresh.oorCooldownHours;
    if (fresh.repeatDeployCooldownEnabled !== undefined) m.repeatDeployCooldownEnabled = fresh.repeatDeployCooldownEnabled;
    if (fresh.repeatDeployCooldownTriggerCount != null) m.repeatDeployCooldownTriggerCount = fresh.repeatDeployCooldownTriggerCount;
    if (fresh.repeatDeployCooldownHours != null) m.repeatDeployCooldownHours = fresh.repeatDeployCooldownHours;
    if (fresh.repeatDeployCooldownScope != null) m.repeatDeployCooldownScope = fresh.repeatDeployCooldownScope;
    if (fresh.repeatDeployCooldownMinFeeEarnedPct != null) m.repeatDeployCooldownMinFeeEarnedPct = fresh.repeatDeployCooldownMinFeeEarnedPct;
    if (fresh.repeatDeployCooldownMinFeeYieldPct != null) m.repeatDeployCooldownMinFeeEarnedPct = fresh.repeatDeployCooldownMinFeeYieldPct;
    if (fresh.minVolumeToRebalance  != null) m.minVolumeToRebalance  = fresh.minVolumeToRebalance;
    if (fresh.stopLossPct           != null) m.stopLossPct           = fresh.stopLossPct;
    if (fresh.emergencyPriceDropPct != null) m.stopLossPct           = fresh.emergencyPriceDropPct;
    if (fresh.takeProfitPct         != null) m.takeProfitPct         = fresh.takeProfitPct;
    if (fresh.takeProfitFeePct      != null) m.takeProfitPct         = fresh.takeProfitFeePct;
    if (fresh.minFeePerTvl24h       != null) m.minFeePerTvl24h       = fresh.minFeePerTvl24h;
    if (fresh.minAgeBeforeYieldCheck != null) m.minAgeBeforeYieldCheck = fresh.minAgeBeforeYieldCheck;
    if (fresh.minSolToOpen          != null) m.minSolToOpen          = fresh.minSolToOpen;
    if (fresh.deployAmountSol       != null) m.deployAmountSol       = fresh.deployAmountSol;
    m.deployAmountSolExplicit = numericConfig(fresh.deployAmountSol) != null;
    if (fresh.gasReserve            != null) m.gasReserve            = fresh.gasReserve;
    if (fresh.positionSizePct       != null) m.positionSizePct       = fresh.positionSizePct;
    if (fresh.trailingTakeProfit    !== undefined) m.trailingTakeProfit    = fresh.trailingTakeProfit;
    if (fresh.trailingTriggerPct    != null) m.trailingTriggerPct    = fresh.trailingTriggerPct;
    if (fresh.trailingDropPct       != null) m.trailingDropPct       = fresh.trailingDropPct;
    if (fresh.partialTakeProfit     !== undefined) m.partialTakeProfit     = fresh.partialTakeProfit;
    if (fresh.partialTpTriggerPct   != null) m.partialTpTriggerPct   = fresh.partialTpTriggerPct;
    if (fresh.partialTpClosePct     != null) m.partialTpClosePct     = fresh.partialTpClosePct;
    if (fresh.pnlSanityMaxDiffPct   != null) m.pnlSanityMaxDiffPct   = fresh.pnlSanityMaxDiffPct;
    if (fresh.solMode               !== undefined) m.solMode               = fresh.solMode;
    const minBinsBelow = numericConfig(fresh.minBinsBelow) ?? config.strategy.minBinsBelow;
    const maxBinsBelow = numericConfig(fresh.maxBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.maxBinsBelow;
    const defaultBinsBelow = numericConfig(fresh.defaultBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.defaultBinsBelow ?? maxBinsBelow;
    config.strategy.minBinsBelow = Math.max(ABS_MIN_BINS_BELOW, Math.round(minBinsBelow));
    config.strategy.maxBinsBelow = Math.max(config.strategy.minBinsBelow, Math.round(maxBinsBelow));
    config.strategy.defaultBinsBelow = Math.max(
      config.strategy.minBinsBelow,
      Math.min(config.strategy.maxBinsBelow, Math.round(defaultBinsBelow)),
    );
  } catch { /* ignore */ }
}
