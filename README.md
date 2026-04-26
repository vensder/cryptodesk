# CryptoDesk

Electron-based desktop app for crypto charts and OKX loan management.

## Stack

- Electron 31
- TypeScript 6 (strict mode)
- TradingView Lightweight Charts 4.x (CDN, standalone build)
- No bundler — TypeScript compiles directly to JS in-place
- Exchanges: Binance REST API, OKX REST API

## Project structure

```
cryptodesk/
  src/
    main/
      main.ts       # Electron main process
      preload.ts    # Context bridge (IPC)
    renderer/
      index.html    # UI shell
      style.css     # Dark terminal theme
      app.ts        # Chart logic + exchange adapters
  tsconfig.json
  package.json
  README.md
```

`tsc` emits `.js` files alongside each `.ts` source file (no `outDir`). The compiled outputs are not committed — run `npm run build` to generate them.

## Dependencies

### Linux — libsecret (required for keytar)

`keytar` uses libsecret to store API keys in the system keychain. Install it before running `npm install`:

```bash
sudo apt install libsecret-1-dev
```

After installing new native dependencies or switching Electron versions, rebuild native modules:

```bash
npm run rebuild
```

## Setup

```bash
npm install
npm run build   # compile TypeScript → JavaScript
npm start       # build + launch
```

For dev mode (opens DevTools):
```bash
npm run dev
```

## Exchange symbol formats

| Exchange | Example input | Notes |
|----------|--------------|-------|
| Binance  | BTCUSDT      | Standard Binance format |
| OKX      | BTCUSDT or BTC-USDT | Auto-converted to BTC-USDT internally |

## Roadmap

### Phase 1 (done)
- [x] Frameless window with custom titlebar
- [x] Tabbed layout (Charts / OKX Loans)
- [x] Binance klines adapter
- [x] OKX candles adapter
- [x] Candlestick chart via lightweight-charts

### Phase 2
- [x] Volume histogram series below candles
- [ ] Auto-refresh on a configurable interval
- [ ] Persist last-used exchange/symbol/interval

### Phase 3 - OKX Loans tab
- [ ] OKX API key configuration (stored in OS keychain / encrypted local file)
- [ ] Active loan list with LTV ratio indicators
- [ ] Collateral management: add/withdraw
- [ ] Repay / borrow actions

## OKX Loans tab (design notes)

OKX multi-collateral loan endpoints to use:
- `GET /api/v5/account/simulated-margin` - simulate margin
- `GET /api/v5/finance/fixed-loan/lending-orders-list` - active loans
- `POST /api/v5/finance/fixed-loan/repurchase-loan` - repay
- `GET /api/v5/account/positions` - collateral positions

Auth requires API key + secret + passphrase, signed with HMAC-SHA256.


### Appendix

Use nvm to manage npm

```sh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash
nvm install --lts --latest-npm
nvm use --lts
nvm alias default 'lts/*'
```
