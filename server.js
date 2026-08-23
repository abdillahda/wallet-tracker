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

// Discord webhook URL KHUSUS untuk notifikasi NFT buy/sell (beda channel dari mint).
// Kalau kosong, fallback ke DISCORD_WEBHOOK_URL yang sama (jadi 1 channel saja).
const DISCORD_TRADES_WEBHOOK_URL = process.env.DISCORD_TRADES_WEBHOOK_URL || DISCORD_WEBHOOK_URL;

// Kalau true, notifikasi buy/sell NFT dikirim (transfer masuk/keluar wallet
// dipantau, khusus NFT — token/USDC biasa di-skip). Default: true, karena ini
// memang fitur yang mau dipakai untuk deteksi buy/sell.
const TRACK_WALLET_ACTIVITY = process.env.TRACK_WALLET_ACTIVITY !== "false";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ---------------------------------------------------------------------------
// KONFIGURASI MULTI-CHAIN
// ---------------------------------------------------------------------------
// Tiap chain punya signing key, channel Discord, NFT API base, block explorer,
// dan file wallets sendiri-sendiri — supaya Robinhood Chain (existing) dan
// Ink (baru) sama sekali tidak saling ganggu.
const CHAINS = {
  robinhood: {
    signingKey: SIGNING_KEY,
    discordWebhookUrl: DISCORD_WEBHOOK_URL,
    discordTradesWebhookUrl: DISCORD_TRADES_WEBHOOK_URL,
    nftApiBase: `https://robinhood-mainnet.g.alchemy.com/nft/v3/${ALCHEMY_API_KEY}`,
    explorerTxBase: "https://robinhoodchain.blockscout.com/tx",
    openSeaBase: "https://opensea.io/collection",
    walletsFile: "wallets.json",
  },
  ink: {
    signingKey: process.env.ALCHEMY_SIGNING_KEY_INK,
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL_INK,
    discordTradesWebhookUrl: process.env.DISCORD_TRADES_WEBHOOK_URL_INK || process.env.DISCORD_WEBHOOK_URL_INK,
    // ALCHEMY_API_KEY_INK opsional -- kalau kosong, fallback pakai API key yang sama
    nftApiBase: `https://ink-mainnet.g.alchemy.com/nft/v3/${process.env.ALCHEMY_API_KEY_INK || ALCHEMY_API_KEY}`,
    explorerTxBase: "https://explorer.inkonchain.com/tx",
    openSeaBase: "https://opensea.io/collection",
    walletsFile: "wallets-ink.json",
  },
};

// ---------------------------------------------------------------------------
// BATCHING UNTUK MINT BERUNTUN
// ---------------------------------------------------------------------------
// Kalau ada beberapa mint dari kontrak+wallet yang sama dalam waktu singkat,
// digabung jadi 1 pesan ringkasan alih-alih dikirim satu-satu. Timer di-reset
// tiap ada mint baru masuk, ringkasan dikirim setelah "sepi" selama delay ini.
const MINT_BATCH_DELAY_MS = Number(process.env.MINT_BATCH_DELAY_MS || 8000); // default 8 detik

// key: `${chain}|${contractAddress}|${mintedTo}` -> { tokenIds, txHashes, collectionName, timer }
const mintBuffer = new Map();

// ---------------------------------------------------------------------------
// LOAD DAFTAR WALLET YANG DIPANTAU (per-chain, dari file JSON masing-masing)
// ---------------------------------------------------------------------------
// Format file wallets mendukung 2 bentuk per entry:
//   "0xabc..."                                    -> tanpa nama custom
//   { "address": "0xabc...", "name": "Dompet A" }  -> dengan nama custom
//
// Bisa lebih dari 10 wallet, tinggal tambah baris di file, tidak perlu ubah
// env var atau kode. Robinhood pakai wallets.json, Ink pakai wallets-ink.json.

const WALLETS = {}; // chain -> { addresses: [...], names: {...} }

function loadWalletsForChain(chain) {
  const config = CHAINS[chain];
  const filePath = path.join(__dirname, config.walletsFile);

  let addresses = [];
  let names = {};

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed.wallets) ? parsed.wallets : [];

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
  } catch (err) {
    console.warn(`⚠️  ${config.walletsFile} tidak ditemukan/invalid untuk chain '${chain}'.`);
  }

  WALLETS[chain] = { addresses, names };
  console.log(`📋 [${chain}] Total wallet yang dipantau: ${addresses.length}`);
}

function loadAllWallets() {
  Object.keys(CHAINS).forEach(loadWalletsForChain);
}

loadAllWallets();

/** Ambil label tampilan untuk sebuah address: "Nama (0xabcd...wxyz)" kalau ada
 * nama custom, atau alamat penuh kalau tidak ada nama. */
function walletLabel(chain, address) {
  if (!address) return "-";
  const lower = address.toLowerCase();
  const name = WALLETS[chain]?.names?.[lower];
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

function isValidSignature(req, signingKey = SIGNING_KEY) {
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
// NFT METADATA LOOKUP (Asset name & Collection name)
// ---------------------------------------------------------------------------

/**
 * Ambil nama NFT (asset) dan nama koleksi dari Alchemy NFT API.
 * Kalau ALCHEMY_API_KEY belum diisi atau request gagal, return fallback null
 * supaya notifikasi tetap terkirim (cuma tanpa nama asset/collection).
 */
async function fetchNftInfo(chain, contractAddress, tokenId) {
  const nftApiBase = CHAINS[chain].nftApiBase;
  if (!ALCHEMY_API_KEY || !contractAddress || tokenId === undefined) {
    return { assetName: null, collectionName: null, openSeaSlug: null };
  }

  try {
    const url = `${nftApiBase}/getNFTMetadata?contractAddress=${contractAddress}&tokenId=${tokenId}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`⚠️  [${chain}] NFT API respon ${res.status} untuk ${contractAddress} #${tokenId}`);
      return { assetName: null, collectionName: null, openSeaSlug: null };
    }
    const data = await res.json();

    const assetName = data?.name || data?.raw?.metadata?.name || null;
    const openSeaMeta = data?.contract?.openSeaMetadata;
    const collectionName = openSeaMeta?.collectionName || data?.contract?.name || null;
    const openSeaSlug = openSeaMeta?.collectionSlug || null;

    return { assetName, collectionName, openSeaSlug };
  } catch (err) {
    console.warn(`⚠️  [${chain}] Gagal fetch NFT metadata:`, err.message);
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

async function handleMintDetected({ chain, contractAddress, tokenId, mintedTo, txHash }) {
  const { assetName, collectionName, openSeaSlug } = await fetchNftInfo(chain, contractAddress, tokenId);
  const explorerTxBase = CHAINS[chain].explorerTxBase;

  console.log(`🎨 [${chain}] MINT TERDETEKSI (masuk buffer)`);
  console.log(`   Contract     : ${contractAddress}`);
  console.log(`   Token ID     : ${tokenId}`);
  console.log(`   Minted from  : ${walletLabel(chain, mintedTo)}`);
  console.log(`   Tx           : ${explorerTxBase}/${txHash}`);
  console.log("----------------------------------------");

  const key = `${chain}|${contractAddress}|${mintedTo}`;

  if (!mintBuffer.has(key)) {
    mintBuffer.set(key, {
      chain,
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

  const chain = entry.chain;
  const chainConfig = CHAINS[chain];
  const mintedFromLabel = walletLabel(chain, entry.mintedTo);
  const count = entry.tokenIds.length;
  const txLinks = [...entry.txHashes].map((h) => `${chainConfig.explorerTxBase}/${h}`);
  const openSeaLine = entry.openSeaSlug
    ? `\nOpenSea : ${chainConfig.openSeaBase}/${entry.openSeaSlug}`
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

  console.log(`📬 [${chain}] Mengirim ringkasan mint (${count}x) untuk key ${key}`);
  await sendDiscordMessage(message, chainConfig.discordWebhookUrl);
}

async function handleWalletActivityDetected({
  chain,
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
  const chainConfig = CHAINS[chain];
  const watchedLabel = walletLabel(chain, watchedWallet);
  // OUTGOING (NFT keluar dari watched wallet) = indikasi SELL
  // INCOMING (NFT masuk ke watched wallet) = indikasi BUY
  const isSell = direction === "OUTGOING";
  const label = isSell ? "SELL" : "BUY";
  const emoji = isSell ? "🔴" : "🟢";
  const actionText = isSell ? "menjual" : "membeli";
  const txUrl = `${chainConfig.explorerTxBase}/${txHash}`;

  const { assetName, collectionName, openSeaSlug } = await fetchNftInfo(chain, contractAddress, tokenId);
  const asset = assetName || `Token ID ${tokenId}`;

  console.log(`${emoji} [${chain}] NFT ${label} TERDETEKSI (wallet: ${watchedLabel})`);
  console.log(`   Contract : ${contractAddress}`);
  console.log(`   Asset    : ${asset}`);
  console.log(`   From     : ${walletLabel(chain, fromAddress)}`);
  console.log(`   To       : ${walletLabel(chain, toAddress)}`);
  console.log(`   Tx       : ${txUrl}`);
  if (collectionName) console.log(`   Collection: ${collectionName}`);
  console.log("----------------------------------------");

  const message =
    `${emoji} **Kemungkinan ${actionText} NFT!**\n` +
    `Wallet : \`${watchedLabel}\`\n` +
    `Contract : \`${contractAddress}\`\n` +
    `Asset : \`${asset}\`\n` +
    `From : \`${walletLabel(chain, fromAddress)}\`\n` +
    `To : \`${walletLabel(chain, toAddress)}\`\n` +
    `Tx : ${txUrl}` +
    (collectionName ? `\nCollection : \`${collectionName}\`` : "") +
    (openSeaSlug ? `\nOpenSea : ${chainConfig.openSeaBase}/${openSeaSlug}` : "");

  await sendDiscordMessage(message, chainConfig.discordTradesWebhookUrl);
}

// ---------------------------------------------------------------------------
// SHARED PAYLOAD PROCESSOR — dipakai oleh semua route webhook
// ---------------------------------------------------------------------------

async function processActivities(chain, activities) {
  const watchedWallets = WALLETS[chain]?.addresses || [];

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
        chain,
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

    const isFromWatched = watchedWallets.includes(fromAddress);
    const isToWatched = watchedWallets.includes(toAddress);

    if (!isFromWatched && !isToWatched) {
      console.log(`ℹ️  [${chain}] Aktivitas NFT diabaikan (bukan watched wallet) — from: ${fromAddress}, to: ${toAddress}`);
      continue;
    }

    const direction = isFromWatched ? "OUTGOING" : "INCOMING";
    const watchedWallet = isFromWatched ? fromAddress : toAddress;

    await handleWalletActivityDetected({
      chain,
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

function handleWebhookRequest(chain) {
  return (req, res) => {
    const signingKey = CHAINS[chain].signingKey;

    if (!isValidSignature(req, signingKey)) {
      console.warn(`Signature tidak valid (chain: ${chain}), request ditolak.`);
      return res.status(401).send("Invalid signature");
    }

    // Balas 200 secepatnya supaya Alchemy tidak retry / dianggap gagal.
    res.status(200).send("OK");

    const { event } = req.body;
    const activities = event?.activity || [];

    if (activities.length === 0) {
      console.log(`⚠️  [${chain}] Tidak ada 'activity' di payload:`, JSON.stringify(req.body, null, 2));
      return;
    }

    processActivities(chain, activities).catch((err) => {
      console.error(`Gagal memproses payload webhook (chain: ${chain}):`, err);
    });
  };
}

// ---------------------------------------------------------------------------
// ROUTES
// ---------------------------------------------------------------------------

// --- Robinhood Chain (existing, tidak berubah perilakunya) ---
app.post("/webhook/nft-mint", handleWebhookRequest("robinhood"));
app.post("/webhook/wallet-activity", handleWebhookRequest("robinhood"));
app.post("/", handleWebhookRequest("robinhood")); // alias, jaga-jaga URL yang terdaftar di Alchemy adalah root

// --- Ink (baru) ---
app.post("/webhook/ink/nft-mint", handleWebhookRequest("ink"));
app.post("/webhook/ink/wallet-activity", handleWebhookRequest("ink"));

app.get("/", (req, res) => {
  res.send("NFT Mint & Wallet Activity Webhook - Multi-chain aktif ✅");
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", time: new Date().toISOString() });
});

// Reload semua file wallets tanpa perlu restart server
app.post("/admin/reload-wallets", (req, res) => {
  loadAllWallets();
  const totals = Object.fromEntries(
    Object.keys(CHAINS).map((chain) => [chain, WALLETS[chain]?.addresses.length || 0])
  );
  res.status(200).json(totals);
});

app.listen(PORT, () => {
  console.log(`Server jalan di http://localhost:${PORT}`);
  console.log(`--- Robinhood Chain ---`);
  console.log(`Endpoint webhook (mint)           : http://localhost:${PORT}/webhook/nft-mint`);
  console.log(`Endpoint webhook (wallet activity): http://localhost:${PORT}/webhook/wallet-activity`);
  console.log(`--- Ink ---`);
  console.log(`Endpoint webhook (mint)           : http://localhost:${PORT}/webhook/ink/nft-mint`);
  console.log(`Endpoint webhook (wallet activity): http://localhost:${PORT}/webhook/ink/wallet-activity`);
});
