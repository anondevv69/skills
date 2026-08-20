---
name: fomofam
description: Operate a fomo.family account headless with Solana + EVM private keys — Privy-refresh auth, trending/feeds/balances reads, Solana swaps signed locally, public thesis posts. Mirrors the private repo github.com/anondevv69/fomofam.
tags: [fomo, fomo-family, trading, solana, evm, social, thesis]
---

# fomofam — fomo.family account control

Headless control of ONE fomo.family account:

- reads: whoami, balances, trending, token search/details, thesis feeds, own trades
- trades: Solana swaps quoted via FOMO `/swaps/v2`, signed with the account's **Solana** private key, broadcast via Jito Hudson / FOMO RPC
- social: public thesis posts (a thesis = public comment on one of your own trades)

FOMO exports **two** wallets. Use the matching env var for each — do not put the EVM `0x…` key in the Solana slot.

Flows mirror the private repo `anondevv69/fomofam` (`bot/src/fomo/*`). Unofficial automation against FOMO's private API — own account only.

## Credentials (Bankr terminal sidebar -> Advanced -> Env Vars)

| Env var | Required | What it is |
| --- | --- | --- |
| `FOMO_REFRESH_TOKEN` | yes (or `FOMO_BEARER`) | Privy refresh token: log into fomo.family in Chrome -> F12 -> Application -> Local Storage -> `https://fomo.family` -> key `privy:refresh_token` (the long value; ~30-day life; auto-renews bearer JWTs). |
| `FOMO_SOLANA_PRIVATE_KEY` | for Solana swaps | **Solana** wallet export from fomo.family — base58 secret key (64 bytes). Signs quoted Solana swap txs. Alias: `FOMO_PRIVATE_KEY` (same value). |
| `FOMO_EVM_PRIVATE_KEY` | optional | **EVM** wallet export from fomo.family — hex `0x` + 64 hex chars. Used for address matching on `auth`; FOMO EVM EIP-712 authorize is not headless yet. |
| `FOMO_PROXY_URL` | strongly recommended | Residential proxy URL (`http://user:pass@host:port`, undici ProxyAgent format). Cloudflare usually 403s datacenter IPs even with Chrome-JA3 impersonation. |
| `FOMO_BEARER` | optional | Short-lived bearer JWT bootstrap instead of the refresh token. |
| `FOMO_API_BASE` | optional | Default `https://prod-api.fomo.family`. |
| `FOMO_DISABLE_CYCLETLS` | optional | `1` to skip the cycletls transport (go straight to proxy/direct). |

### Which key goes where

| FOMO export UI | Format | Env var |
| --- | --- | --- |
| Solana wallet | base58 (no `0x`) | `FOMO_SOLANA_PRIVATE_KEY` |
| EVM wallet | `0x` + 64 hex | `FOMO_EVM_PRIVATE_KEY` |

If `auth` reports `solanaKeyError` about an EVM hex key, you put the wrong export in the Solana slot — swap them.

NEVER paste these secrets in chat, never echo them in responses.

If Privy rotates the refresh token during a run, the script saves the new value to `./output/fomo-session.json` and prints `REFRESH_TOKEN_ROTATED` — update `FOMO_REFRESH_TOKEN` with that value.

## Running

Always via execute_cli with pinned packages and the skill's script staged:

```
execute_cli({
  commands: ["node scripts/fomo.mjs <command> <args...>"],
  packages: ["cycletls@2.0.5", "@solana/web3.js@1.98.4", "tweetnacl@1.0.3", "undici@8.10.0", "ethers@6.13.5"],
  filesFromSkill: [{ skill: "fomofam" }],
  includeEnvVars: true,
  workDir: "fomofam",
  timeoutMs: 180000,
  waitMs: 10000
})
```

If the task backgrounds, tail with tail_cli.

## Commands

| Command | What it does |
| --- | --- |
| `auth` | Mint + verify bearer; print Solana pubkey + EVM address when keys are set; compare to FOMO `/balances` wallets |
| `whoami` | Logged-in user (handle, uuid) |
| `balances` | Cash + positions (`/v2/users/{id}/balances`) |
| `trending` | FOMO trending tokens |
| `search <phrase>` | Token search |
| `token <address> [networkId]` | Token details (networkId defaults to Solana) |
| `thesis-feed <address> [networkId]` | Public theses on a token |
| `my-trades [tokenAddress]` | Your trades (trade ids are what thesis attaches to) |
| `post-thesis <tradeId> <text...>` | Public comment on a specific trade |
| `thesis <address> <networkId> <text...>` | Finds your trade on the token, then posts the thesis |
| `quote <buy\|sell> <address> [networkId] <usd\|rawAmount>` | Dry quote via `/swaps/v2` |
| `swap <buy\|sell> <address> [networkId] <usd\|rawAmount>` | Quote -> fast-fill OR Solana key-sign + broadcast |

networkIds: solana `1399811149`, base `8453`, bnb `56`, monad `143`, ethereum `1`, robinhood `4663`.

## How it works (verified against the fomofam repo 2026-08-20 — do not re-derive)

- Auth: `POST https://auth.privy.io/api/v1/sessions` with `{refresh_token}`, headers `privy-app-id: cm6h485o300n3zj9yl6vpedq7`, `privy-client: react-auth:2.5.0`, Origin/Referer `https://fomo.family` -> bearer JWT. Runs automatically at the start of every command.
- FOMO request headers: `Authorization: Bearer <jwt>`, `X-Supported-Chains: 56,143,4663,8453,1399811149`, Origin/Referer fomo.family, Chrome 130 UA. Responses are envelopes `{success, statusCode, message, responseObject}` — the script unwraps `responseObject`.
- Transport order: cycletls (Chrome JA3) -> `FOMO_PROXY_URL` -> direct. A Cloudflare 403 HTML page means the egress IP is blocked — set a residential proxy.
- Swaps: quote leg is ALWAYS Solana USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:1399811149` (even for Base/Robinhood tokens). If the quote returns `v2Swap.relaySwapId` -> try `POST /swaps/v2/fast-fill`. On failure or SOLANA_V1, sign the base64 tx with `FOMO_SOLANA_PRIVATE_KEY`, attach FOMO's `feePayerSignature`, broadcast to Jito Hudson then FOMO RPC.
- Pure `Relay: EVM` quotes still need FOMO app EIP-712 — `FOMO_EVM_PRIVATE_KEY` is stored/verified on `auth` but does not unlock that path yet. Prefer quotes that leave a Solana tx to sign (common for Robinhood buys funded from SOL-USDC).
- Thesis: `POST /trades/comment {tradeId, comment, visibility:"public"}`. Needs `FOMO_REFRESH_TOKEN` only (no private key). Account must already have a trade on the token.

## Safety

- `swap` spends real funds — require an explicit user imperative with amount + side before running it.
- Never print private keys, the refresh token, or the bearer in responses or logs.
- On Cloudflare 403, do NOT retry-loop — tell the user the egress IP is blocked and that `FOMO_PROXY_URL` (residential) is needed.
- The Solana key must derive to the same address as the FOMO Solana wallet (`auth` → `solanaMatchesFomo: true`). Never use a key from a different account to impersonate another Privy wallet.
