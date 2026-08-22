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

// (Opsional) Role Discord yang mau di-tag/ping tiap ada notifikasi.
// Isi dengan Role ID (angka panjang), kosongkan kalau tidak mau tag siapa-siapa.
const DISCORD_ROLE_ID = process.env.DISCORD_ROLE_ID || "";

// Kalau true, notifikasi juga dikirim untuk aktivitas wallet selain mint
// (transfer masuk/keluar token & NFT). Set ke "true" di env var kalau mau
// diaktifkan lagi nanti. Default: false -> cuma notif MINT yang dikirim.
const TRACK_WALLET_ACTIVITY = process.env.TRACK_WALLET_ACTIVITY === "true";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Base URL NFT API Alchemy untuk Robinhood Chain mainnet.
// Kalau kamu pakai testnet, ganti "robinhood-mainnet" -> "robinhood-testnet".
const NFT_API_BASE = `https://robinhood-mainnet.g.alchemy.com/nft/v3/${ALCHEMY_API_KEY}`;

// Block explorer untuk link transaksi di notifikasi.
const EXPLORER_TX_BASE = "https://robinhoodchain.blockscout.com/tx";

// ---------------------------------------------------------------------------
// BATCHING UNTUK MINT BERUNTUN
// ---------------------------------------------------------------------------
// Kalau ada beberapa mint dari kontrak+wallet yang sama dalam waktu singkat,
// digabung jadi 1 pesan ringkasan alih-alih dikirim satu-satu. Timer di-reset
// tiap ada mint baru masuk, ringkasan dikirim setelah "sepi" selama delay ini.
const MINT_BATCH_DELAY_MS = Number(process.env.MINT_BATCH_DELAY_MS || 8000); // default 8 detik

const mintBuffer = new Map(); // key: `${contractAddress}|${mintedTo}` -> { tokenIds, txHashes, collectionName, timer }

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

/** Ambil label tampilan untuk sebuah address: "Nama (0xabcd...wxyz)" kalau ada
 * nama custom, atau alamat penuh kalau tidak ada nama. */
function walletLabel(address) {
  if (!address) return "-";
  const lower = address.toLowerCase();
  const name = WALLET_NAMES[lower];
  if (!name) return address;

  const shortAddr = `${address.slice(0, 6)}...${address.slice(-4)}`;
  return `${name} (${shortAddr})`;
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
    return { assetName: null, collectionName: null, openSeaSlug: null };
  }

  try {
    const url = `${NFT_API_BASE}/getNFTMetadata?contractAddress=${contractAddress}&tokenId=${tokenId}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`⚠️  NFT API respon ${res.status} untuk ${contractAddress} #${tokenId}`);
      return { assetName: null, collectionName: null, openSeaSlug: null };
    }
    const data = await res.json();

    const assetName = data?.name || data?.raw?.metadata?.name || null;
    const openSeaMeta = data?.contract?.openSeaMetadata;
    const collectionName = openSeaMeta?.collectionName || data?.contract?.name || null;
    const openSeaSlug = openSeaMeta?.collectionSlug || null;

    return { assetName, collectionName, openSeaSlug };
  } catch (err) {
    console.warn("⚠️  Gagal fetch NFT metadata:", err.message);
    return { assetName: null, collectionName: null, openSeaSlug: null };
  }
}

// ---------------------------------------------------------------------------
// DISCORD NOTIFICATIONS
// ---------------------------------------------------------------------------

async function sendDiscordMessage(content) {
  if (!DISCORD_WEBHOOK_URL) return;

  const rolePrefix = DISCORD_ROLE_ID ? `<@&${DISCORD_ROLE_ID}> ` : "";

  try {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: rolePrefix + content,
        // allowed_mentions eksplisit supaya role benar-benar ke-notif (ping),
        // bukan cuma teks <@&ID> yang tampil sebagai teks biasa.
        allowed_mentions: { parse: ["roles"] },
      }),
    });
  } catch (err) {
    console.error("Gagal kirim notifikasi Discord:", err);
  }
}

async function handleMintDetected({ contractAddress, tokenId, mintedTo, txHash }) {
  const { assetName, collectionName, openSeaSlug } = await fetchNftInfo(contractAddress, tokenId);

  console.log("🎨 MINT TERDETEKSI (masuk buffer)");
  console.log(`   Contract     : ${contractAddress}`);
  console.log(`   Token ID     : ${tokenId}`);
  console.log(`   Minted from  : ${walletLabel(mintedTo)}`);
  console.log(`   Tx           : ${EXPLORER_TX_BASE}/${txHash}`);
  console.log("----------------------------------------");

  const key = `${contractAddress}|${mintedTo}`;

  if (!mintBuffer.has(key)) {
    mintBuffer.set(key, {
      contractAddress,
      mintedTo,
      collectionName,
      openSeaSlug,
      tokenIds: [],
      txHashes: new Set(),
      timer: null,
    });
  }

  const entry = mintBuffer.get(key);
  entry.tokenIds.push(assetName || `#${tokenId}`);
  entry.txHashes.add(txHash);
  if (!entry.collectionName && collectionName) entry.collectionName = collectionName;
  if (!entry.openSeaSlug && openSeaSlug) entry.openSeaSlug = openSeaSlug;

  // Reset timer setiap ada mint baru masuk untuk key yang sama.
  // Ringkasan baru dikirim setelah tidak ada mint baru selama MINT_BATCH_DELAY_MS.
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => flushMintBuffer(key), MINT_BATCH_DELAY_MS);
}

async function flushMintBuffer(key) {
  const entry = mintBuffer.get(key);
  if (!entry) return;
  mintBuffer.delete(key);

  const mintedFromLabel = walletLabel(entry.mintedTo);
  const count = entry.tokenIds.length;
  const txLinks = [...entry.txHashes].map((h) => `${EXPLORER_TX_BASE}/${h}`);
  const openSeaLine = entry.openSeaSlug
    ? `\nOpenSea : https://opensea.io/collection/${entry.openSeaSlug}`
    : "";

  let message;

  if (count === 1) {
    // Cuma 1 mint -> format seperti biasa
    message =
      `🎨 **Mint baru terdeteksi!**\n` +
      `Contract : \`${entry.contractAddress}\`\n` +
      `Asset : \`${entry.tokenIds[0]}\`\n` +
      `Minted from : \`${mintedFromLabel}\`\n` +
      `Tx : ${txLinks[0]}\n` +
      `Collection : \`${entry.collectionName || "-"}\`` +
      openSeaLine;
  } else {
    // Lebih dari 1 mint beruntun -> gabung jadi ringkasan
    const MAX_LISTED = 15;
    const listedTokens = entry.tokenIds.slice(0, MAX_LISTED).join(", ");
    const extra = count > MAX_LISTED ? ` (+${count - MAX_LISTED} lagi)` : "";

    const txText =
      txLinks.length === 1
        ? txLinks[0]
        : txLinks.map((l, i) => `[Tx ${i + 1}](${l})`).join(", ");

    message =
      `🎨 **${count}x Mint baru terdeteksi!**\n` +
      `Contract : \`${entry.contractAddress}\`\n` +
      `Collection : \`${entry.collectionName || "-"}\`\n` +
      `Minted from : \`${mintedFromLabel}\`\n` +
      `Total Minted : ${count}\n` +
      `Assets : ${listedTokens}${extra}\n` +
      `Tx : ${txText}` +
      openSeaLine;
  }

  console.log(`📬 Mengirim ringkasan mint (${count}x) untuk key ${key}`);
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
  let openSeaSlug = null;

  if (isNft) {
    const info = await fetchNftInfo(contractAddress, tokenId);
    asset = info.assetName || `Token ID ${tokenId}`;
    collectionName = info.collectionName;
    openSeaSlug = info.openSeaSlug;
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
    (collectionName ? `\nCollection : \`${collectionName}\`` : "") +
    (openSeaSlug ? `\nOpenSea : https://opensea.io/collection/${openSeaSlug}` : "");

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
    // Hanya diproses kalau TRACK_WALLET_ACTIVITY diaktifkan.
    if (!TRACK_WALLET_ACTIVITY) continue;

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
