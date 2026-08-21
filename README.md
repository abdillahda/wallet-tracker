# NFT Mint Webhook Listener — Robinhood Chain

Server kecil yang menerima notifikasi real-time dari Alchemy setiap ada
transaksi **mint NFT** (bukan transfer biasa) di kontrak yang kamu pantau,
di Robinhood Chain.

## Cara kerja

NFT mint secara teknis adalah event `Transfer` dengan `from` = zero address
(`0x000...000`). Server ini menerima semua event Transfer dari Alchemy lalu
memfilter yang `from`-nya zero address — itu artinya token baru saja dibuat.

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Buat file `.env`
```bash
cp .env.example .env
```
Isi `ALCHEMY_SIGNING_KEY` nanti setelah webhook dibuat (langkah 4).

### 3. Jalankan server
```bash
npm start
```
Server akan jalan di `http://localhost:3000`.

### 4. Expose ke internet & daftarkan di Alchemy

Alchemy perlu mengirim POST request ke URL publik, jadi selama development
pakai **ngrok** (atau sejenisnya):
```bash
ngrok http 3000
```
Copy URL yang muncul (misal `https://abcd1234.ngrok.io`).

Lalu ke [Alchemy Dashboard](https://dashboard.alchemy.com/notify):
1. Pilih tab **Notify**
2. Klik **Create Webhook**
3. Pilih tipe **Custom Webhook** (paling fleksibel — bisa filter event log)
   atau **Address Activity** (lebih simpel, lacak per alamat kontrak)
4. Pilih chain **Robinhood Chain** (mainnet atau testnet)
5. Masukkan URL webhook: `https://abcd1234.ngrok.io/webhook/nft-mint`
6. Masukkan alamat kontrak NFT yang mau dipantau
7. Setelah dibuat, copy **Signing Key** dari detail webhook, paste ke `.env`

### 5. Test
Lakukan mint NFT di kontrak yang kamu daftarkan (atau tunggu ada mint asli),
lalu cek log server — akan muncul:
```
🎨 MINT TERDETEKSI!
   Kontrak   : 0x...
   Token ID  : 123
   Minted to : 0x...
   Tx Hash   : 0x...
```

## Deploy ke production

Untuk pemakaian jangka panjang, jangan pakai ngrok — deploy server ini ke
layanan seperti Railway, Render, Fly.io, atau VPS biasa, lalu update URL
webhook di Alchemy Dashboard ke domain production.

## Kustomisasi

Edit fungsi `handleMintDetected()` di `server.js` untuk:
- Simpan event ke database (Postgres, MongoDB, dll)
- Kirim ke Telegram/Slack selain Discord
- Trigger workflow lain (misal update leaderboard, kirim email, dll)

## Catatan biaya

Free tier Alchemy (30M compute units/bulan) biasanya sudah cukup untuk
webhook-based listener seperti ini, karena kamu tidak melakukan polling —
Alchemy yang mendorong data ke server kamu hanya saat event benar-benar
terjadi.
