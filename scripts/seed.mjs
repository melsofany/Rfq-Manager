import bcrypt from "bcryptjs";
import pg from "pg";

const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

// Passwords must be provided via env vars (SEED_ADMIN_PASS, SEED_MANAGER_PASS, SEED_STAFF_PASS)
// Fall back to randomly-generated defaults that are logged once and MUST be changed
function requirePass(envVar, label) {
  const val = process.env[envVar];
  if (!val) {
    throw new Error(`Missing env var ${envVar} — set it before seeding (e.g. ${envVar}=ChangeMe!123)`);
  }
  return val;
}

const accounts = [
  { name: "Admin", email: "admin@cortoba-supplies.com", password: requirePass("SEED_ADMIN_PASS", "admin"), role: "admin" },
  { name: "Khalid Al-Manager", email: "khalid@cortoba-supplies.com", password: requirePass("SEED_MANAGER_PASS", "manager"), role: "manager" },
  { name: "Sara", email: "sara@cortoba-supplies.com", password: requirePass("SEED_STAFF_PASS", "staff"), role: "purchasing" },
];

for (const acc of accounts) {
  const hash = await bcrypt.hash(acc.password, 10);
  await client.query(
    `INSERT INTO employees (name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, $4, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = $3, role = $4`,
    [acc.name, acc.email, hash, acc.role]
  );
  console.log("Seeded: " + acc.email);
}

await client.end();
console.log("Seed complete. Change all passwords immediately after first login.");
