"use client";
import Script from "next/script";

/** Widget Cloudflare Turnstile (render implisit): menambahkan input tersembunyi `cf-turnstile-response` ke form terdekat. */
export function Turnstile({ siteKey, nonce }: { siteKey: string; nonce?: string }) {
  return (
    <>
      <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js" strategy="afterInteractive" nonce={nonce} async defer />
      <div className="cf-turnstile" data-sitekey={siteKey} data-theme="auto" />
    </>
  );
}
