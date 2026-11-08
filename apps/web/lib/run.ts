import { AppError } from "@jadwalin/core";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

/** Jalankan aksi; AppError dikembalikan ke halaman sebagai pesan, error lain dilempar. */
export async function run(back: string, fn: () => Promise<string | void>): Promise<never> {
  let target = back;
  try {
    const next = await fn();
    if (next) target = next;
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    redirect(`${back}?error=${encodeURIComponent(error.message)}`);
  }
  revalidatePath(back);
  redirect(target);
}
