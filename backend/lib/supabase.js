// ============================================================
// lib/supabase.js - Supabase Client
// Creates and exports a single Supabase client instance that
// uses the SERVICE ROLE key (bypasses Row Level Security).
// This is safe because this code only runs on the server,
// never in the browser.
// ============================================================

const { createClient } = require('@supabase/supabase-js');

// createClient(url, key) initialises the Supabase SDK.
// The service role key gives full database access, so NEVER
// expose it to the frontend or commit it to version control.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = supabase;
