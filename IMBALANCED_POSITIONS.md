# Imbalanced Position (Zap-In) - Meteora DLMM

Fitur untuk membuat liquidity position dengan imbalanced token amounts menggunakan zap-in flow: sistem otomatis swap sebagian SOL ke token X sebelum deploy.

## Flow Imbalanced Position

**User Input:**
- `amount_x_sol`: Jumlah SOL yang akan di-swap ke token X
- `amount_y`: Jumlah SOL yang akan di-deposit langsung sebagai token Y

**System Process:**
1. Swap `amount_x_sol` SOL → Token X via Jupiter
2. Deploy position dengan: swapped tokens (X) + `amount_y` (SOL)
3. Total SOL digunakan = `amount_x_sol` + `amount_y`

## Perubahan yang Dilakukan

1. **Menambahkan parameter `amount_x_sol`** di `tools/dlmm.js`
2. **Implementasi pre-deploy swap** via Jupiter sebelum deploy
3. **Tracking total SOL used** untuk transparency
4. **Update CLI, tool definitions, dan dokumentasi**

## Cara Penggunaan

### 1. Via CLI (Recommended)

```bash
# Imbalanced position dengan zap-in:
# - 0.3 SOL akan di-swap ke token X
# - 0.5 SOL akan di-deposit sebagai SOL (Y)
# - Total: 0.8 SOL digunakan

meridian deploy \
  --pool <POOL_ADDRESS> \
  --amount-x-sol 0.3 \
  --amount 0.5 \
  --bins-below 10 \
  --bins-above 10 \
  --strategy spot

# Output akan menunjukkan:
# {
#   "success": true,
#   "position": "...",
#   "total_sol_used": 0.8,
#   "pre_swap": {
#     "sol_swapped": 0.3,
#     "tokens_received": 125.5,
#     "token_mint": "..."
#   },
#   "amount_x": 125.5,
#   "amount_y": 0.5,
#   ...
# }

# Single-sided SOL (existing behavior - tidak berubah)
meridian deploy \
  --pool <POOL_ADDRESS> \
  --amount 1.0 \
  --bins-below 69
```

### 2. Via Tool Call (Programmatic)

```javascript
import { deployPosition } from './tools/dlmm.js';

// Contoh imbalanced zap-in
const result = await deployPosition({
  pool_address: "YOUR_POOL_ADDRESS",
  amount_x_sol: 0.3,    // 0.3 SOL → swap to token X
  amount_y: 0.5,        // 0.5 SOL deposit langsung
  bins_below: 10,
  bins_above: 10,
  strategy: "spot",
});

console.log(`Total SOL used: ${result.total_sol_used}`);
console.log(`Tokens received from swap: ${result.pre_swap?.tokens_received}`);
console.log(`Position: ${result.position}`);
```

### 3. Cara Kerja Internal

```javascript
// Step 1: Pre-deploy swap (jika amount_x_sol specified)
if (amount_x_sol) {
  const swapResult = await swapToken({
    input_mint: "SOL",
    output_mint: baseMint,  // Token X dari pool
    amount: amount_x_sol,
  });
  
  // Hasil swap menjadi amount_x
  amount_x = swapResult.amount_out / (10 ** decimals);
}

// Step 2: Deploy position seperti biasa
const tx = await pool.initializePositionAndAddLiquidityByStrategy({
  positionPubKey: newPosition.publicKey,
  user: wallet.publicKey,
  totalXAmount: totalXLamports,  // dari hasil swap
  totalYAmount: totalYLamports,  // dari amount_y
  strategy: { maxBinId, minBinId, strategyType },
  slippage: 1000,
});

// Step 3: Return dengan info lengkap
return {
  success: true,
  position: "...",
  total_sol_used: amount_x_sol + amount_y,  // 0.3 + 0.5 = 0.8
  pre_swap: {
    sol_swapped: 0.3,
    tokens_received: 125.5,
    token_mint: baseMint,
  },
  ...
};
```

## Validasi dan Pembatasan

1. **Imbalanced positions harus specify explicit bin range:**
   ```javascript
   // ✅ BENAR - dengan range
   { amount_x_sol: 0.3, amount_y: 0.5, bins_below: 10, bins_above: 10 }
   
   // ❌ ERROR - imbalanced tanpa range
   { amount_x_sol: 0.3, amount_y: 0.5 }  // akan throw error
   ```

2. **Minimum 35 bins total** - mencegah tiny ranges

3. **Swap requirements:**
   - `amount_x_sol` harus > 0
   - Pool harus memiliki liquidity yang cukup untuk swap
   - Jupiter harus bisa provide route untuk SOL → token X

4. **Token X decimals** - diambil otomatis dari on-chain mint setelah swap

5. **Wide range support** - untuk >69 bins menggunakan chunked transactions

## Contoh Use Case

### Use Case 1: Market Making dengan Balanced Exposure
```bash
# Deploy 50/50 value split dengan auto zap-in
# 0.4 SOL di-convert ke token → ~X tokens (market rate)
# 0.4 SOL tetap sebagai SOL
# Total: 0.8 SOL

meridian deploy \
  --pool TOKEN/SOL_POOL \
  --amount-x-sol 0.4 \
  --amount 0.4 \
  --bins-below 15 \
  --bins-above 15 \
  --strategy spot
```

### Use Case 2: Provide Liquidity dengan SOL Exposure
```bash
# User punya banyak SOL, ingin provide liquidity
# Swap 1.0 SOL ke token untuk imbalanced position
# Deposit 2.0 SOL langsung
# Total: 3.0 SOL

meridian deploy \
  --pool TOKEN/SOL_POOL \
  --amount-x-sol 1.0 \
  --amount 2.0 \
  --downside-pct 20 \
  --upside-pct 10 \
  --strategy bid_ask
```

### Use Case 3: Single-sided SOL (Existing - Tidak Berubah)
```bash
# Mode existing yang sudah ada sebelumnya
meridian deploy \
  --pool TOKEN/SOL_POOL \
  --amount 1.0 \
  --bins-below 69
```

## Testing

Test tanpa on-chain transaction:

```bash
export DRY_RUN=true
meridian deploy --pool <ADDR> --amount-x-sol 0.3 --amount 0.5 --bins-below 10 --bins-above 10
```

Output:
```json
{
  "dry_run": true,
  "would_deploy": {
    "pool_address": "...",
    "strategy": "spot",
    "bins_below": 10,
    "bins_above": 10,
    "amount_x": 0,
    "amount_y": 0.5,
    "total_sol_used": 0.8,
    "pre_swap": {
      "would_swap_sol": 0.3,
      "to_token": "..."
    },
    "wide_range": false
  },
  "message": "DRY RUN — no transaction sent"
}
```

## Catatan Penting

1. **Slippage:** 
   - Swap: default Jupiter slippage
   - Deploy: 10% slippage untuk position creation

2. **Gas:** 
   - 2 transactions minimum: swap + deploy
   - Wide range (>69 bins) membutuhkan multiple deploy transactions

3. **Price Impact:**
   - Swap akan mengalami slippage sesuai pool liquidity
   - Gunakan `amount_x_sol` yang reasonable untuk minimize slippage

4. **Total SOL calculation:**
   - Selalu `amount_x_sol + amount_y`
   - Tidak termasuk gas fees

5. **Error handling:**
   - Jika swap gagal, deploy tidak akan execute
   - Jika deploy gagal, token hasil swap masih ada di wallet

## Advanced: Direct Token Amount (amount_x)

Untuk advanced users yang sudah punya token X di wallet, masih bisa gunakan `amount_x` langsung:

```bash
# Deploy dengan token yang sudah dimiliki
meridian deploy \
  --pool <ADDR> \
  --amount-x 100 \
  --amount 0.5 \
  --bins-below 10 \
  --bins-above 10
```

**Note:** Ini untuk advanced use case. Untuk kebanyakan user, gunakan `amount_x_sol` untuk automatic zap-in.
