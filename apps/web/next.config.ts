import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@jadwalin/core", "@jadwalin/db", "@jadwalin/config", "@jadwalin/module-tickets"],
  // Sentry/OpenTelemetry memakai require dinamis dan modul Node: jangan dibundel webpack.
  serverExternalPackages: ["pg", "@sentry/node", "@sentry/core", "@opentelemetry/instrumentation", "require-in-the-middle", "import-in-the-middle"],
  poweredByHeader: false,
};

export default config;
