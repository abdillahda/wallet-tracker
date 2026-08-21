/**
 * NFT Mint Listener - Robinhood Chain
 * ------------------------------------
 * Server ini menerima webhook dari Alchemy Custom Webhook / Address Activity
 * setiap kali ada event Transfer di kontrak NFT yang dipantau, lalu memfilter
 * hanya yang merupakan MINT (from == zero address).
 *
 * Cara pakai:
 *   1. npm install
 *   2. copy .env.example -> .env dan isi ALCHEMY_SIGNING_KEY
 *   3. npm start
 *   4. expose port ini ke internet (ngrok / deploy ke server) lalu daftarkan
 *      URL publiknya di Alchemy Dashboard > Notify > Custom Webhook
 */

const express = require("express");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const SIGNING_KEY = process.env.ALCHEMY_SIGNING_KEY; // dari Alchemy Dashboard > Notify > webhook detail

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// PENTING: Alchemy menandatangani body RAW (belum di-parse JSON).
// Jadi kita perlu raw body, bukan express.json() default.
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

/**
 * Validasi signature webhook (HMAC SHA256) supaya request benar-benar
 * datang dari Alchemy, bukan dari pihak lain yang menembak endpoint kita.
 */
function isValidSignature(req) {
  if (!SIGNING_KEY) return true; // skip validasi kalau belum diset (mode dev)

  const signature = req.headers["x-alchemy-signature"];
  if (!signature) return false;

  const hmac = crypto.createHmac("sha256", SIGNING_KEY);
  hmac.update(req.rawBody);
  const digest = hmac.digest("hex");

  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

/**
 * Mengecek apakah sebuah log Transfer adalah event MINT.
 * Untuk ERC-721/1155, event Transfer punya bentuk:
 *   Transfer(address indexed from, address indexed to, uint256 indexed tokenId)
 * Kalau `from` adalah zero address -> ini mint (token baru dibuat).
 */
function isMintEvent(fromAddress) {
  return fromAddress?.toLowerCase() === ZERO_ADDRESS;
}

/**
 * Handler utama webhook.
 * Struktur payload mengikuti format Alchemy Notify (Address Activity /
 * Custom Webhook). Sesuaikan parsing di bawah dengan payload asli yang
 * kamu terima -- disarankan console.log(JSON.stringify(req.body)) dulu
 * saat setup awal untuk melihat struktur persisnya.
 */
app.post("/webhook/nft-mint", (req, res) => {
  if (!isValidSignature(req)) {
    console.warn("Signature tidak valid, request ditolak.");
    return res.status(401).send("Invalid signature");
  }

  // Balas 200 secepatnya supaya Alchemy tidak retry / dianggap gagal.
  res.status(200).send("OK");

  try {
    const { event } = req.body;
    const activities = event?.activity || [];

    activities.forEach((activity) => {
      const fromAddress = activity.fromAddress || activity.from;
      const toAddress = activity.toAddress || activity.to;

      if (isMintEvent(fromAddress)) {
        handleMintDetected({
          contractAddress: activity.contractAddress || activity.rawContract?.address,
          tokenId: activity.tokenId || activity.erc721TokenId || activity.erc1155Metadata?.[0]?.tokenId,
          mintedTo: toAddress,
          txHash: activity.hash,
          blockNum: activity.blockNum,
        });
      }
    });
  } catch (err) {
    console.error("Gagal memproses payload webhook:", err);
  }
});

/**
 * Ganti fungsi ini sesuai kebutuhan:
 * - simpan ke database
 * - kirim notifikasi ke Discord/Slack/Telegram
 * - trigger event lain di sistem kamu
 */
function handleMintDetected({ contractAddress, tokenId, mintedTo, txHash, blockNum }) {
  console.log("🎨 MINT TERDETEKSI!");
  console.log(`   Kontrak   : ${contractAddress}`);
  console.log(`   Token ID  : ${tokenId}`);
  console.log(`   Minted to : ${mintedTo}`);
  console.log(`   Tx Hash   : ${txHash}`);
  console.log(`   Block     : ${blockNum}`);
  console.log("----------------------------------------");

  // Contoh: kirim ke Discord webhook (opsional, isi DISCORD_WEBHOOK_URL di .env)
  if (process.env.DISCORD_WEBHOOK_URL) {
    notifyDiscord({ contractAddress, tokenId, mintedTo, txHash });
  }
}

async function notifyDiscord({ contractAddress, tokenId, mintedTo, txHash }) {
  try {
    await fetch(process.env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `🎨 **Mint baru terdeteksi!**\nKontrak: \`${contractAddress}\`\nToken ID: \`${tokenId}\`\nMinted ke: \`${mintedTo}\`\nTx: https://explorer.chain.robinhood.com/tx/${txHash}`,
      }),
    });
  } catch (err) {
    console.error("Gagal kirim notifikasi Discord:", err);
  }
}

app.get("/", (req, res) => {
  res.send("NFT Mint Webhook Listener - Robinhood Chain aktif ✅");
});

app.listen(PORT, () => {
  console.log(`Server jalan di http://localhost:${PORT}`);
  console.log(`Endpoint webhook: http://localhost:${PORT}/webhook/nft-mint`);
});
