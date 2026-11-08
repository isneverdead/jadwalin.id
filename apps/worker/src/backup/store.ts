import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Readable } from "node:stream";

export interface StoredObject {
  key: string;
  size: number;
  lastModified: Date;
}

export interface BackupStoreOptions {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

/** Penyimpanan objek khusus backup (bucket TERPISAH dari berkas pengguna, kredensial terpisah). */
export class BackupStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(opts: BackupStoreOptions) {
    this.bucket = opts.bucket;
    this.client = new S3Client({
      region: opts.region,
      endpoint: opts.endpoint,
      forcePathStyle: opts.forcePathStyle ?? false,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  /** Unggah aliran dengan ukuran tak diketahui (multipart). */
  async put(key: string, body: Readable, contentType = "application/octet-stream"): Promise<void> {
    await new Upload({ client: this.client, params: { Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }, queueSize: 2, partSize: 8 * 1024 * 1024 }).done();
  }

  async putBuffer(key: string, data: Buffer | string, contentType: string): Promise<void> {
    await new Upload({ client: this.client, params: { Bucket: this.bucket, Key: key, Body: data, ContentType: contentType } }).done();
  }

  async get(key: string): Promise<Readable> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return res.Body as Readable;
  }

  async getText(key: string): Promise<string> {
    const body = await this.get(key);
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const out: StoredObject[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of res.Contents ?? []) if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0, lastModified: o.LastModified ?? new Date(0) });
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** Dev/CI saja. Di produksi bucket dibuat di dashboard dengan versioning/Object Lock dan tanpa akses publik. */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }
}
