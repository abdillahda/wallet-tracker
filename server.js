/**
 * NFT Mint & Wallet Activity Listener - Robinhood Chain
 * -------------------------------------------------------
 * Menerima webhook dari Alchemy (Address Activity) untuk mendeteksi:
 *  - MINT NFT (Transfer dari zero address)
 *  - Aktivitas wallet lain (transfer masuk/keluar) untuk wallet yang dipantau
 *
 * Setup:
 *   1. npm install
 *   2. copy .env.example -> .env, isi ALCHEMY_SIGNING_KEY, ALCHEMY_API_KEY, DISCORD_WEBHOOK_URL
 *   3. isi wallets.json dengan daftar wallet yang dipantau (+ nama custom, opsional)
 *   4. npm start
 */

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

const SIGNING_KEY = process.env.ALCHEMY_SIGNING_KEY; // Alchemy Dashboard > Notify > webhook detail > Signing Key
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY; // Alchemy Dashboard > App kamu > API Key (beda dari signing key!)
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Base URL NFT API Alchemy untuk Robinhood Chain mainnet.
// Kalau kamu pakai testnet, ganti "robinhood-mainnet" -> "robinhood-testnet".
const NFT_API_BASE = `https://robinhood-mainnet.g.alchemy.com/nft/v3/${ALCHEMY_API_KEY}`;

// Block explorer untuk link transaksi di notifikasi.
const EXPLORER_TX_BASE = "https://robinhoodchain.blockscout.com/tx";

// ---------------------------------------------------------------------------
// LOAD DAFTAR WALLET YANG DIPANTAU (dari wallets.json, bukan env var)
// ---------------------------------------------------------------------------
// Format wallets.json mendukung 2 bentuk per entry:
//   "0xabc..."                                    -> tanpa nama custom
//   { "address": "0xabc...", "name": "Dompet A" }  -> dengan nama custom
//
// Bisa lebih dari 10 wallet, tinggal tambah baris di file, tidak perlu ubah
// env var atau kode.

let WATCHED_WALLETS = [];
let WALLET_NAMES = {}; // address (lowercase) -> nama custom

function loadWallets() {
  const filePath = path.join(__dirname, "wallets.json");
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed.wallets) ? parsed.wallets : [];

    const addresses = [];
    const names = {};

    list.forEach((entry) => {
      if (typeof entry === "string") {
        const addr = entry.trim().toLowerCase();
        if (addr) addresses.push(addr);
      } else if (entry && typeof entry === "object" && entry.address) {
        const addr = entry.address.trim().toLowerCase();
        if (addr) {
          addresses.push(addr);
          if (entry.name) names[addr] = entry.name;
        }
      }
    });

    WATCHED_WALLETS = addresses;
    WALLET_NAMES = names;
  } catch (err) {
    console.warn("⚠️  wallets.json tidak ditemukan/invalid, fallback ke env var WATCHED_WALLETS.");
    WATCHED_WALLETS = (process.env.WATCHED_WALLETS || "")
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean);
    WALLET_NAMES = {};
  }

  console.log(`📋 Total wallet yang dipantau: ${WATCHED_WALLETS.length}`);
}

loadWallets();

/** Ambil label tampilan untuk sebuah address: nama custom kalau ada, else raw address. */
function walletLabel(address) {
  if (!address) return "-";
  const lower = address.toLowerCase();
  return WALLET_NAMES[lower] || address;
}

// ---------------------------------------------------------------------------
// MIDDLEWARE
// ---------------------------------------------------------------------------

// PENTING: Alchemy menandatangani body RAW (belum di-parse JSON).
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

function isValidSignature(req) {
  if (!SIGNING_KEY) return true; // skip validasi kalau belum diset (mode dev)

  const signature = req.headers["x-alchemy-signature"];
  if (!signature) {
    console.warn("⚠️  Header x-alchemy-signature tidak ada di request.");
    return false;
  }

  const hmac = crypto.createHmac("sha256", SIGNING_KEY);
  hmac.update(req.rawBody);
  const digest = hmac.digest("hex");

  const isValid = digest === signature;
  if (!isValid) {
    console.warn(
      `⚠️  Signature mismatch — diterima: ${signature.slice(0, 8)}..., dihitung: ${digest.slice(0, 8)}...`
    );
  }
  return isValid;
}

function isMintEvent(fromAddress) {
  return fromAddress?.toLowerCase() === ZERO_ADDRESS;
}

// ---------------------------------------------------------------------------
// NFT METADATA LOOKUP (Asset name & Collection name)
// ---------------------------------------------------------------------------

/**
 * Ambil nama NFT (asset) dan nama koleksi dari Alchemy NFT API.
 * Kalau ALCHEMY_API_KEY belum diisi atau request gagal, return fallback null
 * supaya notifikasi tetap terkirim (cuma tanpa nama asset/collection).
 */
async function fetchNftInfo(contractAddress, tokenId) {
  if (!ALCHEMY_API_KEY || !contractAddress || tokenId === undefined) {
    return { assetName: null, collectionName: null };
  }

  try {
    const url = `${NFT_API_BASE}/getNFTMetadata?contractAddress=${contractAddress}&tokenId=${tokenId}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`⚠️  NFT API respon ${res.status} untuk ${contractAddress} #${tokenId}`);
      return { assetName: null, collectionName: null };
    }
    const data = await res.json();

    const assetName = data?.name || data?.raw?.metadata?.name || null;
    const collectionName =
      data?.contract?.openSeaMetadata?.collectionName ||
      data?.contract?.name ||
      null;

    return { assetName, collectionName };
  } catch (err) {
    console.warn("⚠️  Gagal fetch NFT metadata:", err.message);
    return { assetName: null, collectionName: null };
  }
}

// ---------------------------------------------------------------------------
// DISCORD NOTIFICATIONS
// ---------------------------------------------------------------------------

async function sendDiscordMessage(content) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
  } catch (err) {
    console.error("Gagal kirim notifikasi Discord:", err);
  }
}

async function handleMintDetected({ contractAddress, tokenId, mintedTo, txHash }) {
  const { assetName, collectionName } = await fetchNftInfo(contractAddress, tokenId);
  const asset = assetName || `Token ID ${tokenId}`;
  const mintedFromLabel = walletLabel(mintedTo);
  const txUrl = `${EXPLORER_TX_BASE}/${txHash}`;

  console.log("🎨 MINT TERDETEKSI!");
  console.log(`   Contract     : ${contractAddress}`);
  console.log(`   Asset        : ${asset}`);
  console.log(`   Minted from  : ${mintedFromLabel}`);
  console.log(`   Tx           : ${txUrl}`);
  console.log(`   Collection   : ${collectionName || "-"}`);
  console.log("----------------------------------------");

  const message =
    `🎨 **Mint baru terdeteksi!**\n` +
    `Contract : \`${contractAddress}\`\n` +
    `Asset : \`${asset}\`\n` +
    `Minted from : \`${mintedFromLabel}\`\n` +
    `Tx : ${txUrl}\n` +
    `Collection : \`${collectionName || "-"}\``;

  await sendDiscordMessage(message);
}

async function handleWalletActivityDetected({
  direction,
  watchedWallet,
  isNft,
  contractAddress,
  tokenId,
  value,
  fromAddress,
  toAddress,
  txHash,
}) {
  const watchedLabel = walletLabel(watchedWallet);
  const directionEmoji = direction === "OUTGOING" ? "📤" : "📥";
  const directionText = direction === "OUTGOING" ? "keluar dari" : "masuk ke";
  const txUrl = `${EXPLORER_TX_BASE}/${txHash}`;

  let asset = contractAddress || "-";
  let collectionName = null;

  if (isNft) {
    const info = await fetchNftInfo(contractAddress, tokenId);
    asset = info.assetName || `Token ID ${tokenId}`;
    collectionName = info.collectionName;
  }

  console.log(`${directionEmoji} ${isNft ? "NFT" : "TOKEN"} ${direction} TERDETEKSI (wallet: ${watchedLabel})`);
  console.log(`   Contract : ${contractAddress}`);
  console.log(`   Asset    : ${asset}`);
  console.log(`   From     : ${walletLabel(fromAddress)}`);
  console.log(`   To       : ${walletLabel(toAddress)}`);
  console.log(`   Tx       : ${txUrl}`);
  if (collectionName) console.log(`   Collection: ${collectionName}`);
  console.log("----------------------------------------");

  const message =
    `${directionEmoji} **${isNft ? "NFT" : "Token"} ${directionText} wallet dipantau!**\n` +
    `Wallet : \`${watchedLabel}\`\n` +
    `Contract : \`${contractAddress}\`\n` +
    `Asset : \`${asset}\`${!isNft ? ` (value: ${value})` : ""}\n` +
    `From : \`${walletLabel(fromAddress)}\`\n` +
    `To : \`${walletLabel(toAddress)}\`\n` +
    `Tx : ${txUrl}` +
    (collectionName ? `\nCollection : \`${collectionName}\`` : "");

  await sendDiscordMessage(message);
}

// ---------------------------------------------------------------------------
// SHARED PAYLOAD PROCESSOR — dipakai oleh semua route webhook
// ---------------------------------------------------------------------------

async function processActivities(activities) {
  for (const activity of activities) {
    const fromAddress = (activity.fromAddress || activity.from || "").toLowerCase();
    const toAddress = (activity.toAddress || activity.to || "").toLowerCase();

    const tokenId =
      activity.tokenId || activity.erc721TokenId || activity.erc1155Metadata?.[0]?.tokenId;
    const isNft = Boolean(tokenId);
    const contractAddress = activity.contractAddress || activity.rawContract?.address;

    // Kasus 1: MINT (from == zero address)
    if (isMintEvent(fromAddress)) {
      await handleMintDetected({
        contractAddress,
        tokenId,
        mintedTo: toAddress,
        txHash: activity.hash,
      });
      continue;
    }

    // Kasus 2: aktivitas wallet yang dipantau (incoming/outgoing, NFT atau token)
    const isFromWatched = WATCHED_WALLETS.includes(fromAddress);
    const isToWatched = WATCHED_WALLETS.includes(toAddress);

    if (!isFromWatched && !isToWatched) {
      console.log(`ℹ️  Aktivitas diabaikan (bukan watched wallet) — from: ${fromAddress}, to: ${toAddress}`);
      continue;
    }

    const direction = isFromWatched ? "OUTGOING" : "INCOMING";
    const watchedWallet = isFromWatched ? fromAddress : toAddress;

    await handleWalletActivityDetected({
      direction,
      watchedWallet,
      isNft,
      contractAddress,
      tokenId,
      value: activity.value,
      fromAddress,
      toAddress,
      txHash: activity.hash,
    });
  }
}

function handleWebhookRequest(req, res) {
  if (!isValidSignature(req)) {
    console.warn("Signature tidak valid, request ditolak.");
    return res.status(401).send("Invalid signature");
  }

  // Balas 200 secepatnya supaya Alchemy tidak retry / dianggap gagal.
  res.status(200).send("OK");

  const { event } = req.body;
  const activities = event?.activity || [];

  if (activities.length === 0) {
    console.log("⚠️  Tidak ada 'activity' di payload:", JSON.stringify(req.body, null, 2));
    return;
  }

  processActivities(activities).catch((err) => {
    console.error("Gagal memproses payload webhook:", err);
  });
}

// ---------------------------------------------------------------------------
// ROUTES
// ---------------------------------------------------------------------------

app.post("/webhook/nft-mint", handleWebhookRequest);
app.post("/webhook/wallet-activity", handleWebhookRequest);
app.post("/", handleWebhookRequest); // alias, jaga-jaga URL yang terdaftar di Alchemy adalah root

app.get("/", (req, res) => {
  res.send("NFT Mint & Wallet Activity Webhook - Robinhood Chain aktif ✅");
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", time: new Date().toISOString() });
});

// Reload wallets.json tanpa perlu restart server (opsional, akses manual kalau perlu)
app.post("/admin/reload-wallets", (req, res) => {
  loadWallets();
  res.status(200).json({ total: WATCHED_WALLETS.length });
});

app.listen(PORT, () => {
  console.log(`Server jalan di http://localhost:${PORT}`);
  console.log(`Endpoint webhook (mint)           : http://localhost:${PORT}/webhook/nft-mint`);
  console.log(`Endpoint webhook (wallet activity): http://localhost:${PORT}/webhook/wallet-activity`);
});
