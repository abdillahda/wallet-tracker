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

// CATATAN: signing key sekarang per-chain, lihat object CHAINS di bawah
// (ALCHEMY_SIGNING_KEY untuk Robinhood, ALCHEMY_SIGNING_KEY_ARC untuk ARC).
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

// --- Konfigurasi multi-chain ---
// Tiap chain punya subdomain Alchemy, block explorer, signing key webhook, dan
// daftar contract LP sendiri. Semua fungsi yang butuh info chain terima object
// dari CHAINS ini sebagai parameter (bukan konstanta global lagi).
//
// Subdomain Alchemy bisa dioverride lewat env kalau sewaktu-waktu berubah
// (misal mau pindah ke testnet: ROBINHOOD_ALCHEMY_SUBDOMAIN=robinhood-testnet).
const ROBINHOOD_SUBDOMAIN = process.env.ROBINHOOD_ALCHEMY_SUBDOMAIN || "robinhood-mainnet";
const ARC_SUBDOMAIN = process.env.ARC_ALCHEMY_SUBDOMAIN || "arc-mainnet";

/** Bikin daftar contract yang di-exclude (LP position, bukan NFT collectible). */
function buildExcludedSet(defaults, envValue) {
  return new Set(
    [...defaults, ...(envValue || "").split(",").map((a) => a.trim()).filter(Boolean)].map((a) =>
      a.toLowerCase()
    )
  );
}

const CHAINS = {
  robinhood: {
    key: "robinhood",
    label: "Robinhood",
    nftApiBase: `https://${ROBINHOOD_SUBDOMAIN}.g.alchemy.com/nft/v3/${ALCHEMY_API_KEY}`,
    rpcApiBase: `https://${ROBINHOOD_SUBDOMAIN}.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
    explorerTxBase: process.env.ROBINHOOD_EXPLORER_TX_BASE || "https://robinhoodchain.blockscout.com/tx",
    signingKey: process.env.ALCHEMY_SIGNING_KEY || "",
    webhookId: process.env.ALCHEMY_WEBHOOK_ID || "",
    // Nilai field "network" yang dikirim Alchemy di body payload webhook
    // (event.network) — dipakai buat AUTO-DETECT chain dari isi payload,
    // bukan dari URL endpoint yang dipukul (karena Alchemy TIDAK BISA diubah
    // URL webhooknya sama sekali, baik lewat dashboard maupun API). Kalau nilai
    // defaultnya salah, override lewat ROBINHOOD_ALCHEMY_NETWORK di .env.
    alchemyNetwork: (process.env.ROBINHOOD_ALCHEMY_NETWORK || "ROBINHOOD_MAINNET").toUpperCase(),
    // NFT API Alchemy tersedia di Robinhood Chain.
    nftApiEnabled: process.env.ROBINHOOD_NFT_API_ENABLED !== "false",
    excludedNftContracts: buildExcludedSet(
      ["0x58daec3116aae6d93017baaea7749052e8a04fa7"], // Uniswap v4 Position Manager (Robinhood)
      process.env.EXCLUDED_NFT_CONTRACTS
    ),
  },
  arc: {
    key: "arc",
    label: "ARC",
    nftApiBase: `https://${ARC_SUBDOMAIN}.g.alchemy.com/nft/v3/${ALCHEMY_API_KEY}`,
    rpcApiBase: `https://${ARC_SUBDOMAIN}.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
    explorerTxBase: process.env.ARC_EXPLORER_TX_BASE || "https://www.arcexplorer.org/tx",
    signingKey: process.env.ALCHEMY_SIGNING_KEY_ARC || "",
    webhookId: process.env.ALCHEMY_WEBHOOK_ID_ARC || "",
    // Sama seperti di atas — dipakai buat auto-detect dari payload. Default
    // ini TEBAKAN berdasar pola penamaan Alchemy (chain_env), belum
    // terverifikasi resmi untuk Arc. Kalau salah, override lewat
    // ARC_ALCHEMY_NETWORK di .env (lihat log server buat tahu nilai aslinya).
    alchemyNetwork: (process.env.ARC_ALCHEMY_NETWORK || "ARC_MAINNET").toUpperCase(),
    // PENTING: per dokumentasi Alchemy, NFT API BELUM tersedia di Arc (statusnya
    // masih "Request support"). Jadi default-nya dimatikan — nama collection,
    // nama asset, dan gambar NFT tidak akan tampil untuk chain ini (fallback ke
    // contract address / token ID). Set ARC_NFT_API_ENABLED=true kalau Alchemy
    // sudah support, tanpa perlu ubah kode.
    nftApiEnabled: process.env.ARC_NFT_API_ENABLED === "true",
    excludedNftContracts: buildExcludedSet([], process.env.EXCLUDED_NFT_CONTRACTS_ARC),
  },
};

/** Chain default (dipakai endpoint lama /webhook/... yang tanpa prefix chain). */
const DEFAULT_CHAIN = CHAINS.robinhood;

// Lookup network (dari payload) -> chain, dibangun sekali dari CHAINS di atas.
const CHAIN_BY_ALCHEMY_NETWORK = Object.fromEntries(
  Object.values(CHAINS).map((chain) => [chain.alchemyNetwork, chain])
);

/** Tentukan chain SEBENARNYA dari isi payload webhook (field event.network),
 * bukan dari URL endpoint yang dipukul. Ini penting karena Alchemy TIDAK BISA
 * diubah webhook URL-nya (baik lewat dashboard maupun API) — jadi kalau ada
 * webhook yang "kepasang" di endpoint yang salah (misal webhook ARC yang masih
 * mengarah ke /webhook/nft-mint), payload-nya sendiri tetap bisa dipakai buat
 * tahu ini dari chain mana yang sebenarnya, tanpa perlu URL-nya benar.
 *
 * Kalau network di payload tidak dikenali (kosong/tidak cocok satupun di
 * CHAINS), fallback ke `hintChain` (chain yang "ditebak" dari URL endpoint). */
function resolveChainFromPayload(reqBody, hintChain) {
  const network = (reqBody?.event?.network || "").toUpperCase();
  if (!network) return hintChain;

  const matched = CHAIN_BY_ALCHEMY_NETWORK[network];
  if (matched) return matched;

  // Network ada tapi tidak match satupun -> kemungkinan besar nilai default
  // ALCHEMY_NETWORK di .env salah/belum diset sesuai nama asli dari Alchemy.
  // Log biar gampang ketahuan nilai yang benar itu apa, lalu tetap fallback.
  console.warn(
    `⚠️  Network "${network}" dari payload tidak dikenali di CHAINS (fallback ke ${hintChain.label}). ` +
      `Kalau ini seharusnya chain lain, cek nilai ALCHEMY_NETWORK yang sesuai di .env.`
  );
  return hintChain;
}


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

// --- LP Tracking (deteksi add/remove liquidity dari watched wallet) ---
// Discord webhook TERPISAH khusus notifikasi LP. Kalau kosong, fallback ke
// DISCORD_WEBHOOK_URL.
const DISCORD_LP_WEBHOOK_URL = process.env.DISCORD_LP_WEBHOOK_URL || DISCORD_WEBHOOK_URL;

// Kalau true (default), sistem akan cek aktivitas mint/burn TOKEN (bukan NFT)
// dari/ke watched wallet sebagai indikasi add/remove liquidity.
// PENTING: fitur ini butuh webhook Alchemy di-set untuk track kategori "erc20"
// juga (bukan cuma NFT), kalau tidak event mint/burn token tidak akan pernah masuk.
const TRACK_LP_ACTIVITY = process.env.TRACK_LP_ACTIVITY !== "false";

// CATATAN: daftar contract yang di-exclude (LP position) & block explorer
// sekarang didefinisikan PER-CHAIN di object CHAINS di atas.

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
      DISCORD_SUMMARY_WEBHOOK_URL,
      EMBED_COLOR_NEUTRAL
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

  await sendDiscordMessage(message, DISCORD_SUMMARY_WEBHOOK_URL, EMBED_COLOR_INFO);
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

    await sendDiscordMessage(message, DISCORD_THRESHOLD_WEBHOOK_URL, EMBED_COLOR_ALERT);
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
let WALLET_TAGS = {}; // address (lowercase) -> array tag (misal ["KOL"]), maksimal 3

function loadWallets() {
  const filePath = path.join(__dirname, "wallets.json");
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed.wallets) ? parsed.wallets : [];

    const addresses = [];
    const names = {};
    const tags = {};

    list.forEach((entry) => {
      if (typeof entry === "string") {
        const addr = entry.trim().toLowerCase();
        if (addr) addresses.push(addr);
      } else if (entry && typeof entry === "object" && entry.address) {
        const addr = entry.address.trim().toLowerCase();
        if (addr) {
          addresses.push(addr);
          if (entry.name) names[addr] = entry.name;

          if (Array.isArray(entry.tags) && entry.tags.length > 0) {
            let walletTags = entry.tags.map((t) => String(t).trim()).filter(Boolean);

            // Maksimal 3 tag per wallet — potong ke 3 pertama kalau lebih.
            if (walletTags.length > 3) {
              console.warn(
                `⚠️  Wallet ${addr} punya ${walletTags.length} tags, dipotong ke 3 pertama: [${walletTags
                  .slice(0, 3)
                  .join(", ")}]`
              );
              walletTags = walletTags.slice(0, 3);
            }

            if (walletTags.length > 0) tags[addr] = walletTags;
          }
        }
      }
    });

    WATCHED_WALLETS = addresses;
    WALLET_NAMES = names;
    WALLET_TAGS = tags;
  } catch (err) {
    console.warn("⚠️  wallets.json tidak ditemukan/invalid, fallback ke env var WATCHED_WALLETS.");
    WATCHED_WALLETS = (process.env.WATCHED_WALLETS || "")
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean);
    WALLET_NAMES = {};
    WALLET_TAGS = {};
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
//   2. Push address baru itu ke Alchemy webhook (Notify API) supaya Alchemy
//      mulai mengirim event untuk wallet tersebut
//
// CATATAN PENTING: endpoint ini SENGAJA TIDAK mengubah wallets.json.
// wallets.json di-manage manual lewat Git (commit manual), karena kalau
// server (misal di Render tanpa persistent disk) di-restart/redeploy, file
// lokal yang ditulis runtime akan HILANG (balik ke versi terakhir di repo).
// Jadi alur yang benar: push ke Alchemy dulu lewat endpoint ini -> lalu
// tambahkan address yang sama secara manual ke wallets.json -> commit & push
// ke Git supaya WATCHED_WALLETS ikut update saat deploy berikutnya.

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

/** Push address baru ke Alchemy webhook (Notify API) via endpoint
 * update-webhook-addresses, mode APPEND (addresses_to_add), bukan replace.
 * Otomatis dibagi per 500 address per request (limit dari Alchemy). */
async function addAddressesToAlchemyWebhook(addresses, chain) {
  if (!ALCHEMY_AUTH_TOKEN) {
    throw new Error("ALCHEMY_AUTH_TOKEN belum diisi di .env — tidak bisa push ke Alchemy.");
  }
  if (!chain.webhookId) {
    throw new Error(`Webhook ID untuk chain ${chain.label} belum diisi di .env — tidak bisa push.`);
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
        webhook_id: chain.webhookId,
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

/** Push address ke webhook SEMUA chain yang webhookId-nya sudah diisi.
 * Karena wallets.json dipakai bersama lintas chain, address baru didaftarkan
 * ke semua webhook sekaligus. Kegagalan di satu chain tidak membatalkan chain
 * lain — tiap hasil dilaporkan terpisah. */
async function addAddressesToAllChains(addresses) {
  const results = {};

  for (const chain of Object.values(CHAINS)) {
    if (!chain.webhookId) {
      results[chain.key] = { pushed: 0, skipped: true, error: `Webhook ID chain ${chain.label} belum diisi` };
      continue;
    }

    try {
      const { pushed } = await addAddressesToAlchemyWebhook(addresses, chain);
      results[chain.key] = { pushed, error: null };
    } catch (err) {
      console.error(`Gagal push address ke Alchemy (chain ${chain.label}):`, err);
      results[chain.key] = { pushed: 0, error: err.message };
    }
  }

  return results;
}

// Mapping emoji per tag — dipakai sebagai "pengganti warna" (Discord tidak
// bisa render teks/badge berwarna custom per kata di pesan biasa). Tinggal
// tambah/ubah entry di sini kalau mau nambah tag baru atau ganti emoji-nya.
// PENTING: pencocokan case-sensitive — tag di wallets.json harus PERSIS sama
// (misal "Whale" di sini beda dengan "whale" di wallets.json).
const TAG_EMOJI_MAP = {
  KOL: "🟣",
  Whale: "🔴",
  Degen: "🟢",
  Dev: "🔵",
  Team: "🟡",
};
const DEFAULT_TAG_EMOJI = "🏷️"; // fallback buat tag yang tidak ada di TAG_EMOJI_MAP

/** Ambil label tampilan untuk sebuah address: "Nama (0xabcd...wxyz) 🔴 Tag1 🟢 Tag2"
 * kalau ada nama/tag custom, atau alamat penuh kalau tidak ada nama. */
function walletLabel(address) {
  if (!address) return "-";
  const lower = address.toLowerCase();
  const name = WALLET_NAMES[lower];
  const tags = WALLET_TAGS[lower];

  // Tiap tag ditampilkan sebagai "emoji Tag" (emoji berfungsi kayak indikator
  // warna, karena Discord tidak support teks berwarna custom per kata).
  const tagBadges =
    Array.isArray(tags) && tags.length > 0
      ? " " + tags.map((t) => `${TAG_EMOJI_MAP[t] || DEFAULT_TAG_EMOJI} ${t}`).join(" ")
      : "";

  if (!name) return `${address}${tagBadges}`;

  const shortAddr = `${address.slice(0, 6)}...${address.slice(-4)}`;
  return `${name} (${shortAddr})${tagBadges}`;
}

// ---------------------------------------------------------------------------
// MIDDLEWARE
// ---------------------------------------------------------------------------

// PENTING: Alchemy menandatangani body RAW (belum di-parse JSON).
// limit dinaikkan dari default Express (100kb) -> 5mb, karena payload webhook
// Alchemy (terutama batch "activity" dengan banyak event sekaligus) bisa lebih
// besar dari 100kb dan menyebabkan PayloadTooLargeError.
app.use(
  express.json({
    limit: "5mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

function isValidSignature(req, chain = DEFAULT_CHAIN) {
  // Tiap webhook Alchemy punya signing key SENDIRI, jadi key-nya diambil dari
  // config chain yang sesuai dengan endpoint yang menerima request ini.
  const signingKey = chain.signingKey;
  if (!signingKey) return true; // skip validasi kalau belum diset (mode dev)

  const signature = req.headers["x-alchemy-signature"];
  if (!signature) {
    console.warn("⚠️  Header x-alchemy-signature tidak ada di request.");
    return false;
  }

  const hmac = crypto.createHmac("sha256", signingKey);
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
async function isRealPurchaseTx(txHash, chain = DEFAULT_CHAIN) {
  try {
    const [txRes, receiptRes] = await Promise.all([
      fetch(chain.rpcApiBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getTransactionByHash",
          params: [txHash],
        }),
      }),
      fetch(chain.rpcApiBase, {
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
// LP TRACKING: deteksi add/remove liquidity dari watched wallet
// ---------------------------------------------------------------------------
// Beda dari NFT: LP token/position BISA berbentuk NFT (Uniswap v4 Position
// Manager) TAPI mayoritas AMM (Uniswap v2 & fork-nya) pakai LP token fungible
// (ERC-20) biasa, bukan NFT. Jadi kita TIDAK mengandalkan tokenId (NFT), tapi
// mengandalkan pola universal: mint/burn (Transfer dari/ke zero address) untuk
// token APAPUN (NFT maupun ERC-20) yang melibatkan watched wallet.
//
// Supaya tidak salah tangkap (mint/burn token biasa seperti airdrop/claim/wrap
// bukan LP), kita verifikasi lewat function selector (4 byte pertama dari
// tx.input) — dicocokkan ke daftar fungsi yang dikenal umum dipakai buat
// add/remove liquidity di DEX (Uniswap v2 style Router + variannya, plus
// multicall yang biasa dipakai Router/PositionManager Uniswap v3/v4).
//
// Selector di bawah ini dihitung dari keccak256(function signature) asli
// (bukan tebakan), jadi dijamin akurat untuk signature yang tercantum.
const LP_FUNCTION_SELECTORS = {
  "0xe8e33700": "addLiquidity",
  "0xf305d719": "addLiquidityETH",
  "0xbaa2abde": "removeLiquidity",
  "0x02751cec": "removeLiquidityETH",
  "0x2195995c": "removeLiquidityWithPermit",
  "0xded9382a": "removeLiquidityETHWithPermit",
  "0x6a627842": "mint (pair-level)",
  "0x89afcb44": "burn (pair-level)",
  "0xac9650d8": "multicall", // umum dipakai Router/PositionManager Uniswap v3/v4
  "0x5ae401dc": "multicall (with deadline)",
};

/** Ambil function selector (4 byte pertama tx.input) dari suatu tx via RPC,
 * lalu cocokkan ke LP_FUNCTION_SELECTORS. Return { matched, selector, functionName }. */
async function detectLpFunctionSelector(txHash, chain = DEFAULT_CHAIN) {
  try {
    const res = await fetch(chain.rpcApiBase, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getTransactionByHash",
        params: [txHash],
      }),
    });
    const data = await res.json();
    const input = data?.result?.input;

    if (!input || input.length < 10) {
      return { matched: false, selector: null, functionName: null };
    }

    const selector = input.slice(0, 10).toLowerCase(); // "0x" + 8 hex char
    const functionName = LP_FUNCTION_SELECTORS[selector];

    return { matched: Boolean(functionName), selector, functionName: functionName || null };
  } catch (err) {
    console.error(`Gagal cek function selector untuk tx ${txHash}:`, err);
    return { matched: false, selector: null, functionName: null };
  }
}

async function handleLpActivityDetected({
  isAdd,
  watchedWallet,
  contractAddress,
  tokenId,
  txHash,
  skipSelectorCheck = false,
  chain = DEFAULT_CHAIN,
}) {
  const watchedLabel = walletLabel(watchedWallet);
  const txUrl = `${chain.explorerTxBase}/${txHash}`;

  let selectorCheck = { matched: true, selector: null, functionName: null };
  if (!skipSelectorCheck) {
    selectorCheck = await detectLpFunctionSelector(txHash, chain);
    if (!selectorCheck.matched) {
      console.log(
        `ℹ️  Mint/burn token terdeteksi tapi function selector (${selectorCheck.selector || "-"}) ` +
          `tidak cocok pola LP yang dikenal, di-skip — Wallet: ${watchedLabel}, Tx: ${txUrl}`
      );
      return;
    }
  }

  // Kalau posisi LP-nya berbentuk NFT (ada tokenId, misal Uniswap v4 Position
  // Manager), ambil metadata NFT-nya — assetName biasanya sudah berisi info
  // pair/fee/price-range (contoh: "Uniswap - 4% - +/USDG - 1019.7<>1785.1").
  let pairInfo = null;
  if (tokenId) {
    try {
      const { assetName } = await fetchNftInfo(contractAddress, tokenId, chain);
      pairInfo = assetName || null;
    } catch (err) {
      console.error(`Gagal ambil metadata posisi LP (tokenId ${tokenId}):`, err);
    }
  }

  const actionLabel = isAdd ? "Menambah Liquidity" : "Menarik Liquidity";
  const emoji = isAdd ? "🟢" : "🔴";

  console.log(`${emoji} Kemungkinan ${actionLabel} terdeteksi — Wallet: ${watchedLabel}, Tx: ${txUrl}`);

  const message =
    `${emoji} **Kemungkinan ${actionLabel}!**\n` +
    `Chain    : ${chain.label}\n` +
    `Wallet   : ${watchedLabel}\n` +
    `Contract (LP Token/Position): \`${contractAddress}\`\n` +
    (pairInfo ? `Pair     : \`${pairInfo}\`\n` : "") +
    (selectorCheck.functionName
      ? `Function : ${selectorCheck.functionName} (${selectorCheck.selector})\n`
      : "") +
    `Tx       : ${txUrl}`;

  await sendDiscordMessage(message, DISCORD_LP_WEBHOOK_URL, isAdd ? EMBED_COLOR_BUY : EMBED_COLOR_SELL);
}

// ---------------------------------------------------------------------------
// NFT METADATA LOOKUP (Asset name & Collection name)
// ---------------------------------------------------------------------------

/**
 * Ambil nama NFT (asset) dan nama koleksi dari Alchemy NFT API.
 * Kalau ALCHEMY_API_KEY belum diisi atau request gagal, return fallback null
 * supaya notifikasi tetap terkirim (cuma tanpa nama asset/collection).
 */
async function fetchNftInfo(contractAddress, tokenId, chain = DEFAULT_CHAIN) {
  // Sebagian chain (misal Arc) belum didukung NFT API Alchemy — di situ kita
  // langsung return kosong supaya tidak buang-buang request ke endpoint yang
  // pasti gagal. Notifikasi tetap jalan, cuma tanpa nama collection/asset/gambar.
  if (!chain.nftApiEnabled) {
    return { assetName: null, collectionName: null, openSeaSlug: null, imageUrl: null };
  }

  if (!ALCHEMY_API_KEY || !contractAddress || tokenId === undefined) {
    return { assetName: null, collectionName: null, openSeaSlug: null, imageUrl: null };
  }

  try {
    const url = `${chain.nftApiBase}/getNFTMetadata?contractAddress=${contractAddress}&tokenId=${tokenId}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`⚠️  NFT API respon ${res.status} untuk ${contractAddress} #${tokenId}`);
      return { assetName: null, collectionName: null, openSeaSlug: null, imageUrl: null };
    }
    const data = await res.json();

    const assetName = data?.name || data?.raw?.metadata?.name || null;
    const openSeaMeta = data?.contract?.openSeaMetadata;
    const collectionName = openSeaMeta?.collectionName || data?.contract?.name || null;
    const openSeaSlug = openSeaMeta?.collectionSlug || null;
    const imageUrl =
      data?.image?.cachedUrl || data?.image?.thumbnailUrl || data?.image?.originalUrl || null;

    return { assetName, collectionName, openSeaSlug, imageUrl };
  } catch (err) {
    console.warn("⚠️  Gagal fetch NFT metadata:", err.message);
    return { assetName: null, collectionName: null, openSeaSlug: null, imageUrl: null };
  }
}

// ---------------------------------------------------------------------------
// DISCORD NOTIFICATIONS
// ---------------------------------------------------------------------------

// Warna default embed Discord (dipakai kalau caller tidak spesifik warna).
const EMBED_COLOR_DEFAULT = 0x5865f2; // Discord blurple
const EMBED_COLOR_BUY = 0x0000FF; // hijau
const EMBED_COLOR_SELL = 0xe74c3c; // merah
const EMBED_COLOR_MINT = 0xf1c40f; // kuning/emas
const EMBED_COLOR_INFO = 0x3498db; // biru (summary, info umum)
const EMBED_COLOR_NEUTRAL = 0x99aab5; // abu-abu (misal "tidak ada aktivitas")
const EMBED_COLOR_ALERT = 0xe67e22; // oranye (threshold alert)

async function sendDiscordMessage(content, webhookUrl = DISCORD_WEBHOOK_URL, color = EMBED_COLOR_DEFAULT) {
  if (!webhookUrl) return;

  const rolePrefix = DISCORD_ROLE_ID ? `<@&${DISCORD_ROLE_ID}> ` : "";

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // "content" sekarang cuma dipakai buat ping role (kalau ada) — pesan
        // utamanya ditaruh di "embeds" (description) supaya tampil sebagai
        // card berwarna di Discord, bukan teks polos.
        content: rolePrefix || undefined,
        embeds: [
          {
            description: content,
            color,
            timestamp: new Date().toISOString(),
          },
        ],
        // allowed_mentions eksplisit supaya role benar-benar ke-notif (ping),
        // bukan cuma teks <@&ID> yang tampil sebagai teks biasa.
        allowed_mentions: { parse: ["roles"] },
      }),
    });
  } catch (err) {
    console.error("Gagal kirim notifikasi Discord:", err);
  }
}

/** Kirim embed Discord LENGKAP (title, fields, thumbnail, footer) — beda dari
 * sendDiscordMessage() yang cuma kirim teks polos di "description". Dipakai
 * buat notif yang butuh tampilan field-based rapi kayak card (misal buy/sell NFT). */
async function sendDiscordEmbed(embed, webhookUrl = DISCORD_WEBHOOK_URL) {
  if (!webhookUrl) return;

  const rolePrefix = DISCORD_ROLE_ID ? `<@&${DISCORD_ROLE_ID}> ` : "";

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: rolePrefix || undefined,
        embeds: [{ timestamp: new Date().toISOString(), ...embed }],
        allowed_mentions: { parse: ["roles"] },
      }),
    });
  } catch (err) {
    console.error("Gagal kirim notifikasi Discord (embed):", err);
  }
}


async function handleMintDetected({ contractAddress, tokenId, mintedTo, txHash, chain = DEFAULT_CHAIN }) {
  const { assetName, collectionName, openSeaSlug } = await fetchNftInfo(contractAddress, tokenId, chain);

  console.log("🎨 MINT TERDETEKSI (masuk buffer)");
  console.log(`   Contract     : ${contractAddress}`);
  console.log(`   Token ID     : ${tokenId}`);
  console.log(`   Minted from  : ${walletLabel(mintedTo)}`);
  console.log(`   Chain        : ${chain.label}`);
  console.log(`   Tx           : ${chain.explorerTxBase}/${txHash}`);
  console.log("----------------------------------------");

  // Key sertakan chain supaya mint dengan contract+wallet sama di chain berbeda
  // tidak tergabung jadi satu ringkasan.
  const key = `${chain.key}|${contractAddress}|${mintedTo}`;

  if (!mintBuffer.has(key)) {
    mintBuffer.set(key, {
      contractAddress,
      mintedTo,
      collectionName,
      openSeaSlug,
      chain,
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
  const chain = entry.chain || DEFAULT_CHAIN;
  const txLinks = [...entry.txHashes].map((h) => `${chain.explorerTxBase}/${h}`);
  const openSeaLine = entry.openSeaSlug
    ? `\nOpenSea : https://opensea.io/assets/${chain.key}/${entry.contractAddress}`
    : "";

  let message;

  if (count === 1) {
    // Cuma 1 mint -> format seperti biasa
    message =
      `🎨 **Mint baru terdeteksi!**\n` +
      `Chain : \`${chain.label}\`\n` +
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
      `Chain : \`${chain.label}\`\n` +
      `Contract : \`${entry.contractAddress}\`\n` +
      `Collection : \`${entry.collectionName || "-"}\`\n` +
      `Minted from : \`${mintedFromLabel}\`\n` +
      `Total Minted : ${count}\n` +
      `Assets : ${listedTokens}${extra}\n` +
      `Tx : ${txText}` +
      openSeaLine;
  }

  console.log(`📬 Mengirim ringkasan mint (${count}x) untuk key ${key}`);
  await sendDiscordMessage(message, DISCORD_WEBHOOK_URL, EMBED_COLOR_MINT);
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
  chain = DEFAULT_CHAIN,
}) {
  const watchedLabel = walletLabel(watchedWallet);
  // OUTGOING (NFT keluar dari watched wallet) = indikasi SELL
  // INCOMING (NFT masuk ke watched wallet) = indikasi BUY
  const isSell = direction === "OUTGOING";
  const label = isSell ? "SELL" : "BUY";
  const emoji = isSell ? "🔴" : "🟢";
  const actionText = isSell ? "menjual" : "membeli";
  const txUrl = `${chain.explorerTxBase}/${txHash}`;

  // Filter NFT yang sebenarnya BUKAN collectible, tapi representasi posisi LP
  // (misal Uniswap v4 Position Manager) — supaya add/remove liquidity tidak
  // salah kena notif "jual/beli NFT". Dicek dari daftar contract di EXCLUDED_NFT_CONTRACTS.
  if (chain.excludedNftContracts.has((contractAddress || "").toLowerCase())) {
    console.log(
      `ℹ️  NFT ${label} diabaikan (contract ada di EXCLUDED_NFT_CONTRACTS, kemungkinan LP position, bukan NFT collectible) — Tx: ${txUrl}`
    );
    return;
  }

  // Filter BURN (NFT dikirim KE zero address) — ini bukan "jual ke wallet lain",
  // tapi NFT-nya dihancurkan (misal saat tarik liquidity di Uniswap v4 Position
  // Manager, posisi NFT-nya di-burn). Mirip logic isMintEvent() tapi arah sebaliknya.
  if (toAddress === ZERO_ADDRESS) {
    console.log(`ℹ️  NFT ${label} diabaikan (NFT di-burn ke zero address, bukan dijual ke wallet lain) — Tx: ${txUrl}`);
    return;
  }

  // Filter transfer NFT biasa (hibah/airdrop/kirim manual) yang BUKAN benar-benar
  // jual-beli — kalau tidak ada pembayaran (native value / token ERC20) yang
  // menyertai NFT dalam transaksi yang sama, transaksi ini di-skip total
  // (tidak dianggap BUY/SELL, tidak masuk summary/threshold, tidak kirim notif).
  if (TRACK_ONLY_REAL_TRADES) {
    const isRealTrade = await isRealPurchaseTx(txHash, chain);
    if (!isRealTrade) {
      console.log(
        `ℹ️  NFT ${label} diabaikan (tidak ada pembayaran terdeteksi, kemungkinan transfer/hibah biasa) — Tx: ${txUrl}`
      );
      return;
    }
  }

  const { assetName, collectionName, openSeaSlug, imageUrl } = await fetchNftInfo(contractAddress, tokenId, chain);
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
  // Key sertakan label chain supaya collection dengan nama sama di chain berbeda
  // tidak tergabung statistiknya.
  const collectionKey = `${chain.label} • ${collectionName || contractAddress}`;
  recordTransactionForSummary({ collectionKey, isSell, watchedLabel });

  // Cek juga apakah threshold wallet "compak" beli/jual sudah tercapai (alert instan terpisah).
  recordAndCheckThreshold({ collectionKey, isSell, watchedLabel }).catch((err) => {
    console.error("Gagal memproses threshold alert:", err);
  });

  // Format "NFT TRANSFER OUT/IN" field-based, mengikuti referensi card yang
  // dikasih user — title, description (wallet + tag), lalu fields sejajar
  // (NFT/Collection/Chain, From/To), dan link (OpenSea + Tx) di 1 field.
  const linksParts = [`[Tx](${txUrl})`];
  linksParts.push(`[OpenSea](https://opensea.io/assets/${chain.key}/${contractAddress})`);

  const embed = {
    title: isSell ? "NFT Sell" : "NFT BUY",
    description: watchedLabel,
    color: isSell ? EMBED_COLOR_SELL : EMBED_COLOR_BUY,
    fields: [
      { name: "NFT", value: asset, inline: true },
      { name: "Collection", value: collectionName || "-", inline: true },
      { name: "Chain", value: chain.label, inline: true },
      { name: "From", value: walletLabel(fromAddress), inline: true },
      { name: "To", value: walletLabel(toAddress), inline: true },
      { name: "\u200b", value: "\u200b", inline: true }, // spacer biar grid tetap 3 kolom rapi
      { name: "Links", value: linksParts.join(" · "), inline: false },
    ],
  };

  if (imageUrl) {
    embed.thumbnail = { url: imageUrl };
  }

  await sendDiscordEmbed(embed, DISCORD_TRADES_WEBHOOK_URL);
}

// ---------------------------------------------------------------------------
// SHARED PAYLOAD PROCESSOR — dipakai oleh semua route webhook
// ---------------------------------------------------------------------------

async function processActivities(activities, chain = DEFAULT_CHAIN) {
  for (const activity of activities) {
    const fromAddress = (activity.fromAddress || activity.from || "").toLowerCase();
    const toAddress = (activity.toAddress || activity.to || "").toLowerCase();

    const tokenId =
      activity.tokenId || activity.erc721TokenId || activity.erc1155Metadata?.[0]?.tokenId;
    const isNft = Boolean(tokenId);
    const contractAddress = activity.contractAddress || activity.rawContract?.address;

    // Kasus 0: kemungkinan LP add/remove. Ini mencakup DUA bentuk:
    //   (a) TOKEN NON-NFT (ERC-20 LP token, misal Uniswap v2-style) — mint/burn
    //       dari/ke watched wallet, diverifikasi lewat function selector.
    //   (b) NFT dari contract yang ada di EXCLUDED_NFT_CONTRACTS (misal Uniswap
    //       v4 Position Manager) — mint/burn NFT posisi LP, BUKAN NFT collectible,
    //       jadi TIDAK boleh nyasar ke Kasus 1 (mint NFT) atau Kasus 2 (buy/sell NFT).
    // Dicek SEBELUM Kasus 1 & Kasus 2 supaya mint/burn LP (baik ERC-20 maupun NFT)
    // tidak "ketelan" jadi notif mint/buy/sell biasa.
    const isExcludedLpContract = chain.excludedNftContracts.has((contractAddress || "").toLowerCase());

    if (TRACK_LP_ACTIVITY && (!isNft || isExcludedLpContract)) {
      const isLpMint = isMintEvent(fromAddress) && WATCHED_WALLETS.includes(toAddress);
      const isLpBurn = toAddress === ZERO_ADDRESS && WATCHED_WALLETS.includes(fromAddress);

      if (isLpMint || isLpBurn) {
        await handleLpActivityDetected({
          isAdd: isLpMint,
          watchedWallet: isLpMint ? toAddress : fromAddress,
          contractAddress,
          tokenId, // kalau ada (NFT-based LP position, misal Uniswap v4), dipakai buat ambil metadata pair
          txHash: activity.hash,
          // Kalau contract-nya sudah PASTI dikenal sebagai LP position manager
          // (ada di EXCLUDED_NFT_CONTRACTS), skip verifikasi function selector —
          // kita sudah cukup yakin ini LP tanpa perlu cek lagi.
          skipSelectorCheck: isExcludedLpContract,
          chain,
        });
        continue;
      }

      // PENTING: Kasus 1 di bawah (mint tracker) TIDAK mengecek watched wallet
      // sama sekali (memang didesain notif SEMUA mint dari contract yang dipantau
      // Alchemy, bukan cuma dari watched wallet). Jadi kalau mint/burn ini dari
      // contract yang SUDAH PASTI dikenal sebagai LP position (bukan collectible),
      // tetap harus di-skip di sini juga — supaya tidak "ketelan" ke mint tracker
      // meskipun wallet-nya bukan watched wallet (makanya tidak match isLpMint/isLpBurn
      // di atas, yang mensyaratkan watched wallet).
      if (isExcludedLpContract) {
        console.log(
          `ℹ️  Mint/burn dari contract LP (${contractAddress}) diabaikan dari mint tracker (bukan watched wallet, tidak ada notif LP juga).`
        );
        continue;
      }
    }

    // Kasus 1: MINT (from == zero address)
    if (isMintEvent(fromAddress)) {
      await handleMintDetected({
        contractAddress,
        tokenId,
        mintedTo: toAddress,
        txHash: activity.hash,
        chain,
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
      chain,
    });
  }
}

/** Bikin handler webhook untuk satu chain. Dibuat sebagai factory supaya tiap
 * endpoint tahu persis chain-nya (dan otomatis pakai signing key yang benar,
 * karena tiap webhook Alchemy punya signing key sendiri-sendiri). */
function makeWebhookHandler(hintChain) {
  return function handleWebhookRequest(req, res) {
    // PENTING: resolve chain dari ISI PAYLOAD dulu (sebelum cek signature),
    // karena tiap chain punya signing key SENDIRI — kalau kita validasi pakai
    // signing key chain yang salah (misal webhook ARC yang nyasar ke endpoint
    // Robinhood), signature-nya akan SELALU dianggap invalid. Dengan resolve
    // dari payload duluan, signing key yang dipakai otomatis benar walau
    // URL webhook-nya "salah" alamat (yang memang tidak bisa diubah di Alchemy).
    const chain = resolveChainFromPayload(req.body, hintChain);

    if (!isValidSignature(req, chain)) {
      console.warn(`Signature tidak valid (chain: ${chain.label}), request ditolak.`);
      return res.status(401).send("Invalid signature");
    }

    // Balas 200 secepatnya supaya Alchemy tidak retry / dianggap gagal.
    // DEBUG SEMENTARA: log full payload biar bisa lihat semua field/variable
    // yang dikirim Alchemy (network, activity[].category, dll). Aktifkan
    // dengan set DEBUG_WEBHOOK_PAYLOAD=true di .env, MATIKAN lagi setelah
    // selesai debug (log bisa penuh & ada data address wallet di dalamnya).
    if (process.env.DEBUG_WEBHOOK_PAYLOAD === "true") {
      console.log(`📦 RAW PAYLOAD (chain hint: ${chain.label}):`, JSON.stringify(req.body, null, 2));
    }

    res.status(200).send("OK");

    const { event } = req.body;
    const activities = event?.activity || [];

    if (activities.length === 0) {
      console.log("⚠️  Tidak ada 'activity' di payload:", JSON.stringify(req.body, null, 2));
      return;
    }

    processActivities(activities, chain).catch((err) => {
      console.error(`Gagal memproses payload webhook (chain: ${chain.label}):`, err);
    });
  };
}

// ---------------------------------------------------------------------------
// ROUTES
// ---------------------------------------------------------------------------

// Endpoint LAMA (tanpa prefix chain) -> tetap ke Robinhood, supaya webhook
// Alchemy yang sudah terdaftar tidak perlu diubah sama sekali.
app.post("/webhook/nft-mint", makeWebhookHandler(CHAINS.robinhood));
app.post("/webhook/wallet-activity", makeWebhookHandler(CHAINS.robinhood));

// Endpoint eksplisit per chain. Untuk webhook Alchemy chain ARC, arahkan ke
// /webhook/arc/wallet-activity (dan /webhook/arc/nft-mint kalau dipisah).
app.post("/webhook/robinhood/nft-mint", makeWebhookHandler(CHAINS.robinhood));
app.post("/webhook/robinhood/wallet-activity", makeWebhookHandler(CHAINS.robinhood));
app.post("/webhook/arc/nft-mint", makeWebhookHandler(CHAINS.arc));
app.post("/webhook/arc/wallet-activity", makeWebhookHandler(CHAINS.arc));
app.post("/", makeWebhookHandler(DEFAULT_CHAIN)); // alias root -> chain default (Robinhood)

app.get("/", (req, res) => {
  res.send(`NFT Mint & Wallet Activity Webhook aktif ✅ (chain: ${Object.values(CHAINS).map((c) => c.label).join(", ")})`);
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", time: new Date().toISOString() });
});

// Reload wallets.json tanpa perlu restart server (opsional, akses manual kalau perlu)
app.post("/admin/reload-wallets", (req, res) => {
  loadWallets();
  res.status(200).json({ total: WATCHED_WALLETS.length });
});

// DEBUG: cek response mentah NFT API Alchemy langsung dari browser, tanpa perlu
// curl manual. Contoh: /admin/debug-nft?chain=robinhood&contract=0xabc...&tokenId=1
app.get("/admin/debug-nft", async (req, res) => {
  const { chain: chainKey, contract, tokenId } = req.query;
  const chain = CHAINS[chainKey] || DEFAULT_CHAIN;

  if (!contract || tokenId === undefined) {
    return res.status(400).json({
      error: "Wajib isi query param 'contract' dan 'tokenId'.",
      contoh: "/admin/debug-nft?chain=robinhood&contract=0xabc...&tokenId=1",
      chainTersedia: Object.keys(CHAINS),
    });
  }

  if (!chain.nftApiEnabled) {
    return res.status(200).json({
      warning: `NFT API belum diaktifkan untuk chain ${chain.label} (nftApiEnabled: false).`,
      chain: chain.label,
    });
  }

  try {
    const url = `${chain.nftApiBase}/getNFTMetadata?contractAddress=${contract}&tokenId=${tokenId}`;
    const apiRes = await fetch(url);
    const data = await apiRes.json();
    res.status(200).json({ chain: chain.label, status: apiRes.status, raw: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk-add wallet dari file .txt. Format tiap baris: "0xAddress" atau
// "0xAddress,Nama Wallet" (nama opsional; nama saat ini tidak dipakai di sini,
// hanya diparse untuk kenyamanan kalau file yang sama nanti mau kamu copy-paste
// ke wallets.json secara manual).
//
// Endpoint ini HANYA push address ke Alchemy webhook (Notify API), mode
// append/tambah (bukan replace) — TIDAK mengubah wallets.json.
// wallets.json tetap kamu update MANUAL & commit ke Git, supaya tidak hilang
// saat server restart/redeploy (misal di Render tanpa persistent disk) dan
// supaya histori perubahan wallet tetap tercatat rapi di Git.
//
// Alur yang disarankan:
//   1. Panggil endpoint ini dulu -> address langsung aktif dipantau Alchemy
//   2. Tambahkan address yang sama ke wallets.json secara manual
//   3. Commit & push ke Git -> Render auto-deploy -> WATCHED_WALLETS ikut update
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

  // Cek terhadap WATCHED_WALLETS yang SEDANG di-load (dari wallets.json saat ini)
  // supaya tidak push ulang address yang sudah dipantau. Ini hanya pengecekan
  // in-memory, TIDAK menulis apapun ke wallets.json.
  const currentSet = new Set(WATCHED_WALLETS.map((a) => a.toLowerCase()));
  const newAddresses = [];
  const alreadyWatched = [];
  for (const { address } of valid) {
    if (currentSet.has(address)) {
      alreadyWatched.push(address);
    } else {
      newAddresses.push(address);
    }
  }

  // Push ke webhook SEMUA chain (Robinhood + ARC), karena wallets.json dipakai bersama.
  let alchemyResult = {};
  if (newAddresses.length > 0) {
    alchemyResult = await addAddressesToAllChains(newAddresses);
  }

  res.status(200).json({
    totalDiFile: valid.length + invalid.length,
    validDiFile: valid.length,
    invalidLines: invalid, // baris yang formatnya bukan address EVM valid
    sudahAdaDiWatchedWallets: alreadyWatched.length,
    dipushKeAlchemy: newAddresses.length,
    alchemy: alchemyResult,
    reminder:
      "wallets.json TIDAK diubah otomatis. Tambahkan address di atas secara manual ke wallets.json lalu commit & push ke Git.",
  });
});

app.listen(PORT, () => {
  console.log(`Server jalan di http://localhost:${PORT}`);
  console.log(`Endpoint webhook (mint)           : http://localhost:${PORT}/webhook/nft-mint`);
  console.log(`Endpoint webhook (wallet activity): http://localhost:${PORT}/webhook/wallet-activity`);
});
