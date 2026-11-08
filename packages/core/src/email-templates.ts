export type EmailTemplate = "verify_email" | "reset_password" | "workspace_invite" | "generic_notice" | "booking_notice";

/** Template yang payload-nya memuat token rahasia: payload dihapus dari DB setelah terkirim. */
export const SENSITIVE_TEMPLATES: ReadonlySet<string> = new Set<EmailTemplate>(["verify_email", "reset_password", "workspace_invite", "booking_notice"]);

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function str(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  if (typeof v !== "string" || !v) throw new Error(`Payload email kehilangan "${key}"`);
  return v;
}

/** Hanya tautan http(s) yang boleh masuk ke email. */
function safeUrl(value: string): string {
  const u = new URL(value);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("URL email tidak valid");
  return u.toString();
}

function layout(heading: string, paragraphs: string[], cta: { label: string; url: string }): { text: string; html: string } {
  const text = [heading, "", ...paragraphs, "", `${cta.label}: ${cta.url}`, "", "— jadwalin.id"].join("\n");
  const html = `<!doctype html><html lang="id"><body style="font-family:system-ui,sans-serif;color:#14171f;line-height:1.5">
<h2 style="margin:0 0 12px">${escapeHtml(heading)}</h2>
${paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n")}
<p><a href="${escapeHtml(cta.url)}" style="display:inline-block;padding:10px 16px;background:#1d4ed8;color:#fff;border-radius:8px;text-decoration:none">${escapeHtml(cta.label)}</a></p>
<p style="color:#5b6475;font-size:13px">Jika tombol tidak berfungsi, salin tautan ini ke browser:<br>${escapeHtml(cta.url)}</p>
<p style="color:#5b6475;font-size:13px">— jadwalin.id</p></body></html>`;
  return { text, html };
}

export function renderEmail(template: string, payload: Record<string, unknown>): RenderedEmail {
  switch (template as EmailTemplate) {
    case "verify_email": {
      const url = safeUrl(str(payload, "url"));
      const body = layout("Verifikasi email Anda", [`Halo ${str(payload, "name")}, konfirmasi bahwa ini alamat email Anda untuk menyelesaikan pendaftaran jadwalin.`, "Tautan berlaku selama 1 jam."], { label: "Verifikasi email", url });
      return { subject: "Verifikasi email jadwalin Anda", ...body };
    }
    case "reset_password": {
      const url = safeUrl(str(payload, "url"));
      const body = layout("Atur ulang kata sandi", [`Halo ${str(payload, "name")}, kami menerima permintaan mengatur ulang kata sandi akun jadwalin Anda.`, "Jika bukan Anda yang meminta, abaikan email ini; kata sandi Anda tidak berubah. Tautan berlaku selama 1 jam."], { label: "Atur ulang kata sandi", url });
      return { subject: "Atur ulang kata sandi jadwalin", ...body };
    }
    case "workspace_invite": {
      const url = safeUrl(str(payload, "url"));
      const ws = str(payload, "workspaceName");
      const body = layout(`Undangan bergabung ke ${ws}`, [`${str(payload, "inviterName")} mengundang Anda bergabung ke ${ws} di jadwalin sebagai ${str(payload, "roleLabel")}.`, "Masuk (atau daftar) dengan email ini, lalu terima undangan. Tautan berlaku 7 hari dan hanya bisa dipakai sekali."], { label: "Terima undangan", url });
      return { subject: `Undangan bergabung ke ${ws}`, ...body };
    }
    case "booking_notice": // berisi tautan kelola booking (rahasia): payload dihapus setelah terkirim
    case "generic_notice": {
      // Untuk modul: judul, paragraf, dan satu tombol. Semua teks di-escape; subjek dibersihkan dari baris baru.
      const paragraphs = Array.isArray(payload.paragraphs) ? payload.paragraphs.filter((p): p is string => typeof p === "string") : [];
      const heading = str(payload, "heading");
      const body = layout(heading, paragraphs, { label: str(payload, "ctaLabel"), url: safeUrl(str(payload, "url")) });
      return { subject: str(payload, "subject").replace(/[\r\n]+/g, " ").slice(0, 150), ...body };
    }
    default:
      throw new Error(`Template email tidak dikenal: ${template}`);
  }
}
