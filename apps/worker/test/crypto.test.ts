import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import { createDecryptStream, createEncryptStream } from "../src/backup/crypto";

const PASS = "frasa-sandi-uji-yang-cukup-panjang-123456";

async function collect(input: Buffer | Buffer[], t: NodeJS.ReadWriteStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await pipeline(Readable.from(Array.isArray(input) ? input : [input]), t, async function (src) {
    for await (const c of src) chunks.push(c as Buffer);
  });
  return Buffer.concat(chunks);
}
const enc = (data: Buffer | Buffer[], pass = PASS) => collect(data, createEncryptStream(pass));
const dec = (data: Buffer | Buffer[], pass = PASS) => collect(data, createDecryptStream(pass));

describe("enkripsi backup (AES-256-GCM per potongan)", () => {
  it.each([[0], [1], [1024 * 1024 - 1], [1024 * 1024], [1024 * 1024 + 1], [3 * 1024 * 1024 + 12345]])("bolak-balik utuh untuk %i byte", async (n) => {
    const plain = randomBytes(n);
    const sealed = await enc(plain);
    expect(sealed.length).toBeGreaterThan(n);
    expect((await dec(sealed)).equals(plain)).toBe(true);
  });

  it("tahan terhadap pemecahan aliran sembarang (ukuran blok masukan berbeda-beda)", async () => {
    const plain = randomBytes(2 * 1024 * 1024 + 777);
    const sealed = await enc(plain);
    const pieces: Buffer[] = [];
    for (let i = 0; i < sealed.length; ) {
      const n = 1 + Math.floor(Math.random() * 70_000);
      pieces.push(sealed.subarray(i, i + n));
      i += n;
    }
    expect((await dec(pieces)).equals(plain)).toBe(true);
  });

  it("ciphertext tidak memuat plaintext dan berbeda tiap kali (salt/IV acak)", async () => {
    const plain = Buffer.from("PGDMP-isi-rahasia-pelanggan-".repeat(5000));
    const a = await enc(plain);
    const b = await enc(plain);
    expect(a.includes(Buffer.from("isi-rahasia-pelanggan"))).toBe(false);
    expect(a.equals(b)).toBe(false);
  });

  it("frasa sandi salah ditolak", async () => {
    const sealed = await enc(Buffer.from("data"));
    await expect(dec(sealed, "frasa-lain-yang-juga-cukup-panjang-654321")).rejects.toThrow(/autentikasi gagal/);
  });

  it("satu byte diubah di mana pun (header aman, isi, tag) terdeteksi", async () => {
    const plain = randomBytes(1_500_000);
    const sealed = await enc(plain);
    for (const pos of [40, 500, 1_100_000, sealed.length - 5]) {
      const bad = Buffer.from(sealed);
      bad[pos] = bad[pos]! ^ 0x01;
      await expect(dec(bad), `byte ${pos}`).rejects.toThrow();
    }
  });

  it("berkas TERPOTONG terdeteksi (tidak diam-diam menghasilkan dump yang sebagian)", async () => {
    const sealed = await enc(randomBytes(2_500_000));
    await expect(dec(sealed.subarray(0, sealed.length - 100))).rejects.toThrow();
    await expect(dec(sealed.subarray(0, 1_048_576 + 33))).rejects.toThrow(); // terpotong tepat di batas potongan
    await expect(dec(Buffer.alloc(0))).rejects.toThrow(/kosong|terpotong/);
  });

  it("potongan yang ditukar urutannya atau diduplikasi ditolak; data setelah akhir ditolak", async () => {
    const sealed = await enc(randomBytes(2_200_000));
    const head = 6 + 16 + 12;
    const chunkLen = 5 + 1024 * 1024 + 16;
    const c0 = sealed.subarray(head, head + chunkLen);
    const c1 = sealed.subarray(head + chunkLen, head + 2 * chunkLen);
    const rest = sealed.subarray(head + 2 * chunkLen);
    await expect(dec(Buffer.concat([sealed.subarray(0, head), c1, c0, rest]))).rejects.toThrow();
    await expect(dec(Buffer.concat([sealed.subarray(0, head), c0, c0, rest]))).rejects.toThrow();
    await expect(dec(Buffer.concat([sealed, Buffer.from([1, 2, 3])]))).rejects.toThrow(/setelah potongan terakhir/);
  });

  it("frasa sandi pendek ditolak saat enkripsi", async () => {
    await expect(enc(Buffer.from("x"), "pendek")).rejects.toThrow(/minimal 32/);
  });
});
