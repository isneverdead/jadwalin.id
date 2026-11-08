import { loadEnv } from "@jadwalin/config";
import { migrateUp } from "./migrate-lib";

await migrateUp(loadEnv().DATABASE_URL);
console.log("Migrasi selesai");
