"use client";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export function LogoutButton() {
  const router = useRouter();
  return (
    <button
      className="link"
      onClick={async () => {
        await authClient.signOut();
        router.push("/masuk");
        router.refresh();
      }}
    >
      Keluar
    </button>
  );
}
