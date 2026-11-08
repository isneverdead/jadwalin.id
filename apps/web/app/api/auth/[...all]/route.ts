import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/server";

export const dynamic = "force-dynamic";

export const { GET, POST } = toNextJsHandler({ handler: (request: Request) => getAuth().handler(request) });
