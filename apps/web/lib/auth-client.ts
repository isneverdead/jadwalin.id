"use client";
import { createAuthClient } from "better-auth/react";

// Form masuk/daftar memanggil /api/auth/* lewat klien ini agar rate limit berlaku.
export const authClient = createAuthClient();
