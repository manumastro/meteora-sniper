# 📄 Paper Trading - Documentazione Tecnica

## Panoramica

Il modulo **Paper Trading** è un sistema di trading simulato progettato per testare strategie di sniping su Meteora DAMM-V2 senza rischiare fondi reali. Il sistema monitora in tempo reale le migrazioni di token e simula operazioni di acquisto e vendita basate su criteri predefiniti.

---

## Architettura del Sistema

```
┌─────────────────────────────────────────────────────────────────┐
│                     Paper Trading System                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐    ┌──────────────┐    ┌─────────────────┐    │
│  │  WebSocket  │───▶│  Migration   │───▶│  Trade Entry    │    │
│  │  Listener   │    │  Detection   │    │  Simulation     │    │
│  └─────────────┘    └──────────────┘    └─────────────────┘    │
│         │                                        │              │
│         │                                        ▼              │
│         │           ┌──────────────┐    ┌─────────────────┐    │
│         │           │  DexScreener │◀───│  Price          │    │
│         │           │  API         │    │  Monitoring     │    │
│         │           └──────────────┘    └─────────────────┘    │
│         │                  │                     │              │
│         │                  ▼                     ▼              │
│         │           ┌──────────────┐    ┌─────────────────┐    │
│         └──────────▶│  Dashboard   │◀───│  P/L            │    │
│                     │  Display     │    │  Calculation    │    │
│                     └──────────────┘    └─────────────────┘    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Configurazione

### Costanti di Sistema

| Parametro | Valore Default | Descrizione |
|-----------|----------------|-------------|
| `PAPER_TRADE_AMOUNT_SOL` | `0.01` | Importo in SOL simulato per ogni trade |
| `MAX_POSITIONS` | `100` | Numero massimo di posizioni attive contemporanee |
| `TAKE_PROFIT_PERCENT` | `100` | Percentuale di profitto per chiudere automaticamente (100% = 2x) |
| `PRICE_CHECK_INTERVAL_MS` | `2000` | Intervallo di aggiornamento prezzi (millisecondi) |
| `MIN_LIQUIDITY_SOL` | `10` | Liquidità minima in SOL richiesta per entrare in una posizione |

### Variabili d'Ambiente Richieste

```env
SVS_UNSTAKED_WSS=wss://your-rpc-websocket-endpoint
SVS_UNSTAKED_RPC=https://your-rpc-endpoint
```

---

## Struttura Dati

### Interface `PaperTrade`

```typescript
interface PaperTrade {
    tokenMint: string;          // Indirizzo del token
    entryTime: Date;            // Timestamp di ingresso
    entrySignature: string;     // Firma della transazione di migrazione
    simulatedSolSpent: number;  // SOL simulati spesi
    simulatedUsdSpent: number;  // USD simulati spesi
    simulatedTokenAmount: number; // Quantità token simulata acquistata
    entryPrice: number;         // Prezzo di ingresso in SOL
    entryPriceUsd: number;      // Prezzo di ingresso in USD
    currentPrice: number;       // Prezzo corrente in SOL
    currentPriceUsd: number;    // Prezzo corrente in USD
    lastUpdateTime: Date;       // Ultimo aggiornamento
    profitLossPercent: number;  // P/L percentuale
    profitLossSol: number;      // P/L in SOL
    profitLossUsd: number;      // P/L in USD
    transactionCount: number;   // Contatore aggiornamenti
    status: 'ACTIVE' | 'CLOSED'; // Stato posizione
    exitReason?: string;        // Motivo chiusura (se applicabile)
}
```

---

## Componenti Principali

### 1. Migration Detection (`handleMigrationWssData`)

Questa funzione gestisce i messaggi WebSocket in arrivo dal nodo RPC e rileva le migrazioni di token.

**Flusso:**
1. Riceve dati WebSocket
2. Verifica che non si sia raggiunto `MAX_POSITIONS`
3. Parsifica i log della transazione
4. Cerca match con `PROGRAM_META_LOGS` (identificatori migrazione)
5. Estrae il token mint dalla transazione
6. Calcola il prezzo iniziale

**Criteri di Filtro:**
- Posizioni attive < `MAX_POSITIONS`
- Token non già presente in posizioni attive
- Liquidità SOL >= `MIN_LIQUIDITY_SOL`

### 2. Price Calculation (`calculateTokenPrice`)

Calcola il prezzo del token dalla transazione di migrazione analizzando i bilanci pre/post.

**Logica:**
```
prezzo = volume_WSOL / volume_token
```

Dove il volume è calcolato come:
```
volume = Σ|post_balance - pre_balance| / 2
```

### 3. Price Monitoring (`startPriceMonitoring`)

Loop asincrono che aggiorna i prezzi ogni `PRICE_CHECK_INTERVAL_MS` millisecondi.

**Operazioni:**
1. Recupera prezzi da DexScreener per tutti i token attivi
2. Aggiorna `currentPrice` e `currentPriceUsd`
3. Ricalcola P/L per ogni posizione
4. Verifica condizioni Take Profit
5. Sposta posizioni chiuse da `activeTrades` a `closedTrades`
6. Aggiorna dashboard

### 4. DexScreener Integration (`getPricesFromDexScreener`)

Recupera prezzi in tempo reale dall'API DexScreener.

**Endpoint:**
```
https://api.dexscreener.com/latest/dex/tokens/{mint1},{mint2},...
```

**Preferenze:**
- Priorità a pair quotati in SOL/WSOL
- Fallback su qualsiasi pair disponibile

### 5. Dashboard Display (`displayTradeStatus`)

Visualizza lo stato del paper trading in console con formattazione avanzata.

**Sezioni:**
- Header con PNL totale (attivo + realizzato)
- Tabella posizioni attive con link GMGN
- Tabella ultime 5 posizioni chiuse

---

## Simulazione Swap

Per ogni migrazione rilevata, viene eseguita una simulazione di swap (dry run) per validare che l'esecuzione sarebbe stata possibile.

**Flusso:**
1. Estrazione Pool Address dagli account della transazione
2. Fallback: derivazione Pool Address tramite `getComputedPoolAddress`
3. Creazione transazione swap simulata via `createSwapTransaction`
4. Logging tempo di esecuzione

**Nota:** Se la simulazione fallisce, il processo termina con `process.exit(1)` per segnalare problemi nell'infrastruttura.

### Funzione `createSwapTransaction`

La funzione `createSwapTransaction` (definita in `execution.ts`) costruisce una transazione di swap su Meteora CP-AMM V2 **senza eseguirla**. Restituisce la transazione pronta per la firma e una stima dell'output.

#### Flusso Operativo

| Step | Operazione | Descrizione |
|------|------------|-------------|
| 1️⃣ | Init Client | Inizializza il client Meteora `CpAmm` |
| 2️⃣ | Fetch Pool State | Recupera lo stato del pool (`fetchPoolState`) |
| 3️⃣ | Determine Tokens | Determina quale token è input (A o B) e quale è output |
| 4️⃣ | Get Decimals | Ottiene i decimals dei token coinvolti via `getMint` |
| 5️⃣ | Get Quote | Calcola la quote (stima output + minimo con slippage) |
| 6️⃣ | Build Transaction | Costruisce la transazione di swap pronta per la firma |

#### Signature

```typescript
async function createSwapTransaction(
    connection: Connection,
    payerPublicKey: PublicKey,
    poolAddress: string,
    inputTokenMint: string,
    inputAmountLamports: number,
    slippagePercent: number = 1.0
): Promise<{ transaction: Transaction; estimatedOutput: number } | null>
```

#### Parametri

| Parametro | Tipo | Descrizione |
|-----------|------|-------------|
| `connection` | `Connection` | Connessione RPC Solana |
| `payerPublicKey` | `PublicKey` | Chiave pubblica del wallet che paga |
| `poolAddress` | `string` | Indirizzo del pool Meteora |
| `inputTokenMint` | `string` | Mint del token in ingresso (es. WSOL) |
| `inputAmountLamports` | `number` | Quantità in lamports da swappare |
| `slippagePercent` | `number` | Slippage tollerato in % (default: 1.0) |

#### Return Value

```typescript
{
    transaction: Transaction;    // Transazione pronta per la firma
    estimatedOutput: number;     // Stima quantità token in uscita
} | null                         // null se fallisce
```

#### Uso nel Paper Trading

Nel contesto del paper trading, `createSwapTransaction` viene usata esclusivamente per **validazione**:

```typescript
const simPayer = Keypair.generate();  // Wallet simulato
const swapLamports = Math.floor(PAPER_TRADE_AMOUNT_SOL * 1_000_000_000);

const res = await createSwapTransaction(
    connection, 
    simPayer.publicKey, 
    poolAddr, 
    WSOL, 
    swapLamports
);
```

**Scopo della simulazione:**
- ✅ Verifica che il pool esista e abbia stato valido
- ✅ Conferma che la quote può essere calcolata
- ✅ Valida che la transazione può essere costruita
- ❌ **NON** invia la transazione on-chain

#### Differenza con Trading Reale

| Contesto | Comportamento |
|----------|---------------|
| **Paper Trading** | La transazione viene solo costruita, mai inviata. Serve a validare la fattibilità tecnica dello swap. |
| **Trading Reale** | La transazione viene costruita e poi inviata on-chain tramite `executeJitoSwap` per esecuzione effettiva. |

#### Gestione Errori

Se `createSwapTransaction` restituisce `null` nel paper trading:
```typescript
if (res) {
    console.log(`⚡ [SIMULATION SUCCESS] Swap Tx Built in ${duration}ms!`);
} else {
    console.error(`❌ [SIMULATION FAILED] Could not build Swap Tx`);
    process.exit(1);  // Termina il processo
}
```

Il fallimento indica un problema critico nell'infrastruttura (pool non trovato, RPC non raggiungibile, SDK non compatibile) che richiede investigazione.

---

## Formattazione Prezzi

La funzione `formatPrice` gestisce la visualizzazione di prezzi molto piccoli usando notazione subscript.

**Esempio:**
```
0.000000461 → 0.0₆461 SOL
```

**Mapping Subscript:**
```typescript
const subscripts = {
    '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
    '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉'
};
```

---

## Gestione Errori

### WebSocket Reconnection

In caso di disconnessione WebSocket:
```typescript
migrationWsClient.on("close", () => {
    setTimeout(() => startPaperTrading(), 5000);
});
```

**Comportamento:** Riconnessione automatica dopo 5 secondi.

### Transaction Retry

Recupero transazioni con retry automatico:
```typescript
async function getTransactionWithRetry(connection, signature, retries = 3)
```

**Parametri:**
- `retries`: Numero massimo tentativi (default: 3)
- Delay tra retry: 1000ms

---

## Metriche e KPI

### PNL Tracking

| Metrica | Descrizione |
|---------|-------------|
| `activePnL` | Somma P/L di tutte le posizioni attive |
| `realizedPnL` | Somma P/L di tutte le posizioni chiuse |
| `totalPnL` | `activePnL + realizedPnL` |

### Condizioni di Uscita

| Condizione | Trigger | Exit Reason |
|------------|---------|-------------|
| Take Profit | `profitLossPercent >= TAKE_PROFIT_PERCENT` | `TP Hit (+X%)` |

---

## Dipendenze

```json
{
  "ws": "WebSocket client",
  "axios": "HTTP client per DexScreener",
  "@solana/web3.js": "SDK Solana",
  "dotenv": "Gestione variabili ambiente"
}
```

---

## Utilizzo

### Avvio

```bash
npx ts-node src/paperTrading.ts
```

### Output Console

```
================================================================================
🎮 PAPER TRADING MODE (JUPITER API EDITION)
================================================================================
💰 Simulated investment per trade: 0.01 SOL
🎯 Waiting for first token migration...
================================================================================

⏳ Waiting for token migrations...
```

### Dashboard Attiva

```
==================================================================
🎮 PAPER TRADING DASHBOARD - 10:30:45
Active Positions: 3/100
Active Unrealized PNL: +0.0234 SOL
Total Realized PNL:    +0.0156 SOL
GRAND TOTAL PNL:       +0.0390 SOL
==================================================================

🚀 ACTIVE TRADES:
------------------------------------------------------------------
| GMGN Link                    | Time  | Entry      | Curr       | PNL      |
------------------------------------------------------------------
| https://gmgn.ai/sol/token/...| 2m30s | 0.0₆461    | 0.0₆789    | +71.2%   |
------------------------------------------------------------------
```

---

## Best Practices

1. **Monitoraggio Continuo:** Tenere sempre attivo il paper trading per raccogliere dati statistici
2. **Analisi P/L:** Rivedere periodicamente le posizioni chiuse per affinare parametri
3. **Liquidità:** Aumentare `MIN_LIQUIDITY_SOL` per filtrare pool con scarsa liquidità
4. **Take Profit:** Regolare `TAKE_PROFIT_PERCENT` basandosi sui dati storici

---

## Limitazioni Note

- **Slippage non simulato:** Il prezzo di ingresso teorico potrebbe differire da quello reale
- **Gas fees non incluse:** Le fee di transazione non sono considerate nel P/L
- **Latency:** Il rilevamento migrazione dipende dalla latenza del nodo RPC
- **Rate Limiting:** L'API DexScreener può limitare le richieste in caso di uso intensivo

---

## Changelog

| Versione | Data | Modifiche |
|----------|------|-----------|
| 1.0.0 | 2024-12 | Versione iniziale con supporto DAMM-V2 |
