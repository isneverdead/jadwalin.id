export const TICKET_STATUSES = ["open", "in_progress", "waiting_client", "resolved", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export type TicketActor = "staff" | "client";

const STAFF_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  open: ["in_progress", "waiting_client", "resolved", "closed"],
  in_progress: ["waiting_client", "resolved", "closed"],
  waiting_client: ["in_progress", "resolved", "closed"],
  resolved: ["in_progress", "closed"],
  closed: [],
};

// Klien boleh menutup tiketnya sendiri kapan saja (membatalkan permintaan), membuka kembali tiket yang
// sudah diselesaikan, dan menjawab tiket yang menunggu klien. Tidak boleh memulai pengerjaan atau menyelesaikan.
const CLIENT_TRANSITIONS: Partial<Record<TicketStatus, readonly TicketStatus[]>> = {
  open: ["closed"],
  in_progress: ["closed"],
  waiting_client: ["open", "closed"],
  resolved: ["open", "closed"],
};

export function canTransition(from: TicketStatus, to: TicketStatus, actor: TicketActor): boolean {
  const allowed = actor === "staff" ? STAFF_TRANSITIONS[from] : (CLIENT_TRANSITIONS[from] ?? []);
  return allowed.includes(to);
}
