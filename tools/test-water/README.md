# Uji layer air (danau/waduk)

Pengujian browser khusus untuk perlakuan `waterRle` di `index.html`: sel air
tidak boleh terisi warna kab/kota, tidak boleh melahirkan garis batas palsu,
dan tidak boleh menjadi hit administratif (hover/klik/keyboard).

## Berkas

- `make-fixture.mjs` — membuat grid mini 24x9 (1 provinsi, 3 kab/kota, 2 sel
  danau yang sengaja bertumpuk dengan id kab di `kabRle`, meniru data nyata).
  Output: `mini-data.js`, `mini-nowater.js`, `mini-page.html`,
  `mini-page-nowater.html`.
- `test-water.mjs` — harness Playwright. Menjalankan Chrome/Edge sistem lewat
  CDP (tanpa unduhan browser) dan memverifikasi 27 pemeriksaan: jalur ada-air
  dan tanpa-air (`waterRle` dihapus maupun `[]`), pada fixture mini dan data
  produksi (Sumatera Utara/Danau Toba, Bali).
- `shot-*.png` — tangkapan layar bukti dari run terakhir.

## Menjalankan

```bash
cd tools/test-water
npm install --no-save playwright   # satu-satunya dependensi, lokal folder ini
cd ../..
node tools/test-water/make-fixture.mjs
node tools/test-water/test-water.mjs
```

Catatan: Chrome/Edge versi baru menolak `--remote-debugging` bila
`--user-data-dir` di luar `LOCALAPPDATA`; harness ini otomatis menaruh profil
di bawah `LOCALAPPDATA` dan menyambung lewat `connectOverCDP`.
