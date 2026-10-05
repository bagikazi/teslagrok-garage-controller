import { randomBytes, scryptSync } from "node:crypto";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://garage:change-me-local-only@localhost:5432/garage";
const email = process.env.OWNER_EMAIL ?? "owner@example.com";
const password = process.env.OWNER_PASSWORD;
if (!password || password.length < 12) throw new Error("Set OWNER_PASSWORD to at least 12 characters; nothing was changed.");
const salt = randomBytes(16).toString("hex");
const hash = `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
const pool = new pg.Pool({ connectionString: databaseUrl });
await pool.query("INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'owner') ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'owner'", [email, hash]);
await pool.end();
console.log(`Owner account ready: ${email}`);
