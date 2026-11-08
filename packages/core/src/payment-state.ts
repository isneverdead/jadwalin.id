/**
 * State machine pembayaran (aturan #10). MURNI: tanpa DB/jam. Semua perubahan status pembayaran wajib melewati
 * `assertTransition` dan menulis baris `payment_events` di transaksi yang sama (lihat payments.ts).
 */
export const PAYMENT_STATUSES = ["created", "pending", "paid", "refund_pending", "partially_refunded", "refunded", "expired", "failed", "cancelled"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

const TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  created: ["pending", "failed", "cancelled"],
  pending: ["paid", "expired", "failed", "cancelled"],
  // Pembayaran bisa masuk TERLAMBAT setelah kedaluwarsa (mis. VA dibayar menit ke-31): dana nyata sudah diterima penyedia.
  expired: ["paid"],
  paid: ["refund_pending", "partially_refunded", "refunded"],
  refund_pending: ["paid", "partially_refunded", "refunded"], // gagal refund kembali ke keadaan sebelumnya
  partially_refunded: ["refund_pending", "refunded"],
  refunded: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: PaymentStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export class InvalidTransitionError extends Error {
  constructor(public readonly from: PaymentStatus, public readonly to: PaymentStatus) {
    super(`Transisi pembayaran tidak sah: ${from} → ${to}`);
  }
}

export function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** Kejadian ternormalisasi dari penyedia manapun. */
export type ProviderEventKind = "pending" | "paid" | "expired" | "failed" | "cancelled" | "refunded" | "partially_refunded";

const TARGET: Record<ProviderEventKind, PaymentStatus> = {
  pending: "pending",
  paid: "paid",
  expired: "expired",
  failed: "failed",
  cancelled: "cancelled",
  refunded: "refunded",
  partially_refunded: "partially_refunded",
};

/**
 * Status tujuan untuk satu kejadian penyedia, atau `null` bila harus DIABAIKAN (duplikat, mundur, atau tak sah).
 * Notifikasi datang ganda/terlambat/terbalik urutan; hanya transisi maju yang sah yang berlaku.
 */
export function nextStatus(current: PaymentStatus, event: ProviderEventKind): PaymentStatus | null {
  const to = TARGET[event];
  if (to === current) return null;
  return canTransition(current, to) ? to : null;
}
