# Meteora Sniper - Guida all'Avvio

## Prerequisiti

### 1. Configurazione `.env`

Crea un file `.env` nella root del progetto:

```env
# RPC Endpoints (Solana Validator - consigliato per velocità)
SVS_UNSTAKED_WSS=wss://your-rpc-endpoint.com
SVS_UNSTAKED_RPC=https://your-rpc-endpoint.com

# Wallet (chiave privata in formato Base58)
PRIVATE_KEY=tua_chiave_privata_base58

# Jito Configuration
JITO_TIP_AMOUNT=0.001   # Tip in SOL (0.001-0.003 consigliato)
```

### 2. Saldo Wallet

Il wallet deve contenere:

| Voce | Importo Minimo |
|------|----------------|
| Trade | 0.01 SOL (configurabile) |
| Jito Tip | ~0.001 SOL |
| Fee TX | ~0.00005 SOL |
| **Buffer consigliato** | **0.02+ SOL** |

---

## Parametri di Trading

I parametri sono configurabili in `src/meteoraSniper.ts`:

```typescript
const TRADE_AMOUNT_SOL = 0.01;      // Importo per trade
const MAX_POSITIONS = 1;            // Max posizioni contemporanee
const STOP_LOSS_PERCENT = 30;       // Stop loss a -30%
const MIN_LIQUIDITY_SOL = 10;       // Liquidità minima per entrare
```

---

## Avvio

### Paper Trading (simulato)
```bash
npm run paperTrading
```

### Sniper Reale
```bash
npm run sniper
```

---

## Comportamento

1. **Monitoraggio**: Ascolta le migrazioni da entrambi i keeper Meteora
2. **Selezione Jito Engine**: Sceglie automaticamente il block engine con latenza minore
3. **Esecuzione**: Invia bundle Jito per massimizzare la velocità di inclusione
4. **Monitoraggio PNL**: Controlla il prezzo ogni 2 secondi
5. **Stop Loss**: Vende automaticamente se il prezzo scende sotto la soglia

---

## Migration Keepers Monitorati

| Keeper | Indirizzo |
|--------|-----------|
| Keeper 1 | `CQdrEsYAxRqkwmpycuTwnMKggr3cr9fqY8Qma4J9TudY` |
| Keeper 2 | `DeQ8dPv6ReZNQ45NfiWwS5CchWpB2BVq1QMyNV8L2uSW` |

---

## Troubleshooting

### Errore: "Block not available for slot"
Questo è un errore temporaneo dell'RPC. Il bot continuerà a funzionare.

### Errore: "429 Rate Limit"
L'RPC sta limitando le richieste. Il bot farà back-off automatico.

### Errore: "No Jito Tip Accounts"
Problema di connessione a Jito. Riavvia il bot.

---

## Configurazione Wallet Phantom

### Esportare la Chiave Privata

1. Apri **Phantom** → clicca sull'icona **⚙️ Impostazioni**
2. Vai su **Sicurezza e Privacy**
3. Clicca **Esporta Chiave Privata**
4. Inserisci la password di Phantom
5. Copia la chiave (formato Base58)
6. Incollala nel file `.env`:
   ```env
   PRIVATE_KEY=tua_chiave_privata_base58
   ```

> ⚠️ **ATTENZIONE**: Non condividere MAI la chiave privata. Chi la possiede può svuotare il wallet.

---

## Monitoraggio Trade su GMGN

### Trovare l'Indirizzo Pubblico

In Phantom:
1. Clicca sul nome del wallet in alto
2. Clicca sull'icona **copia** accanto all'indirizzo

### Visualizzare su GMGN

Vai su:
```
https://gmgn.ai/sol/address/<TUO_INDIRIZZO>
```

Esempio: `https://gmgn.ai/sol/address/7xK3abc123...`

Vedrai in tempo reale:
- **Portfolio** con tutti i token
- **Attività** con gli ultimi trade
- **PNL** realizzato e non realizzato
