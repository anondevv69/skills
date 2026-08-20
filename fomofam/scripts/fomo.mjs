#!/usr/bin/env node
/**
 * fomofam — headless fomo.family account control.
 * Mirrors anondevv69/fomofam (bot/src/fomo/*) flows:
 *   Privy refresh -> bearer JWT -> FOMO private API (Chrome-JA3 / proxy / direct)
 *   /swaps/v2 quote -> fast-fill OR locally-key-signed Solana tx -> broadcast
 * Env: FOMO_REFRESH_TOKEN, FOMO_PRIVATE_KEY, FOMO_PROXY_URL, FOMO_BEARER,
 *      FOMO_API_BASE, FOMO_DISABLE_CYCLETLS
 */
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, chmodSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import nacl from "tweetnacl";
import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const CHROME_JA3 =
  "771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0";
const FOMO_API_BASE = process.env.FOMO_API_BASE || "https://prod-api.fomo.family";
const SUPPORTED_CHAINS = "56,143,4663,8453,1399811149";
const PRIVY_APP_ID = "cm6h485o300n3zj9yl6vpedq7";
const PRIVY_AUTH_API = "https://auth.privy.io";
const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA_NETWORK_ID = 1399811149;
const HUDSON =
  "https://mainnet.hudson.jito.wtf/api/v1/sendTransactionWeb?mev_protection_default=true";
const FOMO_RPC = "https://solana-provider-1.prod-edge.fomo.family";
const SESSION_PATH = path.join(process.cwd(), "output", "fomo-session.json");

/* ── base58 ─────────────────────────────────────────────────────────────── */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s) {
  const bytes = [0];
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) throw new Error("bad base58 char: " + c);
    let carry = v;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const c of s) { if (c === "1") bytes.push(0); else break; }
  return Uint8Array.from(bytes.reverse());
}
function b58encode(bytes) {
  if (!bytes.length) return "";
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] * 256;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let zeros = 0;
  for (const b of bytes) { if (b === 0) zeros++; else break; }
  return "1".repeat(zeros) + digits.reverse().map((d) => B58[d]).join("");
}

/* ── jwt helpers ────────────────────────────────────────────────────────── */
function jwtPayload(token) {
  try {
    const part = token.split(".")[1];
    if (!part) return {};
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch { return {}; }
}
function jwtExpMs(token) {
  const exp = jwtPayload(token).exp;
  return typeof exp === "number" ? exp * 1000 : null;
}

/* ── session state ──────────────────────────────────────────────────────── */
const state = { bearer: "", refreshToken: "" };

function loadSession() {
  state.refreshToken = (process.env.FOMO_REFRESH_TOKEN || "").trim();
  state.bearer = (process.env.FOMO_BEARER || "").trim().replace(/^Bearer\s+/i, "");
  if (existsSync(SESSION_PATH)) {
    try {
      const s = JSON.parse(readFileSync(SESSION_PATH, "utf8"));
      if (!state.bearer && s.bearer && (jwtExpMs(s.bearer) ?? 0) > Date.now() + 60_000) {
        state.bearer = s.bearer;
      }
      if (!state.refreshToken && s.refreshToken) state.refreshToken = String(s.refreshToken);
    } catch { /* ignore */ }
  }
}

function saveSession() {
  try {
    mkdirSync(path.dirname(SESSION_PATH), { recursive: true });
    writeFileSync(
      SESSION_PATH,
      JSON.stringify({ bearer: state.bearer, refreshToken: state.refreshToken, updatedAt: Date.now() }, null, 2),
      { mode: 0o600 }
    );
  } catch { /* ignore */ }
}

/* ── transports ─────────────────────────────────────────────────────────── */
function isCfBlock(status, text) {
  return status === 403 && /cloudflare|attention required|just a moment|cf-ray/i.test(text || "");
}

let cycletlsClient = null;
let cycletlsFailedAt = 0;

async function getCycletls() {
  if (process.env.FOMO_DISABLE_CYCLETLS === "1") return null;
  if (cycletlsFailedAt && Date.now() - cycletlsFailedAt < 5 * 60_000) return null;
  if (!cycletlsClient) {
    try {
      const req = createRequire(import.meta.url);
      const mod = await import("cycletls");
      const init = typeof mod.default === "function" ? mod.default : mod.default?.default;
      if (typeof init !== "function") throw new Error("cycletls default export missing");
      const PLATFORM = {
        win32: { x64: "index.exe" },
        linux: { arm: "index-arm", arm64: "index-arm64", x64: "index" },
        darwin: { x64: "index-mac", arm: "index-mac-arm", arm64: "index-mac-arm64" },
      };
      let executablePath;
      try {
        const f = PLATFORM[process.platform]?.[os.arch()];
        if (f) {
          const dir = path.dirname(req.resolve("cycletls/package.json"));
          const src = path.join(dir, "dist", f);
          if (existsSync(src)) {
            if (/\s/.test(src)) {
              const dest = path.join(os.tmpdir(), "fomofam-cycletls");
              copyFileSync(src, dest);
              chmodSync(dest, 0o755);
              executablePath = dest;
            } else executablePath = src;
          }
        }
      } catch { /* fall back to default resolution */ }
      cycletlsClient = await init({ timeout: 30_000, ...(executablePath ? { executablePath } : {}) });
    } catch (e) {
      cycletlsFailedAt = Date.now();
      console.error("[cycletls] init failed:", e.message);
      return null;
    }
  }
  return cycletlsClient;
}

async function plainHttp(method, url, headers, body) {
  const { fetch: ufetch, ProxyAgent } = await import("undici");
  const proxy = process.env.FOMO_PROXY_URL;
  const res = await ufetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(45_000),
    ...(proxy ? { dispatcher: new ProxyAgent({ uri: proxy }) } : {}),
  });
  return { status: res.status, text: await res.text().catch(() => ""), via: proxy ? "proxy" : "direct" };
}

async function transportFetch(method, url, headers, body) {
  const client = await getCycletls();
  if (client) {
    try {
      const res = await client(
        url,
        { ja3: CHROME_JA3, userAgent: CHROME_UA, headers, body, disableRedirect: false },
        method.toLowerCase()
      );
      let text = "";
      try { text = await res.text(); }
      catch { text = typeof res.data === "string" ? res.data : JSON.stringify(res.data ?? ""); }
      if (!isCfBlock(res.status, text)) return { status: res.status, text, via: "cycletls" };
      console.error("[fomo] cycletls CF-blocked — falling back");
    } catch (e) {
      console.error("[fomo] cycletls failed:", e.message, "— falling back");
    }
  }
  return plainHttp(method, url, headers, body);
}

/* ── privy auth ─────────────────────────────────────────────────────────── */
async function refreshPrivy() {
  if (!state.refreshToken) return false;
  const headers = {
    "Content-Type": "application/json",
    "privy-app-id": PRIVY_APP_ID,
    "privy-client": "react-auth:2.5.0",
    Origin: "https://fomo.family",
    Referer: "https://fomo.family/",
    "User-Agent": CHROME_UA,
  };
  const body = JSON.stringify({ refresh_token: state.refreshToken });
  let out = await plainHttp("POST", `${PRIVY_AUTH_API}/api/v1/sessions`, headers, body);
  if (out.status >= 400) {
    const did = jwtPayload(state.bearer).sub;
    if (did) {
      out = await plainHttp(
        "POST",
        `${PRIVY_AUTH_API}/api/v1/users/${encodeURIComponent(did)}/sessions`,
        headers,
        body
      );
    }
  }
  if (out.status < 200 || out.status >= 300) {
    throw new Error(`Privy refresh failed ${out.status}: ${out.text.slice(0, 160)}`);
  }
  let data = {};
  try { data = JSON.parse(out.text); } catch { throw new Error("Privy refresh returned non-JSON"); }
  const token = String(data.token || "").trim();
  if (!token) throw new Error("Privy refresh ok but no token");
  state.bearer = token;
  if (String(data.refresh_token || "").trim() && data.refresh_token !== state.refreshToken) {
    state.refreshToken = String(data.refresh_token).trim();
    console.log("REFRESH_TOKEN_ROTATED — new value saved to output/fomo-session.json; update FOMO_REFRESH_TOKEN env var");
  }
  saveSession();
  return true;
}

async function ensureBearer() {
  if (state.bearer && (jwtExpMs(state.bearer) ?? 0) > Date.now() + 5 * 60_000) return;
  await refreshPrivy();
}

/* ── fomo api ───────────────────────────────────────────────────────────── */
function unwrap(json) {
  return json && typeof json === "object" && json.responseObject != null
    ? json.responseObject
    : json;
}

async function fomoFetch(p, opts = {}) {
  await ensureBearer();
  const url = p.startsWith("http") ? p : `${FOMO_API_BASE}${p.startsWith("/") ? p : `/${p}`}`;
  const method = (opts.method || "GET").toUpperCase();
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${state.bearer}`,
    "X-Supported-Chains": SUPPORTED_CHAINS,
    Origin: "https://fomo.family",
    Referer: "https://fomo.family/",
    "User-Agent": CHROME_UA,
  };
  const body = opts.body != null ? JSON.stringify(opts.body) : undefined;
  let out = await transportFetch(method, url, headers, body);
  if (out.status === 401) {
    if (await refreshPrivy().catch(() => false)) {
      headers.Authorization = `Bearer ${state.bearer}`;
      out = await transportFetch(method, url, headers, body);
    }
  }
  if (isCfBlock(out.status, out.text)) {
    throw new Error(
      `Cloudflare blocked via ${out.via} — egress IP is datacenter-blocked. Set FOMO_PROXY_URL (residential proxy) and retry.`
    );
  }
  if (out.status === 401) {
    throw new Error("FOMO 401 — session dead. Update FOMO_REFRESH_TOKEN from fomo.family DevTools.");
  }
  if (out.status >= 400) throw new Error(`FOMO ${out.status}: ${out.text.slice(0, 200)}`);
  let json = {};
  try { json = JSON.parse(out.text); } catch { /* keep {} */ }
  if (json.success === false || (typeof json.statusCode === "number" && json.statusCode >= 400)) {
    throw new Error(`FOMO error: ${json.message || out.text.slice(0, 200)}`);
  }
  return unwrap(json);
}

/* ── parsing (loose, FOMO shapes drift) ─────────────────────────────────── */
const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));

function parseUser(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const u = o.user && typeof o.user === "object" ? o.user : o;
  return {
    id: str(u.id) || str(u.uuid) || str(u.userId),
    handle: str(u.handle) || str(u.userHandle) || str(u.username),
    name: str(u.displayName) || str(u.name),
  };
}

function parseTokenList(raw) {
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.tokens) ? raw.tokens : [];
  return rows.map((t) => ({
    symbol: str(t.symbol),
    name: str(t.name),
    address: str(t.address) || str(t.tokenAddress) || str(t.mint),
    networkId: Number(t.networkId ?? t.chainId ?? SOLANA_NETWORK_ID),
    priceUsd: t.priceUsd ?? t.price ?? null,
    marketCap: t.marketCap ?? t.mcap ?? null,
    liquidity: t.liquidity ?? t.liquidityUsd ?? null,
  })).filter((t) => t.address);
}

let cachedSelfId = "";

async function currentUserId() {
  if (cachedSelfId) return cachedSelfId;
  for (const p of ["/v2/users/current", "/v2/users/me"]) {
    try {
      const u = parseUser(await fomoFetch(p));
      if (u.id) { cachedSelfId = u.id; return u.id; }
    } catch (e) {
      if (!/404/.test(e.message)) throw e;
    }
  }
  const hint = jwtPayload(state.bearer);
  for (const k of ["fomoUserId", "fomo_user_id", "userId", "user_id", "uid", "fid"]) {
    if (typeof hint[k] === "string" && hint[k].length >= 8) { cachedSelfId = hint[k]; return hint[k]; }
  }
  throw new Error("Could not resolve FOMO user id");
}

/* ── swaps ──────────────────────────────────────────────────────────────── */
function tokenId(networkId, address) {
  let a = String(address).trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(a)) a = a.toLowerCase();
  return `${a}:${Number(networkId)}`;
}
const QUOTE_USDC = tokenId(SOLANA_NETWORK_ID, SOLANA_USDC);

function parseQuote(ro) {
  const v2 = ro?.v2Swap || null;
  const v1 = ro?.v1Swap || null;
  const v2Relay = v2?.relayTransaction || null;
  const relay = v2Relay || v1;
  const relaySwapId = str(v2?.relaySwapId);
  const relayType = str(v2Relay?.type) || (relaySwapId ? "SOLANA" : "") || (v1 ? "SOLANA_V1" : "");
  const v1Tx = str(v1?.swapTransaction) || str(v2Relay?.tx) || str(relay?.tx);
  return {
    relayType: relayType || "unknown",
    relaySwapId,
    v1Tx,
    feePayerSignature: str(v1?.feePayerSignature) || str(v2Relay?.feePayerSignature),
    feePayerAddress: str(v1?.feePayerAddress) || str(v2Relay?.feePayerAddress),
    expectedOut: str(v2?.expectedOutHumanAmount) || str(v1?.expectedOutHumanAmount),
    usd: v2?.swapUsdValue ?? v1?.swapUsdValue ?? null,
    impact: v2?.priceImpactPct ?? v1?.priceImpactPct ?? null,
  };
}

async function quoteSwap(address, networkId, side, amountArg) {
  const token = tokenId(networkId, address);
  const amount = side === "sell"
    ? String(amountArg).trim()
    : String(Math.round(Number(amountArg) * 1e6));
  if (!/^\d+$/.test(amount) || amount === "0") throw new Error("Invalid amount: " + amountArg);
  const inTokenId = side === "buy" ? QUOTE_USDC : token;
  const outTokenId = side === "buy" ? token : QUOTE_USDC;
  let best = null;
  for (const retry of [0, 1, 2]) {
    const ro = await fomoFetch("/swaps/v2", { method: "POST", body: { inTokenId, outTokenId, amount, retry } });
    const probe = parseQuote(ro);
    best = probe;
    if (probe.relaySwapId) break;
  }
  return best;
}

function loadKeyPair() {
  const pk = (process.env.FOMO_PRIVATE_KEY || "").trim();
  if (!pk) throw new Error("FOMO_PRIVATE_KEY not set");
  const bytes = b58decode(pk);
  const secretKey = bytes.length === 64 ? bytes : nacl.sign.keyPair.fromSeed(bytes).secretKey;
  const kp = nacl.sign.keyPair.fromSecretKey(secretKey);
  return { secretKey, publicKey: kp.publicKey };
}

async function signAndBroadcast(q, solHint) {
  const { secretKey, publicKey } = loadKeyPair();
  const raw = Buffer.from(q.v1Tx, "base64");
  if (!raw.length) throw new Error("Quote had an empty swapTransaction");
  let kind, v0 = null, legacy = null;
  try { v0 = VersionedTransaction.deserialize(raw); kind = "v0"; }
  catch {
    try { legacy = Transaction.from(raw); kind = "legacy"; }
    catch (e) { throw new Error("Could not deserialize FOMO tx: " + e.message); }
  }
  const msgBytes = kind === "v0"
    ? Buffer.from(v0.message.serialize())
    : Buffer.from(legacy.serializeMessage());
  const sig = nacl.sign.detached(new Uint8Array(msgBytes), secretKey);
  const user = new PublicKey(publicKey);
  try {
    if (kind === "v0") v0.addSignature(user, Buffer.from(sig));
    else legacy.addSignature(user, Buffer.from(sig));
  } catch (e) {
    throw new Error(
      `User signature rejected (${e.message}). FOMO_PRIVATE_KEY pubkey ${user.toBase58()} is not a signer of this quote tx` +
      (solHint ? ` — FOMO wallet is ${solHint}` : "")
    );
  }
  if (q.feePayerAddress && q.feePayerSignature) {
    try {
      const payer = new PublicKey(q.feePayerAddress);
      const psig = Buffer.from(q.feePayerSignature, "base64");
      if (kind === "v0") v0.addSignature(payer, psig);
      else legacy.addSignature(payer, psig);
    } catch (e) { throw new Error("Could not attach FOMO fee-payer signature: " + e.message); }
  }
  const signedBytes = kind === "v0" ? Buffer.from(v0.serialize()) : Buffer.from(legacy.serialize());
  const sigs = kind === "v0"
    ? v0.signatures
    : legacy.signatures.map((s) => s.signature || new Uint8Array(64));
  const missing = sigs.filter((s) => !s || s.length === 0 || s.every((b) => b === 0)).length;
  if (missing > 0) throw new Error(`Tx still missing ${missing} signature(s) after key + fee payer`);
  const b64 = signedBytes.toString("base64");
  const firstSig = kind === "v0" ? v0.signatures[0] : legacy.signature;
  const expectedHash = firstSig && firstSig.length ? b58encode(Uint8Array.from(firstSig)) : "";

  const errors = [];
  try {
    const hudson = await fetch(HUDSON, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: b64,
      signal: AbortSignal.timeout(8_000),
    });
    if (hudson.ok) return { txHash: expectedHash || "hudson-ok", via: "hudson" };
    errors.push(`hudson ${hudson.status}: ${(await hudson.text().catch(() => "")).slice(0, 120)}`);
  } catch (e) { errors.push(`hudson: ${e.message}`); }
  try {
    const rpc = await fetch(FOMO_RPC, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.bearer}`,
        Origin: "https://fomo.family",
        Referer: "https://fomo.family/",
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "sendTransaction",
        params: [b64, { encoding: "base64", skipPreflight: true, maxRetries: 0 }],
      }),
      signal: AbortSignal.timeout(12_000),
    });
    const text = await rpc.text().catch(() => "");
    if (rpc.ok) {
      const json = JSON.parse(text);
      if (json.result) return { txHash: json.result, via: "fomo-rpc" };
      errors.push(`fomo-rpc: ${json.error?.message || text.slice(0, 120)}`);
    } else errors.push(`fomo-rpc ${rpc.status}: ${text.slice(0, 120)}`);
  } catch (e) { errors.push(`fomo-rpc: ${e.message}`); }
  throw new Error(`Signed but broadcast failed. ${errors.join(" | ")}`);
}

async function pollRelayStatus(relaySwapId) {
  for (let i = 0; i < 12; i++) {
    try {
      const res = await fetch(`https://api.relay.link/requests/v2?id=${encodeURIComponent(relaySwapId)}`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (res.ok) {
        const data = await res.json();
        const st = String(data.requests?.[0]?.status || data.status || "").toUpperCase();
        if (st === "SUCCESS") return "SUCCESS";
        if (["FAILURE", "FAILED", "REFUND"].includes(st)) return "FAILED";
      }
    } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 1_500));
  }
  return "TIMEOUT";
}

async function executeSwap(address, networkId, side, amountArg) {
  const q = await quoteSwap(address, networkId, side, amountArg);
  if (!q) throw new Error("FOMO returned no quote");
  if (q.relayType === "EVM") {
    throw new Error("EVM quote — FOMO needs an EIP-712 Privy signature only the app iframe can produce. Headless swaps are Solana-only.");
  }
  let solHint = "";
  try {
    const uid = await currentUserId();
    const bal = await fomoFetch(`/v2/users/${encodeURIComponent(uid)}/balances`);
    const s = JSON.stringify(bal);
    const m = s.match(/"([1-9A-HJ-NP-Za-km-z]{32,44})"/);
    if (m) solHint = m[1];
  } catch { /* optional hint */ }

  if (q.relaySwapId) {
    try {
      const fill = await fomoFetch("/swaps/v2/fast-fill", { method: "POST", body: { relaySwapId: q.relaySwapId } });
      if (fill?.success !== false) {
        const relayStatus = await pollRelayStatus(q.relaySwapId);
        return {
          ok: relayStatus === "SUCCESS" || relayStatus !== "FAILED",
          path: "fast-fill",
          relayStatus,
          quote: q,
        };
      }
    } catch (e) {
      if (!q.v1Tx) throw new Error(`fast-fill failed: ${e.message}`);
      console.error("[fomo] fast-fill failed:", e.message, "— trying key-sign path");
    }
  }
  if (!q.v1Tx) throw new Error("Quote had no relaySwapId and no swapTransaction to sign. Nothing spent.");
  const r = await signAndBroadcast(q, solHint);
  return { ok: true, path: "key-sign", txHash: r.txHash, via: r.via, quote: q };
}

/* ── thesis ─────────────────────────────────────────────────────────────── */
async function findOwnTrade(tokenAddress) {
  const uid = await currentUserId();
  for (const orderBy of ["openedAt", "closedAt"]) {
    const qs = new URLSearchParams({ userId: uid, tokenAddress, orderBy });
    try {
      const ro = await fomoFetch(`/trades?${qs.toString()}`);
      const rows = Array.isArray(ro) ? ro : Array.isArray(ro?.trades) ? ro.trades : [];
      if (rows.length) {
        const id = str(rows[0].id) || str(rows[0].tradeId);
        if (id) return id;
      }
    } catch { /* try next */ }
  }
  return "";
}

/* ── cli ────────────────────────────────────────────────────────────────── */
function printResult(obj) {
  console.log("RESULT: " + JSON.stringify(obj, null, 2));
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  loadSession();

  switch (cmd) {
    case "auth": {
      await ensureBearer();
      const out = { ok: true, bearerExp: new Date(jwtExpMs(state.bearer) ?? 0).toISOString() };
      if (process.env.FOMO_PRIVATE_KEY) {
        try { out.solanaPubkey = new PublicKey(loadKeyPair().publicKey).toBase58(); }
        catch (e) { out.keyError = e.message; }
      }
      printResult(out);
      break;
    }
    case "whoami": {
      let user = null;
      for (const p of ["/v2/users/current", "/v2/users/me"]) {
        try { user = parseUser(await fomoFetch(p)); if (user.id) break; } catch { /* next */ }
      }
      if (!user?.id) user = { id: await currentUserId(), handle: "", name: "" };
      printResult({ ok: true, user });
      break;
    }
    case "balances": {
      const uid = await currentUserId();
      const ro = await fomoFetch(`/v2/users/${encodeURIComponent(uid)}/balances`);
      printResult({ ok: true, userId: uid, balances: ro });
      break;
    }
    case "trending": {
      const ro = await fomoFetch("/proxy/trendingTokens");
      printResult({ ok: true, tokens: parseTokenList(ro).slice(0, 25) });
      break;
    }
    case "search": {
      const phrase = args.join(" ").trim();
      if (!phrase) throw new Error("usage: search <phrase>");
      let rows = [];
      try { rows = parseTokenList(await fomoFetch("/proxy/filterTokensSearch", { method: "POST", body: { phrase } })); }
      catch { rows = parseTokenList(await fomoFetch("/proxy/filterTokensSearch", { method: "POST", body: { token: phrase } })); }
      printResult({ ok: true, tokens: rows.slice(0, 25) });
      break;
    }
    case "token": {
      const address = args[0];
      const networkId = Number(args[1] ?? SOLANA_NETWORK_ID);
      if (!address) throw new Error("usage: token <address> [networkId]");
      const ro = await fomoFetch("/proxy/tokenDetails", { method: "POST", body: { tokenId: tokenId(networkId, address) } });
      printResult({ ok: true, token: parseTokenList(ro)[0] ?? ro });
      break;
    }
    case "thesis-feed": {
      const address = args[0];
      const networkId = Number(args[1] ?? SOLANA_NETWORK_ID);
      if (!address) throw new Error("usage: thesis-feed <address> [networkId]");
      const qs = new URLSearchParams({ tokenAddress: address, networkId: String(networkId) });
      const ro = await fomoFetch(`/feed/token/thesis?${qs.toString()}`);
      printResult({ ok: true, feed: ro });
      break;
    }
    case "my-trades": {
      const uid = await currentUserId();
      const qs = new URLSearchParams({ userId: uid });
      if (args[0]) qs.set("tokenAddress", args[0]);
      const ro = await fomoFetch(`/trades?${qs.toString()}`);
      printResult({ ok: true, userId: uid, trades: ro });
      break;
    }
    case "post-thesis": {
      const tradeId = args[0];
      const comment = args.slice(1).join(" ").trim();
      if (!tradeId || !comment) throw new Error("usage: post-thesis <tradeId> <text...>");
      await fomoFetch("/trades/comment", { method: "POST", body: { tradeId, comment, visibility: "public" } });
      printResult({ ok: true, tradeId, posted: true });
      break;
    }
    case "thesis": {
      const address = args[0];
      const networkId = args[1];
      const comment = args.slice(2).join(" ").trim();
      if (!address || !networkId || !comment) throw new Error("usage: thesis <address> <networkId> <text...>");
      const tradeId = await findOwnTrade(address);
      if (!tradeId) throw new Error("No trade found on this token for the account — FOMO thesis attaches to your own trade. Buy/sell some first.");
      await fomoFetch("/trades/comment", { method: "POST", body: { tradeId, comment, visibility: "public" } });
      printResult({ ok: true, tradeId, posted: true });
      break;
    }
    case "quote": {
      const side = args[0];
      const address = args[1];
      const networkId = Number(args[2] ?? SOLANA_NETWORK_ID);
      const amountArg = args[3];
      if (!["buy", "sell"].includes(side) || !address || !amountArg) {
        throw new Error("usage: quote <buy|sell> <address> [networkId] <usd|rawAmount>");
      }
      const q = await quoteSwap(address, networkId, side, amountArg);
      printResult({ ok: true, quote: q });
      break;
    }
    case "swap": {
      const side = args[0];
      const address = args[1];
      const networkId = Number(args[2] ?? SOLANA_NETWORK_ID);
      const amountArg = args[3];
      if (!["buy", "sell"].includes(side) || !address || !amountArg) {
        throw new Error("usage: swap <buy|sell> <address> [networkId] <usd|rawAmount>");
      }
      const r = await executeSwap(address, networkId, side, amountArg);
      printResult(r);
      break;
    }
    default:
      throw new Error(
        "commands: auth | whoami | balances | trending | search | token | thesis-feed | my-trades | post-thesis | thesis | quote | swap"
      );
  }
}

main().catch((e) => {
  console.error("ERROR: " + (e.message || String(e)));
  process.exitCode = 1;
});
