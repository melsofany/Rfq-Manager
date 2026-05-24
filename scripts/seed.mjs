import bcrypt from "bcryptjs";
import pg from "pg";

const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const accounts = [
  { name: "Admin", email: "admin@cortoba-supplies.com", password: "admin123", role: "admin" },
  { name: "Khalid Al-Manager", email: "khalid@cortoba-supplies.com", password: "manager123", role: "manager" },
  { name: "Sara", email: "sara@cortoba-supplies.com", password: "staff123", role: "purchasing" },
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
console.log("Seed complete.");
