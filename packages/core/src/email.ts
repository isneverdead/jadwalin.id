import nodemailer, { type Transporter } from "nodemailer";

export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Id outbox: dikirim sebagai header agar pengiriman ulang bisa dilacak/dikenali penerima dan penyedia. */
  outboxId: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<{ messageId: string | null }>;
}

/** SMTP umum (SES, Resend, Postmark, Cloudflare, dll.). */
export class SmtpEmailSender implements EmailSender {
  private readonly transport: Transporter;
  constructor(smtpUrl: string) {
    this.transport = nodemailer.createTransport(smtpUrl);
  }
  async send(m: EmailMessage) {
    const info = await this.transport.sendMail({
      from: m.from,
      to: m.to,
      subject: m.subject,
      text: m.text,
      html: m.html,
      headers: { "X-Jadwalin-Outbox-Id": m.outboxId },
    });
    return { messageId: info.messageId ?? null };
  }
  close() {
    this.transport.close();
  }
}

/** Dev: cetak email ke log (termasuk tautan) alih-alih mengirim. Tidak boleh dipakai di produksi. */
export class ConsoleEmailSender implements EmailSender {
  constructor(private readonly log: (line: string) => void = console.log) {}
  async send(m: EmailMessage) {
    this.log(`[email] to=${m.to} subject="${m.subject}"\n${m.text}`);
    return { messageId: `console-${m.outboxId}` };
  }
}

/** Tes: menyimpan email terkirim; `failWhen` mensimulasikan kegagalan penyedia. */
export class MemoryEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  /** Kembalikan true untuk membuat pengiriman email tertentu gagal. */
  failWhen: (m: EmailMessage) => boolean = () => false;
  failWith = "penyedia email tidak tersedia";
  delayMs = 0;
  async send(m: EmailMessage) {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failWhen(m)) throw new Error(this.failWith);
    this.sent.push(m);
    return { messageId: `mem-${this.sent.length}` };
  }
}
