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
const multer = require("multer"); // untuk handle upload file (.txt bulk address)
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// Multer disimpan di memory (bukan disk) karena file yang diupload cuma daftar
// address (kecil), langsung diproses lalu dibuang.
const upload = multer({ storage: multer.memoryStorage() });

const SIGNING_KEY = process.env.ALCHEMY_SIGNING_KEY; // Alchemy Dashboard > Notify > webhook detail > Signing Key
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY; // Alchemy Dashboard > App kamu > API Key (beda dari signing key!)
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// (Opsional) Role Discord yang mau di-tag/ping tiap ada notifikasi.
// Isi dengan Role ID (angka panjang), kosongkan kalau tidak mau tag siapa-siapa.
const DISCORD_ROLE_ID = process.env.DISCORD_ROLE_ID || "";

// Discord webhook URL KHUSUS untuk notifikasi NFT buy/sell (beda channel dari mint).
// Kalau kosong, fallback ke DISCORD_WEBHOOK_URL yang sama (jadi 1 channel saja).
const DISCORD_TRADES_WEBHOOK_URL = process.env.DISCORD_TRADES_WEBHOOK_URL || DISCORD_WEBHOOK_URL;

// Discord webhook URL KHUSUS untuk ringkasan (summary) transaksi berkala.
// Kalau kosong, fallback ke DISCORD_WEBHOOK_URL yang sama.
const DISCORD_SUMMARY_WEBHOOK_URL = process.env.DISCORD_SUMMARY_WEBHOOK_URL || DISCORD_WEBHOOK_URL;

// Interval pengiriman ringkasan transaksi (default 15 menit).
const SUMMARY_INTERVAL_MS = Number(process.env.SUMMARY_INTERVAL_MS || 15 * 60 * 1000);

// --- Threshold Alert (deteksi "wallet compak" beli/jual di collection sama) ---
// Discord webhook URL KHUSUS untuk alert threshold. Kalau kosong, fallback ke
// DISCORD_SUMMARY_WEBHOOK_URL (atau DISCORD_WEBHOOK_URL kalau itu juga kosong).
const DISCORD_THRESHOLD_WEBHOOK_URL =
  process.env.DISCORD_THRESHOLD_WEBHOOK_URL || DISCORD_SUMMARY_WEBHOOK_URL;

// Jumlah wallet unik (dari watched list) minimal yang harus transaksi (BUY atau
// SELL, dihitung TERPISAH) pada collection yang sama dalam THRESHOLD_WINDOW_MS
// supaya alert threshold dikirim. Default: 3 wallet.
const THRESHOLD_WALLET_COUNT = Number(process.env.THRESHOLD_WALLET_COUNT || 3);

// Rentang waktu (ms) untuk menghitung threshold di atas. Default: 5 menit.
// Ini window TERPISAH dari SUMMARY_INTERVAL_MS (yang untuk laporan periodik).
const THRESHOLD_WINDOW_MS = Number(process.env.THRESHOLD_WINDOW_MS || 5 * 60 * 1000);

// Kalau true, notifikasi buy/sell NFT dikirim (transfer masuk/keluar wallet
// dipantau, khusus NFT — token/USDC biasa di-skip). Default: true, karena ini
// memang fitur yang mau dipakai untuk deteksi buy/sell.
const TRACK_WALLET_ACTIVITY = process.env.TRACK_WALLET_ACTIVITY !== "false";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Base URL NFT API Alchemy untuk Robinhood Chain mainnet.
// Kalau kamu pakai testnet, ganti "robinhood-mainnet" -> "robinhood-testnet".
const NFT_API_BASE = `https://robinhood-mainnet.g.alchemy.com/nft/v3/${ALCHEMY_API_KEY}`;

// Base URL JSON-RPC Alchemy (dipakai untuk cek apakah suatu transaksi benar-benar
// ada pembayaran/payment, bukan sekadar transfer NFT biasa).
const RPC_API_BASE = `https://robinhood-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;

// Kalau true (default), notifikasi BUY/SELL hanya dikirim jika transaksi tersebut
// benar-benar ada pembayaran (native value atau transfer token ERC20 seperti
// WETH/USDC) yang menyertai NFT dalam transaksi yang sama. Transfer NFT biasa
// (hibah/airdrop/kirim manual tanpa pembayaran) akan di-skip, tidak dianggap buy/sell.
const TRACK_ONLY_REAL_TRADES = process.env.TRACK_ONLY_REAL_TRADES !== "false";

// --- Alchemy Notify API (untuk bulk-add address ke webhook Address Activity) ---
// BEDA dari ALCHEMY_API_KEY (dipakai untuk NFT API & RPC). Auth Token ini
// didapat dari Alchemy Dashboard > Notify > (klik ikon gear/settings) > Auth Token.
const ALCHEMY_AUTH_TOKEN = process.env.ALCHEMY_AUTH_TOKEN || "";

// ID webhook Address Activity yang sudah dibuat di Alchemy Dashboard (bukan
// signing key, bukan URL webhook — ini ID unik webhook, terlihat di dashboard
// atau lewat endpoint "get all webhooks" punya Alchemy).
const ALCHEMY_WEBHOOK_ID = process.env.ALCHEMY_WEBHOOK_ID || "";

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
// BUFFER UNTUK SUMMARY TRANSAKSI BERKALA (buy/sell per collection, tiap 15 menit)
// ---------------------------------------------------------------------------
// Ini buffer TERPISAH dari mintBuffer & tidak mengubah alur notifikasi
// buy/sell real-time yang sudah ada. Cuma "mencatat" setiap kejadian buy/sell
// supaya bisa diringkas & dikirim berkala oleh flushSummaryBuffer().
//
// key: nama collection (atau contract address kalau nama tidak diketahui)
// value: { buyCount, sellCount, buyWallets: Set, sellWallets: Set }
const summaryBuffer = new Map();

function recordTransactionForSummary({ collectionKey, isSell, watchedLabel }) {
  if (!summaryBuffer.has(collectionKey)) {
    summaryBuffer.set(collectionKey, {
      buyCount: 0,
      sellCount: 0,
      buyWallets: new Set(),
      sellWallets: new Set(),
    });
  }

  const entry = summaryBuffer.get(collectionKey);
  if (isSell) {
    entry.sellCount += 1;
    entry.sellWallets.add(watchedLabel);
  } else {
    entry.buyCount += 1;
    entry.buyWallets.add(watchedLabel);
  }
}

async function flushSummaryBuffer() {
  if (summaryBuffer.size === 0) {
    console.log("📊 Tidak ada transaksi dalam periode ini, kirim summary kosong.");
    await sendDiscordMessage(
      "📊 **Summary Transaksi (15 menit terakhir)**\nTidak ada aktivitas transaksi dalam periode ini.",
      DISCORD_SUMMARY_WEBHOOK_URL
    );
    return;
  }

  const sections = [];
  for (const [collectionKey, entry] of summaryBuffer.entries()) {
    const buyWalletsText = entry.buyWallets.size > 0 ? [...entry.buyWallets].join(", ") : "-";
    const sellWalletsText = entry.sellWallets.size > 0 ? [...entry.sellWallets].join(", ") : "-";

    sections.push(
      `🖼️ **${collectionKey}**\n` +
        `🟢 Buy: ${entry.buyCount}x — Wallet: ${buyWalletsText}\n` +
        `🔴 Sell: ${entry.sellCount}x — Wallet: ${sellWalletsText}`
    );
  }

  const message = `📊 **Summary Transaksi (15 menit terakhir)**\n\n${sections.join("\n\n")}`;

  console.log(`📊 Mengirim summary transaksi (${summaryBuffer.size} collection).`);
  summaryBuffer.clear();

  await sendDiscordMessage(message, DISCORD_SUMMARY_WEBHOOK_URL);
}

// Jadwalkan pengiriman summary berkala. Tidak mengganggu timer mint (MINT_BATCH_DELAY_MS)
// karena ini interval terpisah.
setInterval(() => {
  flushSummaryBuffer().catch((err) => {
    console.error("Gagal mengirim summary transaksi:", err);
  });
}, SUMMARY_INTERVAL_MS);

// ---------------------------------------------------------------------------
// THRESHOLD ALERT: deteksi wallet "compak" beli/jual di collection yang sama
// ---------------------------------------------------------------------------
// Beda dari summaryBuffer (laporan periodik tiap 15 menit), ini alert INSTAN
// yang dikirim begitu jumlah wallet unik (dari watched list) yang BUY atau SELL
// (dihitung terpisah) di 1 collection mencapai THRESHOLD_WALLET_COUNT dalam
// rentang waktu THRESHOLD_WINDOW_MS. Tidak mengubah/menggantikan summaryBuffer.
//
// key: nama collection (atau contract address kalau nama tidak diketahui)
// value: { buy: Map(walletLabel -> timestamp terakhir), sell: Map(walletLabel -> timestamp terakhir) }
const thresholdBuffer = new Map();

function pruneExpiredWallets(walletTimestampMap, windowMs) {
  const now = Date.now();
  for (const [wallet, ts] of walletTimestampMap.entries()) {
    if (now - ts > windowMs) {
      walletTimestampMap.delete(wallet);
    }
  }
}

async function recordAndCheckThreshold({ collectionKey, isSell, watchedLabel }) {
  if (!thresholdBuffer.has(collectionKey)) {
    thresholdBuffer.set(collectionKey, { buy: new Map(), sell: new Map() });
  }

  const entry = thresholdBuffer.get(collectionKey);
  const dirMap = isSell ? entry.sell : entry.buy;

  // Buang wallet yang catatannya sudah di luar window waktu.
  pruneExpiredWallets(dirMap, THRESHOLD_WINDOW_MS);

  // Catat/update timestamp wallet ini.
  dirMap.set(watchedLabel, Date.now());

  if (dirMap.size >= THRESHOLD_WALLET_COUNT) {
    const wallets = [...dirMap.keys()];
    const directionLabel = isSell ? "SELL" : "BUY";
    const emoji = isSell ? "🔴" : "🟢";
    const windowMinutes = Math.round(THRESHOLD_WINDOW_MS / 60000);

    const message =
      `🚨 **Threshold Alert!**\n` +
      `${emoji} **${wallets.length} wallet** dari watched list melakukan **${directionLabel}** ` +
      `pada collection **${collectionKey}** dalam ${windowMinutes} menit terakhir!\n` +
      `Wallet: ${wallets.join(", ")}`;

    console.log(`🚨 Threshold ${directionLabel} tercapai untuk collection "${collectionKey}" (${wallets.length} wallet).`);

    // Reset window untuk arah (buy/sell) & collection ini setelah alert terkirim,
    // supaya hitungan mulai dari nol lagi untuk deteksi lonjakan berikutnya.
    dirMap.clear();

    await sendDiscordMessage(message, DISCORD_THRESHOLD_WEBHOOK_URL);
  }
}

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

// ---------------------------------------------------------------------------
// BULK ADD WALLET DARI FILE .TXT (1 address per baris, nama opsional)
// ---------------------------------------------------------------------------
// Dipakai oleh endpoint POST /admin/bulk-add-wallets. Alur:
//   1. Parse isi file .txt -> daftar { address, name } valid
//      Format tiap baris: "0xAddress" ATAU "0xAddress,Nama Wallet"
//   2. Tambahkan (append, bukan replace) address baru ke wallets.json lokal
//   3. Push address baru itu ke Alchemy webhook (Notify API) supaya Alchemy
//      juga mulai mengirim event untuk wallet tersebut
// Address yang sudah ada sebelumnya (di wallets.json ATAU sudah pernah dikirim)
// otomatis di-skip dari kedua proses di atas (idempotent, aman dipanggil ulang).

const EVM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

/** Parse isi file .txt -> array { address, name } valid (address lowercase).
 * Format tiap baris: "0xAddress" atau "0xAddress,Nama Wallet" (nama opsional).
 * Baris kosong, komentar ("#..."), dan address dengan format tidak valid diabaikan. */
function parseAddressesFromTxt(fileBuffer) {
  const lines = fileBuffer.toString("utf-8").split(/\r?\n/);
  const valid = [];
  const invalid = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue; // skip baris kosong/komentar

    // Pisahkan address & nama pakai koma pertama saja (biar nama boleh ada koma juga).
    const commaIndex = line.indexOf(",");
    const addrPart = (commaIndex === -1 ? line : line.slice(0, commaIndex)).trim();
    const namePart = commaIndex === -1 ? "" : line.slice(commaIndex + 1).trim();

    const addr = addrPart.toLowerCase();
    if (EVM_ADDRESS_REGEX.test(addr)) {
      valid.push({ address: addr, name: namePart || undefined });
    } else {
      invalid.push(line);
    }
  }

  return { valid, invalid };
}

/** Tambahkan (append) address baru ke wallets.json lokal, skip yang sudah ada.
 * Input: array { address, name } (dari parseAddressesFromTxt).
 * Return daftar address (string) yang benar-benar baru ditambahkan. */
function appendAddressesToWalletsFile(newEntries) {
  const filePath = path.join(__dirname, "wallets.json");

  let parsed = { wallets: [] };
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.wallets)) parsed.wallets = [];
  } catch (err) {
    console.warn("⚠️  wallets.json tidak ditemukan/invalid, akan dibuat baru.");
    parsed = { wallets: [] };
  }

  // Kumpulkan address yang sudah ada (baik bentuk string maupun object).
  const existing = new Set(
    parsed.wallets.map((entry) =>
      (typeof entry === "string" ? entry : entry?.address || "").trim().toLowerCase()
    )
  );

  const addedAddresses = [];
  for (const { address, name } of newEntries) {
    if (!existing.has(address)) {
      // Kalau ada nama -> simpan sebagai object { address, name }.
      // Kalau tidak ada nama -> simpan sebagai string polos (konsisten dengan format lama).
      parsed.wallets.push(name ? { address, name } : address);
      existing.add(address);
      addedAddresses.push(address);
    }
  }

  if (addedAddresses.length > 0) {
    fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), "utf-8");
  }

  return addedAddresses;
}

/** Push address baru ke Alchemy webhook (Notify API) via endpoint
 * update-webhook-addresses, mode APPEND (addresses_to_add), bukan replace.
 * Otomatis dibagi per 500 address per request (limit dari Alchemy). */
async function addAddressesToAlchemyWebhook(addresses) {
  if (!ALCHEMY_AUTH_TOKEN || !ALCHEMY_WEBHOOK_ID) {
    throw new Error(
      "ALCHEMY_AUTH_TOKEN atau ALCHEMY_WEBHOOK_ID belum diisi di .env — tidak bisa push ke Alchemy."
    );
  }
  if (addresses.length === 0) return { pushed: 0 };

  const BATCH_SIZE = 500;
  let pushed = 0;

  for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
    const batch = addresses.slice(i, i + BATCH_SIZE);

    const res = await fetch("https://dashboard.alchemy.com/api/update-webhook-addresses", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Alchemy-Token": ALCHEMY_AUTH_TOKEN,
      },
      body: JSON.stringify({
        webhook_id: ALCHEMY_WEBHOOK_ID,
        addresses_to_add: batch,
        addresses_to_remove: [],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Alchemy API gagal (status ${res.status}): ${errText}`);
    }

    pushed += batch.length;
  }

  return { pushed };
}

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
// CEK APAKAH TRANSAKSI BENAR-BENAR JUAL-BELI (ADA PEMBAYARAN)
// ---------------------------------------------------------------------------
// Webhook "Address Activity" dari Alchemy mendeteksi NFT yang berpindah wallet,
// tapi TIDAK membedakan apakah itu hasil BELI (ada pembayaran) atau sekadar
// transfer/hibah/airdrop biasa (tanpa pembayaran). Fungsi ini mengecek transaksi
// (via JSON-RPC) apakah ada pembayaran yang menyertai (native value ATAU
// transfer token ERC20 seperti WETH/USDC dalam transaksi yang sama).
async function isRealPurchaseTx(txHash) {
  try {
    const [txRes, receiptRes] = await Promise.all([
      fetch(RPC_API_BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getTransactionByHash",
          params: [txHash],
        }),
      }),
      fetch(RPC_API_BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "eth_getTransactionReceipt",
          params: [txHash],
        }),
      }),
    ]);

    const txData = await txRes.json();
    const nativeValueHex = txData?.result?.value;

    // Kalau ada native value (ETH/token native chain) yang dikirim bersama tx ini,
    // hampir pasti ini pembelian langsung (msg.value = harga NFT).
    if (nativeValueHex && nativeValueHex !== "0x0" && nativeValueHex !== "0x") {
      return true;
    }

    // Kalau native value = 0, cek log transaksi untuk transfer token ERC20
    // (misal WETH/USDC) sebagai pembayaran — umum dipakai marketplace seperti
    // OpenSea Seaport / Blur untuk order berbasis token, bukan native ETH.
    const receiptData = await receiptRes.json();
    const logs = receiptData?.result?.logs || [];

    // Event signature standar: Transfer(address,address,uint256)
    const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

    const hasErc20PaymentTransfer = logs.some((log) => {
      if (log.topics?.[0]?.toLowerCase() !== TRANSFER_TOPIC) return false;
      // ERC20 Transfer: 3 topics (event, from, to), value ada di "data".
      // ERC721 Transfer: 4 topics (event, from, to, tokenId), "data" kosong ("0x").
      const isErc20Shape = log.topics.length === 3;
      const hasNonZeroData = log.data && log.data !== "0x";
      return isErc20Shape && hasNonZeroData;
    });

    return hasErc20PaymentTransfer;
  } catch (err) {
    console.error(`Gagal cek pembayaran untuk tx ${txHash}:`, err);
    // Kalau gagal cek (misal RPC error), fallback: anggap valid supaya
    // notifikasi tidak hilang begitu saja karena masalah teknis sementara.
    return true;
  }
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

async function sendDiscordMessage(content, webhookUrl = DISCORD_WEBHOOK_URL) {
  if (!webhookUrl) return;

  const rolePrefix = DISCORD_ROLE_ID ? `<@&${DISCORD_ROLE_ID}> ` : "";

  try {
    await fetch(webhookUrl, {
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
  // OUTGOING (NFT keluar dari watched wallet) = indikasi SELL
  // INCOMING (NFT masuk ke watched wallet) = indikasi BUY
  const isSell = direction === "OUTGOING";
  const label = isSell ? "SELL" : "BUY";
  const emoji = isSell ? "🔴" : "🟢";
  const actionText = isSell ? "menjual" : "membeli";
  const txUrl = `${EXPLORER_TX_BASE}/${txHash}`;

  // Filter transfer NFT biasa (hibah/airdrop/kirim manual) yang BUKAN benar-benar
  // jual-beli — kalau tidak ada pembayaran (native value / token ERC20) yang
  // menyertai NFT dalam transaksi yang sama, transaksi ini di-skip total
  // (tidak dianggap BUY/SELL, tidak masuk summary/threshold, tidak kirim notif).
  if (TRACK_ONLY_REAL_TRADES) {
    const isRealTrade = await isRealPurchaseTx(txHash);
    if (!isRealTrade) {
      console.log(
        `ℹ️  NFT ${label} diabaikan (tidak ada pembayaran terdeteksi, kemungkinan transfer/hibah biasa) — Tx: ${txUrl}`
      );
      return;
    }
  }

  const { assetName, collectionName, openSeaSlug } = await fetchNftInfo(contractAddress, tokenId);
  const asset = assetName || `Token ID ${tokenId}`;

  console.log(`${emoji} NFT ${label} TERDETEKSI (wallet: ${watchedLabel})`);
  console.log(`   Contract : ${contractAddress}`);
  console.log(`   Asset    : ${asset}`);
  console.log(`   From     : ${walletLabel(fromAddress)}`);
  console.log(`   To       : ${walletLabel(toAddress)}`);
  console.log(`   Tx       : ${txUrl}`);
  if (collectionName) console.log(`   Collection: ${collectionName}`);
  console.log("----------------------------------------");

  // Catat transaksi ini untuk ringkasan berkala (tidak memengaruhi notifikasi di bawah).
  const collectionKey = collectionName || contractAddress;
  recordTransactionForSummary({ collectionKey, isSell, watchedLabel });

  // Cek juga apakah threshold wallet "compak" beli/jual sudah tercapai (alert instan terpisah).
  recordAndCheckThreshold({ collectionKey, isSell, watchedLabel }).catch((err) => {
    console.error("Gagal memproses threshold alert:", err);
  });

  const message =
    `${emoji} **Kemungkinan ${actionText} NFT!**\n` +
    `Wallet : \`${watchedLabel}\`\n` +
    `Contract : \`${contractAddress}\`\n` +
    `Asset : \`${asset}\`\n` +
    `From : \`${walletLabel(fromAddress)}\`\n` +
    `To : \`${walletLabel(toAddress)}\`\n` +
    `Tx : ${txUrl}` +
    (collectionName ? `\nCollection : \`${collectionName}\`` : "") +
    (openSeaSlug ? `\nOpenSea : https://opensea.io/collection/${openSeaSlug}` : "");

  await sendDiscordMessage(message, DISCORD_TRADES_WEBHOOK_URL);
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

    // Kasus 2: NFT masuk/keluar dari wallet yang dipantau (indikasi buy/sell).
    // Token/USDC biasa (bukan NFT) di-skip karena fokusnya cuma NFT.
    if (!TRACK_WALLET_ACTIVITY || !isNft) continue;

    const isFromWatched = WATCHED_WALLETS.includes(fromAddress);
    const isToWatched = WATCHED_WALLETS.includes(toAddress);

    if (!isFromWatched && !isToWatched) {
      console.log(`ℹ️  Aktivitas NFT diabaikan (bukan watched wallet) — from: ${fromAddress}, to: ${toAddress}`);
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

// Bulk-add wallet dari file .txt. Format tiap baris: "0xAddress" atau
// "0xAddress,Nama Wallet" (nama opsional). Address baru akan:
//   1. Ditambahkan (append) ke wallets.json lokal — dengan nama kalau disertakan
//   2. Dipush ke Alchemy webhook (Notify API), mode append/tambah (bukan replace)
// Address yang sudah ada sebelumnya otomatis di-skip (aman dipanggil berkali-kali).
//
// Cara pakai (contoh dengan curl):
//   curl -F "file=@wallets-baru.txt" http://localhost:3000/admin/bulk-add-wallets
app.post("/admin/bulk-add-wallets", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "File tidak ditemukan. Kirim sebagai form-data dengan field name 'file'." });
  }

  const { valid, invalid } = parseAddressesFromTxt(req.file.buffer);

  if (valid.length === 0) {
    return res.status(400).json({
      error: "Tidak ada address valid di dalam file.",
      invalidLines: invalid,
    });
  }

  // Cek duplikat TERHADAP wallets.json SEBELUM ditulis, supaya kita tahu address
  // mana saja yang benar-benar baru (dan hanya address baru itu yang dipush ke Alchemy).
  const addedToFile = appendAddressesToWalletsFile(valid);

  let alchemyResult = { pushed: 0, error: null };
  if (addedToFile.length > 0) {
    try {
      const result = await addAddressesToAlchemyWebhook(addedToFile);
      alchemyResult.pushed = result.pushed;
    } catch (err) {
      console.error("Gagal push address ke Alchemy:", err);
      alchemyResult.error = err.message;
    }
  }

  // Reload WATCHED_WALLETS in-memory supaya address baru langsung aktif tanpa restart.
  loadWallets();

  res.status(200).json({
    totalDiFile: valid.length + invalid.length,
    validDiFile: valid.length,
    invalidLines: invalid, // baris yang formatnya bukan address EVM valid
    baruDitambahkanKeWalletsJson: addedToFile.length,
    sudahAdaSebelumnya: valid.length - addedToFile.length,
    alchemy: alchemyResult,
    totalWalletSekarang: WATCHED_WALLETS.length,
  });
});

app.listen(PORT, () => {
  console.log(`Server jalan di http://localhost:${PORT}`);
  console.log(`Endpoint webhook (mint)           : http://localhost:${PORT}/webhook/nft-mint`);
  console.log(`Endpoint webhook (wallet activity): http://localhost:${PORT}/webhook/wallet-activity`);
});
