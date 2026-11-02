import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Un único cliente para toda la app (login + datos), así la sesión se comparte.
export const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
