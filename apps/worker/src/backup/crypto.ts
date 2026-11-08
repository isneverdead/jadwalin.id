import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";
import { promisify } from "node:util";

/**
 * Enkripsi aliran ber-autentikasi untuk berkas backup (AES-256-GCM per potongan 1 MiB).
 *
 * Format: "JDWBK1" | salt(16) | baseIv(12) | potongan*  ;  potongan = flag(1) | panjang(4, BE) | ciphertext | tag(16)
 * - Kunci dari frasa sandi lewat scrypt + salt acak per berkas.
 * - IV tiap potongan = baseIv XOR nomor potongan; AAD = flag + nomor potongan, sehingga potongan tidak bisa
 *   ditukar urutannya atau dipindah, dan potongan terakhir bertanda `final` (berkas terpotong terdeteksi).
 * - Tiap potongan diverifikasi SEBELUM isinya dilepas ke hilir (tidak ada plaintext palsu yang mengalir ke pg_restore).
 */
const MAGIC = Buffer.from("JDWBK1");
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const CHUNK = 1024 * 1024;
const HEADER_LEN = MAGIC.length + SALT_LEN + IV_LEN;
const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const MIN_PASSPHRASE_LENGTH = 32;

async function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) throw new Error(`Frasa sandi backup minimal ${MIN_PASSPHRASE_LENGTH} karakter`);
  return scryptAsync(passphrase, salt, 32);
}

function chunkIv(baseIv: Buffer, index: number): Buffer {
  const iv = Buffer.from(baseIv);
  iv.writeUInt32BE((iv.readUInt32BE(IV_LEN - 4) ^ index) >>> 0, IV_LEN - 4);
  return iv;
}

function aad(final: boolean, index: number): Buffer {
  const b = Buffer.alloc(5);
  b[0] = final ? 1 : 0;
  b.writeUInt32BE(index, 1);
  return b;
}

function sealChunk(key: Buffer, baseIv: Buffer, index: number, final: boolean, plain: Buffer): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, chunkIv(baseIv, index));
  cipher.setAAD(aad(final, index));
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const head = Buffer.alloc(5);
  head[0] = final ? 1 : 0;
  head.writeUInt32BE(ct.length, 1);
  return Buffer.concat([head, ct, cipher.getAuthTag()]);
}

export function createEncryptStream(passphrase: string): Transform {
  const salt = randomBytes(SALT_LEN);
  const baseIv = randomBytes(IV_LEN);
  let key: Buffer | null = null;
  let headerSent = false;
  let buffered: Buffer = Buffer.alloc(0);
  let held: Buffer | null = null; // potongan penuh yang menunggu: baru tahu apakah ia yang terakhir saat potongan berikutnya datang/aliran selesai
  let index = 0;

  const ensureKey = async () => (key ??= await deriveKey(passphrase, salt));

  return new Transform({
    async transform(chunk: Buffer, _enc: string, cb: TransformCallback) {
      try {
        const k = await ensureKey();
        if (!headerSent) {
          this.push(Buffer.concat([MAGIC, salt, baseIv]));
          headerSent = true;
        }
        buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
        while (buffered.length >= CHUNK) {
          if (held) this.push(sealChunk(k, baseIv, index++, false, held));
          held = buffered.subarray(0, CHUNK);
          buffered = buffered.subarray(CHUNK);
        }
        cb();
      } catch (e) {
        cb(e as Error);
      }
    },
    async flush(cb: TransformCallback) {
      try {
        const k = await ensureKey();
        if (!headerSent) {
          this.push(Buffer.concat([MAGIC, salt, baseIv]));
          headerSent = true;
        }
        if (held) {
          this.push(sealChunk(k, baseIv, index++, false, held));
          held = null;
        }
        this.push(sealChunk(k, baseIv, index++, true, buffered)); // potongan terakhir (boleh kosong)
        cb();
      } catch (e) {
        cb(e as Error);
      }
    },
  });
}

export function createDecryptStream(passphrase: string): Transform {
  let buf: Buffer = Buffer.alloc(0);
  let key: Buffer | null = null;
  let baseIv: Buffer | null = null;
  let index = 0;
  let sawFinal = false;

  const fail = (msg: string) => new Error(`Berkas backup tidak valid: ${msg}`);

  return new Transform({
    async transform(chunk: Buffer, _enc: string, cb: TransformCallback) {
      try {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        if (!key) {
          if (buf.length < HEADER_LEN) return cb();
          if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) return cb(fail("format tidak dikenal"));
          const salt = buf.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
          baseIv = Buffer.from(buf.subarray(MAGIC.length + SALT_LEN, HEADER_LEN));
          key = await deriveKey(passphrase, Buffer.from(salt));
          buf = buf.subarray(HEADER_LEN);
        }
        for (;;) {
          if (sawFinal) {
            if (buf.length > 0) return cb(fail("ada data setelah potongan terakhir"));
            break;
          }
          if (buf.length < 5) break;
          const final = buf[0] === 1;
          const len = buf.readUInt32BE(1);
          if (len > CHUNK) return cb(fail("panjang potongan tidak wajar"));
          if (buf.length < 5 + len + TAG_LEN) break;
          const ct = buf.subarray(5, 5 + len);
          const tag = buf.subarray(5 + len, 5 + len + TAG_LEN);
          const decipher = createDecipheriv("aes-256-gcm", key, chunkIv(baseIv!, index));
          decipher.setAAD(aad(final, index));
          decipher.setAuthTag(tag);
          let plain: Buffer;
          try {
            plain = Buffer.concat([decipher.update(ct), decipher.final()]);
          } catch {
            return cb(fail("autentikasi gagal (data rusak/diubah atau frasa sandi salah)"));
          }
          if (plain.length) this.push(plain);
          index++;
          if (final) sawFinal = true;
          buf = buf.subarray(5 + len + TAG_LEN);
        }
        cb();
      } catch (e) {
        cb(e as Error);
      }
    },
    flush(cb: TransformCallback) {
      if (!key) return cb(fail("berkas kosong atau terpotong"));
      if (!sawFinal) return cb(fail("berkas terpotong (potongan terakhir tidak ada)"));
      cb();
    },
  });
}
