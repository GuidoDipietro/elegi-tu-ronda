import pg from "pg";
import { rootCertificates } from "node:tls";
import { supabaseCa } from "./supabase-ca.js";
let pool: pg.Pool | undefined;
export function database(): pg.Pool {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const url = new URL(process.env.DATABASE_URL);
  const supabase = url.hostname.endsWith(".pooler.supabase.com") || url.hostname.endsWith(".supabase.co");
  // pg gives SSL URL parameters precedence over the explicit ssl object.
  // For Supabase, always use the bundled trust roots and verified TLS.
  if (supabase) {
    for (const key of ["sslmode", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"]) url.searchParams.delete(key);
  }
  return (pool ??= new pg.Pool({
    connectionString: url.toString(),
    ...(supabase ? { ssl: { ca: [...rootCertificates, supabaseCa], rejectUnauthorized: true } } : {}),
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
  }));
}
