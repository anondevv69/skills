---
name: fomofam
description: Operate a fomo.family account headless with a private key — Privy-refresh auth, trending/feeds/balances reads, Solana swaps signed locally with the account's key, public thesis posts. Mirrors the private repo github.com/anondevv69/fomofam.
tags: [fomo, fomo-family, trading, solana, social, thesis]
---

# fomofam — fomo.family account control

Headless control of ONE fomo.family account:

- reads: whoami, balances, trending, token search/details, thesis feeds, own trades
- trades: Solana swaps quoted via FOMO `/swaps/v2`, signed with the account's private key, broadcast via Jito Hudson / FOMO RPC
- social: public thesis posts (a thesis = public comment on one of your own trades)

Flows mirror the private repo `anondevv69/fomofam` (`bot/src/fomo/*`). Unofficial automation against FOMO's private API — own account only.

## Credentials (Bankr terminal sidebar -> Advanced -> Env Vars)

| Env var | Required | What it is |
| --- | --- | --- |
| `FOMO_REFRESH_TOKEN` | yes (or `FOMO_BEARER`) | Privy refresh token: log into fomo.family in Chrome -> F12 -> Application -> Local Storage -> `https://fomo.family` -> key `privy:refresh_token` (the long value; ~30-day life; auto-renews bearer JWTs). |
| `FOMO_PRIVATE_KEY` | for swaps | base58 Solana secret key (64 bytes) of the FOMO account's trading wallet. Signs quoted swap txs locally. |
| `FOMO_PROXY_URL` | strongly recommended | Residential proxy URL (`http://user:pass@host:port`, undici ProxyAgent format). Cloudflare usually 403s datacenter IPs even with Chrome-JA3 impersonation. |
| `FOMO_BEARER` | optional | Short-lived bearer JWT bootstrap instead of the refresh token. |
| `FOMO_API_BASE` | optional | Default `https://prod-api.fomo.family`. |
| `FOMO_DISABLE_CYCLETLS` | optional | `1` to skip the cycletls transport (go straight to proxy/direct). |

NEVER paste these secrets in chat, never echo them in responses.

If Privy rotates the refresh token during a run, the script saves the new value to `./output/fomo-session.json` and prints `REFRESH_TOKEN_ROTATED` — update `FOMO_REFRESH_TOKEN` with that value.

## Running

Always via execute_cli with pinned packages and the skill's script staged:

```
execute_cli({
  commands: ["node scripts/fomo.mjs <command> <args...>"],
  packages: ["cycletls@2.0.5", "@solana/web3.js@1.98.4", "tweetnacl@1.0.3", "undici@8.10.0"],
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
| `auth` | Mint + verify bearer from `FOMO_REFRESH_TOKEN`; prints derived Solana pubkey when `FOMO_PRIVATE_KEY` is set (verify it matches the wallet on FOMO's balances page) |
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
| `swap <buy\|sell> <address> [networkId] <usd\|rawAmount>` | Quote -> fast-fill OR sign+broadcast. buy amount = human USDC; sell amount = raw smallest units |

networkIds: solana `1399811149`, base `8453`, bnb `56`, monad `143`, ethereum `1`, robinhood `4663`.

## How it works (verified against the fomofam repo 2026-08-20 — do not re-derive)

- Auth: `POST https://auth.privy.io/api/v1/sessions` with `{refresh_token}`, headers `privy-app-id: cm6h485o300n3zj9yl6vpedq7`, `privy-client: react-auth:2.5.0`, Origin/Referer `https://fomo.family` -> bearer JWT. Runs automatically at the start of every command.
- FOMO request headers: `Authorization: Bearer <jwt>`, `X-Supported-Chains: 56,143,4663,8453,1399811149`, Origin/Referer fomo.family, Chrome 130 UA. Responses are envelopes `{success, statusCode, message, responseObject}` — the script unwraps `responseObject`.
- Transport order: cycletls (Chrome JA3 `771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0`) -> `FOMO_PROXY_URL` -> direct. A Cloudflare 403 HTML page means the egress IP is blocked — set a residential proxy.
- Swaps: quote leg is ALWAYS Solana USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:1399811149` (even for Base/Robinhood tokens). If the quote returns `v2Swap.relaySwapId` -> `POST /swaps/v2/fast-fill {relaySwapId}` then poll `https://api.relay.link/requests/v2?id=`. Otherwise sign the base64 tx (`v1Swap.swapTransaction` or `v2Swap.relayTransaction.tx`) with `FOMO_PRIVATE_KEY`, attach FOMO's `feePayerSignature`, broadcast to Jito Hudson then FOMO RPC `https://solana-provider-1.prod-edge.fomo.family`.
- EVM-chain quotes need an EIP-712 Privy signature only the FOMO app iframe can produce — headless swaps are Solana-only. The script refuses EVM quotes.
- Thesis: `POST /trades/comment {tradeId, comment, visibility:"public"}`. The account must have a trade on the token first (that's how FOMO thesis works) — `thesis` finds it via `GET /trades?userId=&tokenAddress=`.

## Safety

- `swap` spends real funds — require an explicit user imperative with amount + side before running it.
- Never print `FOMO_PRIVATE_KEY`, the refresh token, or the bearer in responses or logs.
- On Cloudflare 403, do NOT retry-loop — tell the user the egress IP is blocked and that `FOMO_PROXY_URL` (residential) is needed.
