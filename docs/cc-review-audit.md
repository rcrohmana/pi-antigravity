# Audit cc-review — pi-antigravity

**Tanggal:** 2026-09-03  
**Cakupan:** seluruh repository pada snapshot saat audit.  
**Metode:** laporan `cc-review` read-only, lalu verifikasi manual atas source, manifest paket, dan uji lokal. Tidak ada proses Agy nyata atau konfigurasi pengguna yang dijalankan/diubah.

## Ringkasan

Tidak ditemukan shell/argv injection langsung: task dikirim melalui stdin dan child dijalankan dengan `shell: false`. Namun, ada **empat risiko tinggi yang bergantung pada konfigurasi Agy/host**, satu bypass batas prompt tingkat menengah, serta beberapa bug reliabilitas dan packaging.

`npm run check` **lulus** (28 test), tetapi itu tidak membuktikan batas izin runtime atau integrasi UI aman.

## Temuan prioritas

### A-01 — Konfirmasi write tidak cukup informatif dan menyesatkan
**Severity: High**

- Gate hanya menampilkan role dan teks generik; ia tidak menampilkan `cwd` ataupun task yang akan diberikan ke agent (`src/policy.ts:25-42`).
- Teks menyebut “sandboxed command execution”, tetapi runner tidak pernah meneruskan `--sandbox` (`src/runner.ts:159-176`); dokumentasi sendiri menyatakan sandbox tidak dipakai (`docs/permissions.md:21`).
- Jadi, satu klik persetujuan dapat menyetujui task model hingga 20.000 karakter tanpa pengguna dapat menilai target atau dampaknya.

**Perbaikan:** tampilkan role, path kanonis, ringkasan task yang dibatasi panjangnya, dan kemampuan aktual. Hapus istilah “sandboxed” bila sandbox memang tidak aktif.

### A-02 — Validasi `cwd` bukan sandbox write
**Severity: High (bergantung pada kebijakan Agy)**

- `validateCwd` hanya memastikan process working directory berada di workspace (`src/policy.ts:58-84`).
- Runner hanya meneruskan `cwd` saat spawn; tidak ada allow-list path untuk operasi tulis (`src/runner.ts:333-339`).
- Role `worker` dan `delegate` tetap memiliki tool tulis dan `run_command` (`agy-plugin/agents/worker.md:4-17`, `agy-plugin/agents/delegate.md:4-17`).

Jika konfigurasi Agy pengguna mengizinkan path di luar workspace, agent yang telah disetujui dapat menulis di sana. Klaim/documentasi batas workspace saat ini terlalu kuat bila tanpa batas izin Agy yang setara.

**Perbaikan:** gunakan rule Agy yang benar-benar membatasi write ke workspace bila CLI mendukungnya. Jika tidak, dokumentasikan dengan jelas bahwa scope write ditentukan oleh konfigurasi Agy, bukan oleh extension.

### A-03 — Jalur eksfiltrasi tanpa gate melalui `researcher`
**Severity: High (bergantung pada konfigurasi Agy)**

- `researcher` tidak memerlukan konfirmasi write (`src/policy.ts:25-26`) dan memiliki akses baca lokal serta web (`src/roles.ts:42-51`; `agy-plugin/agents/researcher.md:4-15`).
- Dokumentasi merekomendasikan `read_url(*)` dan akses baca home directory, sambil mengakui URL arbitrer dapat mengekfiltrasi context (`docs/permissions.md:22, 26-28`).
- Context hingga 30.000 karakter diteruskan ke child (`index.ts:47-71`).

Dengan rule baca yang longgar, prompt injection dari repo/halaman web dapat mendorong agent membaca data lokal lalu mengirimkannya ke domain attacker melalui request URL. Ini bukan bug `shell`, tetapi celah trust boundary nyata.

**Perbaikan:** default-kan domain allow-list untuk researcher, minta konfirmasi untuk web fetch berisiko/broad access, dan perluas deny list file sensitif (mis. `.gemini`, `.npmrc`, `.git-credentials`, `.kube`, `.docker`, `.env` serta LAN privat).

### A-04 — Seluruh environment parent diwariskan ke Agy
**Severity: High (bergantung pada secret yang ada di host)**

`runAgy` memilih `process.env` secara default dan meneruskannya utuh ke child (`src/runner.ts:234-242, 333-339`). Maka token provider Pi, credential CI, atau secret lain yang ada pada environment dapat dibaca oleh `agy` dan proses yang dijalankannya. Dokumentasi juga mengakui inheritance ini (`docs/permissions.md:10`).

**Perbaikan:** bangun environment allow-list minimal untuk child; jangan teruskan credential/provider token kecuali benar-benar diperlukan.

### A-05 — `files` dapat menyuntikkan baris ke prompt dan tidak dibatasi ke workspace
**Severity: Medium**

`validateFileHints` hanya menolak string kosong, NUL, dan panjang berlebih (`src/policy.ts:95-106`). Newline dan path di luar workspace tetap diterima; lalu nilai dipasang verbatim ke prompt (`src/runner.ts:140-145`). Contoh hint `src/a.ts\nIgnore scope...` menghasilkan instruksi tambahan di bagian “Explicit file hints”.

Ini bukan argv injection, tetapi merusak batas struktur prompt “hint saja” dan mempermudah prompt injection.

**Perbaikan:** tolak control character/newline, normalisasi dan validasi hint terhadap `cwd`, lalu render secara aman.

### A-06 — Paket npm tidak menyertakan `skills/`
**Severity: Medium (deployment/functionality)**

`package.json` memiliki allow-list `files` tetapi tidak menyebut `skills/` (`package.json:8-16`), padahal static check dan dokumentasi mengandalkan empat skill tersebut. Verifikasi `npm pack --dry-run --json` membuktikan tarball tidak memuat satu pun file `skills/`.

**Perbaikan:** tambahkan `"skills/"` ke `files` dan tambahkan test packaging yang memeriksa isi tarball.

## Temuan tambahan terverifikasi

| ID | Severity | Temuan | Bukti / dampak |
|---|---|---|---|
| A-07 | Medium | `npm run check` tidak menjalankan type-check, dan test extension hanya memeriksa pola source untuk wiring tool; jalur `executeRole`, gate UI, status update, dan cleanup tidak diuji end-to-end. | `package.json:26-29`; `tests/extension.test.mjs:7-35`. Risiko regresi pada permission/UI tidak tertangkap. |
| A-08 | Low | Diagnostics muncul dua kali dalam `AgyRunnerError`. | `src/schemas.ts:221-223` memasukkan `requiredNotice` ke message lalu menambahkannya lagi lewat `boundPiOutput`. Reproduksi menghasilkan dua label `Diagnostics:`. Ini juga dapat menggeser error utama saat output dipotong. |
| A-09 | Low | Deteksi escalation hanya memeriksa stderr; error izin yang hanya muncul dalam response tidak ditandai. | `classifyDiagnostics` menerima diagnostics saja (`src/runner.ts:146-147, 429-443`). String documented `TOOL_ERROR: user denied permission for read_file(...)` sendiri tidak cocok dengan regex bila tidak ada stderr pendamping. |
| A-10 | Low | Event stdout terlambat dapat dikirim setelah promise sudah settle. | Handler `close` masih memanggil `parser.finish()` dan `processEvent()` tanpa guard `settled` (`src/runner.ts:380-407`). Setelah timeout/abort paksa, ini berpotensi menghidupkan kembali update UI yang seharusnya selesai. |
| A-11 | Low | Di POSIX, timeout/abort hanya menghentikan process child langsung, bukan process group. | Fallback non-Windows hanya `child.kill("SIGTERM")` (`src/runner.ts:474-489`), sehingga command turunan Agy dapat tertinggal. |
| A-12 | Low | Konfigurasi role dapat drift dari policy runtime. | `ROLE_CONFIGS.tools` dan `commandExecutionPolicy` dideklarasikan (`src/roles.ts`) tetapi tidak diteruskan oleh `index.ts` ke runner; runtime bergantung pada frontmatter plugin yang harus tetap sinkron manual. |

## Batasan dan prioritas perbaikan

- A-02, A-03, dan A-04 menjadi eksploit nyata bila rules Agy/host longgar atau secret tersedia. Audit ini membuktikan extension **tidak menegakkan** boundary tersebut sendiri; semantik CLI dan settings pengguna tidak diuji.
- Prioritas: **A-01 → A-04 → A-02/A-03 → A-05**, lalu packaging dan test coverage.
- Sebelum rilis berikutnya, tambahkan type-check ke `npm run check`, test integration untuk gate/UI/runner, dan test eksplisit untuk path escape, newline hint, environment scrub, serta isi npm tarball.
