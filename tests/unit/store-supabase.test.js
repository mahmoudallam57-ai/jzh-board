import { runContract } from "./store.contract.js";
import { createSupabaseStore } from "../../lib/store-supabase.js";

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
const live = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);

runContract(
  "supabase",
  async () => createSupabaseStore(SUPABASE_URL, SUPABASE_SERVICE_KEY),
  { skip: live ? false : "SUPABASE_URL/SUPABASE_SERVICE_KEY not set" },
);
