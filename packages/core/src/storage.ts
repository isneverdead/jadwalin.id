import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface PresignedUpload {
  url: string;
  /** Header yang WAJIB dikirim browser saat PUT (ikut ditandatangani). */
  headers: Record<string, string>;
  expiresInSec: number;
}

/** Antarmuka penyimpanan objek; implementasi produksi = R2 (S3-kompatibel). */
export interface StorageAdapter {
  presignUpload(input: { key: string; mime: string; sizeBytes: number; expiresInSec?: number }): Promise<PresignedUpload>;
  presignDownload(input: { key: string; filename: string; expiresInSec?: number }): Promise<string>;
  head(key: string): Promise<{ sizeBytes: number; mime: string | null } | null>;
  delete(key: string): Promise<void>;
}

export const UPLOAD_URL_TTL_SEC = 300;
export const DOWNLOAD_URL_TTL_SEC = 60;

export interface S3Options {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

/** RFC 5987/6266: nama berkas aman untuk header Content-Disposition. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export class S3Storage implements StorageAdapter {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(opts: S3Options) {
    this.bucket = opts.bucket;
    this.client = new S3Client({
      region: opts.region,
      endpoint: opts.endpoint,
      forcePathStyle: opts.forcePathStyle ?? false,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
      // Checksum otomatis SDK menambah header yang tidak dikirim browser; matikan agar URL ber-tanda-tangan portabel.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  async presignUpload({ key, mime, sizeBytes, expiresInSec = UPLOAD_URL_TTL_SEC }: { key: string; mime: string; sizeBytes: number; expiresInSec?: number }): Promise<PresignedUpload> {
    // Content-Type dan Content-Length ikut ditandatangani: klien tidak bisa mengunggah tipe/ukuran lain.
    const command = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: mime, ContentLength: sizeBytes });
    const url = await getSignedUrl(this.client, command, {
      expiresIn: expiresInSec,
      signableHeaders: new Set(["content-type", "content-length"]),
    });
    return { url, headers: { "Content-Type": mime }, expiresInSec };
  }

  async presignDownload({ key, filename, expiresInSec = DOWNLOAD_URL_TTL_SEC }: { key: string; filename: string; expiresInSec?: number }): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition: contentDisposition(filename),
      ResponseCacheControl: "private, no-store",
    });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSec });
  }

  async head(key: string): Promise<{ sizeBytes: number; mime: string | null } | null> {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { sizeBytes: r.ContentLength ?? 0, mime: r.ContentType ?? null };
    } catch (error) {
      if (error instanceof S3ServiceException && (error.$metadata.httpStatusCode === 404 || error.name === "NotFound")) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /**
   * Dev/CI: buat bucket bila belum ada; bila `allowedOrigins` diberikan, pasang CORS agar browser boleh PUT
   * langsung. Tanpa argumen, CORS yang ada TIDAK disentuh (tes Node tidak butuh CORS dan tidak boleh menimpa
   * pengaturan yang dipakai dev server/E2E di bucket yang sama).
   */
  async ensureBucket(allowedOrigins?: string[]): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
    if (!allowedOrigins || allowedOrigins.length === 0) return;
    await this.client.send(
      new PutBucketCorsCommand({
        Bucket: this.bucket,
        CORSConfiguration: {
          CORSRules: [{ AllowedOrigins: allowedOrigins, AllowedMethods: ["PUT", "GET", "HEAD"], AllowedHeaders: ["*"], MaxAgeSeconds: 600 }],
        },
      }),
    );
  }

  /** Dipakai tes untuk menaruh objek tanpa lewat URL ber-tanda-tangan. */
  async putForTest(key: string, body: Uint8Array, mime: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: mime }));
  }
}
