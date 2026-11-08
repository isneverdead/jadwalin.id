import { pino } from "pino";

/** Log terstruktur JSON. Jangan mencatat email, token, isi pesan, atau nama klien; catat id dan jenis kejadian saja. */
export const logger = pino({
  name: "jadwalin-web",
  level: process.env.LOG_LEVEL ?? "info",
  redact: { paths: ["*.email", "*.token", "*.password", "*.phone", "req.headers.cookie", "req.headers.authorization"], censor: "[disamarkan]" },
});
