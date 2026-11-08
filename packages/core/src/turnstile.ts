/**
 * Verifikasi Cloudflare Turnstile di server. Gagal tertutup: token kosong, galat jaringan, timeout, atau respons
 * tak terduga dianggap tidak lolos. Jangan percaya widget di klien tanpa memanggil ini.
 */
export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface TurnstileOptions {
  secret: string;
  token: string | null | undefined;
  ip?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function verifyTurnstile({ secret, token, ip, fetchImpl = fetch, timeoutMs = 5000 }: TurnstileOptions): Promise<boolean> {
  if (!token || token.length > 2048) return false;
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set("remoteip", ip);
    const res = await fetchImpl(TURNSTILE_VERIFY_URL, { method: "POST", body, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const json = (await res.json()) as { success?: unknown };
    return json.success === true;
  } catch {
    return false;
  }
}
