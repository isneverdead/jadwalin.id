#!/usr/bin/env node
// Pemindai rahasia sederhana untuk berkas yang dilacak/akan dilacak git. Gagal (exit 1) bila menemukan pola kunci/rahasia.
// Bukan pengganti pemindai penuh (gitleaks); cukup untuk menahan kesalahan umum di CI.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PATTERNS = [
  ["kunci privat", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Sentry DSN berisi kunci", /https:\/\/[0-9a-f]{20,}@[\w.-]*sentry\.io\/\d+/],
  ["Midtrans server key", /\b(?:SB-)?Mid-server-[A-Za-z0-9_-]{16,}/],
  ["Xendit secret key", /\bxnd_(?:development|production)_[A-Za-z0-9]{20,}/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ["URL basis data dengan kata sandi non-dev", /postgres(?:ql)?:\/\/[^:\s/]+:(?!jadwalin\b|\$|\{|<|password|\*)[^@\s]{8,}@(?!localhost|127\.0\.0\.1)/],
];
const SKIP = /(^|\/)(pnpm-lock\.yaml|node_modules\/|\.next\/|promo\/|\.claude\/|scripts\/check-secrets\.mjs)/;

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\n").filter((f) => f && !SKIP.test(f));
let bad = 0;
for (const f of files) {
  let text;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\0")) continue;
  text.split("\n").forEach((line, i) => {
    if (line.includes("secret-scan:allow")) return;
    for (const [name, re] of PATTERNS) {
      if (re.test(line)) {
        console.error(`${f}:${i + 1}: kemungkinan ${name}`);
        bad++;
      }
    }
  });
}
// .env asli tidak boleh ikut dilacak.
const envs = files.filter((f) => /(^|\/)\.env(\.[\w-]+)?$/.test(f) && !f.endsWith(".example"));
for (const f of envs) {
  console.error(`${f}: berkas .env tidak boleh dilacak git`);
  bad++;
}
if (bad) {
  console.error(`\n${bad} temuan.`);
  process.exit(1);
}
console.log(`Pemindaian rahasia bersih (${files.length} berkas).`);
