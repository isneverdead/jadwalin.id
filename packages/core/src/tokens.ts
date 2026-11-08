import { createHash, randomBytes } from "node:crypto";

/** Token rahasia sekali tampil (undangan, kelola booking): mentah hanya di email, di DB hanya hash-nya. */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
