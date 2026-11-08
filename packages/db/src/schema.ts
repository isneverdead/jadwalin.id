import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const workspaceId = () => uuid("workspace_id").notNull().references(() => workspaces.id);

/** Rentang waktu Postgres; dipakai untuk constraint anti-bentrok (aturan #8). */
const tstzrange = customType<{ data: string }>({ dataType: () => "tstzrange" });

export const memberRole = pgEnum("member_role", ["owner", "admin", "staff"]);
export const locationKind = pgEnum("location_kind", ["link", "phone", "in_person"]);
export const bookingStatus = pgEnum("booking_status", ["pending", "confirmed", "cancelled", "completed", "no_show"]);
export const fileStatus = pgEnum("file_status", ["pending", "ready", "deleted"]);
export const outboxChannel = pgEnum("outbox_channel", ["email", "whatsapp"]);
export const outboxStatus = pgEnum("outbox_status", ["queued", "sending", "sent", "failed", "skipped_quota", "cancelled"]);
export const ticketStatus = pgEnum("ticket_status", ["open", "in_progress", "waiting_client", "resolved", "closed"]);
export const ticketPriority = pgEnum("ticket_priority", ["low", "normal", "high", "urgent"]);
export const overrideKind = pgEnum("override_kind", ["blocked", "extra"]);

// --- Akun & workspace ---------------------------------------------------------------------

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  phone: text("phone").unique(), // 62xxx, dinormalisasi di core
  name: text("name").notNull(),
  locale: text("locale").notNull().default("id-ID"),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  /** Versi Syarat Layanan + Kebijakan Privasi yang disetujui saat mendaftar (UU PDP: bukti persetujuan). */
  termsVersion: text("terms_version"),
  termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Tabel milik Better Auth (bukan milik tenant; tanpa RLS).
export const sessions = pgTable("sessions", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const accounts = pgTable("accounts", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const verifications = pgTable("verifications", {
  id: id(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const rateLimits = pgTable("rate_limits", {
  id: id(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

export const workspaces = pgTable("workspaces", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("Asia/Jakarta"),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id),
  createdAt: createdAt(),
});

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: id(),
    workspaceId: workspaceId(),
    userId: uuid("user_id").notNull().references(() => users.id),
    role: memberRole("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.workspaceId, t.userId)],
);

export const workspaceClients = pgTable(
  "workspace_clients",
  {
    id: id(),
    workspaceId: workspaceId(),
    userId: uuid("user_id").references(() => users.id), // null = tamu tanpa akun
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    notes: text("notes"),
    /** Klien diblokir: tidak bisa membuat tiket atau komentar baru. */
    blocked: boolean("blocked").notNull().default(false),
    /** Pemberitahuan privasi yang diakui klien saat memesan/mendaftar (versi + waktu). */
    consentVersion: text("consent_version"),
    consentAt: timestamp("consent_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("workspace_clients_ws_email").on(t.workspaceId, t.email)],
);

// --- Mesin jadwal -------------------------------------------------------------------------

export const meetingTypes = pgTable(
  "meeting_types",
  {
    id: id(),
    workspaceId: workspaceId(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    durationMin: integer("duration_min").notNull(),
    slotStepMin: integer("slot_step_min").notNull().default(30),
    bufferBeforeMin: integer("buffer_before_min").notNull().default(0),
    bufferAfterMin: integer("buffer_after_min").notNull().default(0),
    locationKind: locationKind("location_kind").notNull(),
    locationValue: text("location_value"),
    minNoticeMin: integer("min_notice_min").notNull().default(60),
    maxDaysAhead: integer("max_days_ahead").notNull().default(30),
    /** DP/biaya booking dalam Rupiah (bigint). 0 = gratis, tanpa pembayaran. */
    depositIdr: bigint("deposit_idr", { mode: "number" }).notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.workspaceId, t.slug)],
);

export const availabilityRules = pgTable("availability_rules", {
  id: id(),
  workspaceId: workspaceId(),
  memberId: uuid("member_id").notNull().references(() => workspaceMembers.id),
  weekday: smallint("weekday").notNull(), // 0 = Minggu
  startTime: time("start_time").notNull(),
  endTime: time("end_time").notNull(),
});

export const availabilityOverrides = pgTable("availability_overrides", {
  id: id(),
  workspaceId: workspaceId(),
  memberId: uuid("member_id").notNull().references(() => workspaceMembers.id),
  date: date("date").notNull(),
  kind: overrideKind("kind").notNull(),
  startTime: time("start_time"),
  endTime: time("end_time"),
});

export const tickets = pgTable(
  "tickets",
  {
    id: id(),
    workspaceId: workspaceId(),
    number: integer("number").notNull(), // urut per workspace
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: ticketStatus("status").notNull().default("open"),
    priority: ticketPriority("priority").notNull().default("normal"),
    requesterUserId: uuid("requester_user_id").references(() => users.id), // null = tamu
    assigneeMemberId: uuid("assignee_member_id").references(() => workspaceMembers.id),
    clientId: uuid("client_id").references(() => workspaceClients.id),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [unique().on(t.workspaceId, t.number), index("tickets_ws_status").on(t.workspaceId, t.status)],
);

export const bookings = pgTable(
  "bookings",
  {
    id: id(),
    workspaceId: workspaceId(),
    meetingTypeId: uuid("meeting_type_id").notNull().references(() => meetingTypes.id),
    memberId: uuid("member_id").notNull().references(() => workspaceMembers.id),
    clientId: uuid("client_id").notNull().references(() => workspaceClients.id),
    ticketId: uuid("ticket_id").references(() => tickets.id),
    during: tstzrange("during").notNull(), // sudah termasuk buffer
    status: bookingStatus("status").notNull().default("confirmed"),
    source: text("source").notNull().default("public_link"),
    /** SHA-256 token kelola booking (token mentah hanya ada di email). */
    cancelTokenHash: text("cancel_token_hash").notNull().unique(),
    /** Waktu pertemuan sebenarnya (tanpa buffer); `during` memuat buffer untuk anti-bentrok. */
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [index("bookings_ws_member").on(t.workspaceId, t.memberId)],
);

// --- File, notifikasi, audit --------------------------------------------------------------

export const files = pgTable("files", {
  id: id(),
  workspaceId: workspaceId(),
  storageKey: text("storage_key").notNull().unique(),
  filename: text("filename").notNull(),
  mime: text("mime").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  sha256: text("sha256"),
  uploadedBy: uuid("uploaded_by").references(() => users.id),
  status: fileStatus("status").notNull().default("pending"),
  createdAt: createdAt(),
});

export const notificationOutbox = pgTable(
  "notification_outbox",
  {
    id: id(),
    /** Null = email sistem (verifikasi, reset sandi): tidak dihitung ke kuota workspace mana pun. */
    workspaceId: uuid("workspace_id").references(() => workspaces.id),
    channel: outboxChannel("channel").notNull(),
    recipient: text("recipient").notNull(),
    template: text("template").notNull(),
    payload: jsonb("payload").notNull().default({}),
    /** Kunci idempoten global; pengiriman ganda dengan kunci sama diabaikan. */
    dedupeKey: text("dedupe_key").unique(),
    /** Waktu terjadwal; setelah gagal berisi waktu percobaan berikutnya. */
    sendAt: timestamp("send_at", { withTimezone: true }).notNull().defaultNow(),
    status: outboxStatus("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    lastError: text("last_error"),
    providerMessageId: text("provider_message_id"),
    createdAt: createdAt(),
  },
  (t) => [index("outbox_due").on(t.status, t.sendAt)],
);

export const notificationQuotaUsage = pgTable(
  "notification_quota_usage",
  {
    id: id(),
    workspaceId: workspaceId(),
    period: text("period").notNull(), // YYYY-MM (zona Asia/Jakarta)
    channel: outboxChannel("channel").notNull(),
    used: integer("used").notNull().default(0),
    limitCount: integer("limit_count").notNull(),
  },
  (t) => [unique().on(t.workspaceId, t.period, t.channel)],
);

export const workspaceInvitations = pgTable(
  "workspace_invitations",
  {
    id: id(),
    workspaceId: workspaceId(),
    email: text("email").notNull(),
    role: memberRole("role").notNull(),
    tokenHash: text("token_hash").notNull().unique(), // SHA-256 dari token; token mentah hanya ada di email
    invitedBy: uuid("invited_by").notNull().references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("invitations_ws_email").on(t.workspaceId, t.email)],
);

export const auditLog = pgTable("audit_log", {
  id: id(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  diff: jsonb("diff"),
  createdAt: createdAt(),
});

// --- Modul Tiket --------------------------------------------------------------------------

export const ticketComments = pgTable("ticket_comments", {
  id: id(),
  workspaceId: workspaceId(),
  ticketId: uuid("ticket_id").notNull().references(() => tickets.id),
  authorUserId: uuid("author_user_id").notNull().references(() => users.id),
  body: text("body").notNull(),
  /** 'client' atau 'staff': disimpan agar klien tidak perlu membaca data anggota untuk menampilkan pengirim. */
  authorKind: text("author_kind").notNull().default("staff"),
  internal: boolean("internal").notNull().default(false),
  createdAt: createdAt(),
});

export const ticketAttachments = pgTable("ticket_attachments", {
  id: id(),
  workspaceId: workspaceId(),
  ticketId: uuid("ticket_id").notNull().references(() => tickets.id),
  fileId: uuid("file_id").notNull().references(() => files.id),
  commentId: uuid("comment_id").references(() => ticketComments.id),
  contextNote: text("context_note"),
  clientVisible: boolean("client_visible").notNull().default(true),
  uploadedBy: uuid("uploaded_by").notNull().references(() => users.id),
  createdAt: createdAt(),
});

export const ticketEvents = pgTable("ticket_events", {
  id: id(),
  workspaceId: workspaceId(),
  ticketId: uuid("ticket_id").notNull().references(() => tickets.id),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  kind: text("kind").notNull(), // status | assign | priority | meeting
  fromValue: text("from_value"),
  toValue: text("to_value"),
  clientVisible: boolean("client_visible").notNull().default(true),
  createdAt: createdAt(),
});

export const ticketMeetings = pgTable(
  "ticket_meetings",
  {
    id: id(),
    workspaceId: workspaceId(),
    ticketId: uuid("ticket_id").notNull().references(() => tickets.id),
    bookingId: uuid("booking_id").notNull().references(() => bookings.id),
  },
  (t) => [unique().on(t.ticketId, t.bookingId)],
);

export const ticketCounters = pgTable("ticket_counters", {
  workspaceId: uuid("workspace_id").primaryKey().references(() => workspaces.id),
  lastNumber: integer("last_number").notNull().default(0),
});

/** Anggota yang melayani sebuah jenis pertemuan; slot publik = gabungan slot para host. */
export const meetingTypeHosts = pgTable(
  "meeting_type_hosts",
  {
    workspaceId: workspaceId(),
    meetingTypeId: uuid("meeting_type_id").notNull().references(() => meetingTypes.id, { onDelete: "cascade" }),
    memberId: uuid("member_id").notNull().references(() => workspaceMembers.id, { onDelete: "cascade" }),
  },
  (t) => [unique().on(t.meetingTypeId, t.memberId)],
);

/** Penghitung pembatas laju generik (kunci berupa hash; tanpa data pribadi). */
export const rateCounters = pgTable("rate_counters", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
});

/** Status terakhir tiap pekerjaan latar (detak worker, backup, uji restore): sumber pemantauan, bukan tabel tenant. */
export const jobStatus = pgTable("job_status", {
  job: text("job").primaryKey(),
  lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
  lastFailedAt: timestamp("last_failed_at", { withTimezone: true }),
  lastError: text("last_error"),
  lastDetail: jsonb("last_detail"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Permintaan hak subjek data (ekspor/hapus). Per pengguna, dilindungi RLS berbasis pengguna. */
export const dataRequests = pgTable("data_requests", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // 'delete' | 'export'
  status: text("status").notNull().default("pending"), // pending | done | rejected
  note: text("note"),
  createdAt: createdAt(),
  handledAt: timestamp("handled_at", { withTimezone: true }),
});

// --- Pembayaran (core; ADR 0001) -----------------------------------------------------------------

export const paymentAccounts = pgTable(
  "payment_accounts",
  {
    id: id(),
    workspaceId: workspaceId(),
    provider: text("provider").notNull(),
    /** Id merchant/sub-account milik penyedia jasa di penyedia pembayaran. Dana masuk ke sini, bukan ke jadwalin. */
    providerAccountId: text("provider_account_id").notNull(),
    kycStatus: text("kyc_status").notNull().default("pending"), // pending | verified | rejected
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.workspaceId, t.provider)],
);

export const payments = pgTable(
  "payments",
  {
    id: id(),
    workspaceId: workspaceId(),
    provider: text("provider").notNull(),
    /** Id yang dikirim ke penyedia sebagai order id (= payments.id dalam teks). */
    providerRef: text("provider_ref").notNull(),
    amountIdr: bigint("amount_idr", { mode: "number" }).notNull(),
    platformFeeIdr: bigint("platform_fee_idr", { mode: "number" }).notNull().default(0),
    status: text("status").notNull().default("created"),
    subjectType: text("subject_type").notNull(), // 'booking'
    subjectId: uuid("subject_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    checkoutUrl: text("checkout_url"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    refundedIdr: bigint("refunded_idr", { mode: "number" }).notNull().default(0),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.workspaceId, t.idempotencyKey), unique("payments_provider_ref").on(t.provider, t.providerRef), index("payments_subject").on(t.subjectType, t.subjectId)],
);

/** Jejak transisi pembayaran. Append-only: tanpa UPDATE/DELETE untuk role mana pun yang dipakai aplikasi. */
export const paymentEvents = pgTable("payment_events", {
  id: id(),
  workspaceId: workspaceId(),
  paymentId: uuid("payment_id").notNull().references(() => payments.id),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  source: text("source").notNull(), // webhook | api | reconcile | admin | system
  raw: jsonb("raw"),
  createdAt: createdAt(),
});

/** Kotak masuk webhook (bukan tabel tenant): hanya diakses role worker. Unik per (penyedia, id event). */
export const webhookInbox = pgTable(
  "webhook_inbox",
  {
    id: id(),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("received"), // received | processed | ignored | failed
    error: text("error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [unique().on(t.provider, t.eventId)],
);

export const refunds = pgTable(
  "refunds",
  {
    id: id(),
    workspaceId: workspaceId(),
    paymentId: uuid("payment_id").notNull().references(() => payments.id),
    amountIdr: bigint("amount_idr", { mode: "number" }).notNull(),
    status: text("status").notNull().default("requested"), // requested | succeeded | failed
    reason: text("reason"),
    /** Kunci idempoten ke penyedia (refund yang sama tak dikirim dua kali). */
    providerRefundKey: text("provider_refund_key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("refunds_key").on(t.providerRefundKey)],
);
