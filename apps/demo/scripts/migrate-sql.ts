/**
 * Direct SQL migration runner — bypasses MikroORM decorator metadata requirement
 * by reading the migration files and executing the SQL directly.
 * Usage: `pnpm exec tsx scripts/migrate-sql.ts`
 */
import { Client } from 'pg';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(__dirname, '..', 'src', 'migrations');

/**
 * Extract addSql(`...`) calls that are INSIDE the up() method, not down().
 * Strategy: take everything from `async up()` to the next `async ` (which starts down()).
 */
function extractUpSql(source: string): string[] {
  const upStart = source.search(/async\s+up\s*\(/);
  if (upStart < 0) return [];
  const upEnd = source.indexOf('async', upStart + 8);
  const upBody = upEnd > 0 ? source.slice(upStart, upEnd) : source.slice(upStart);
  const out: string[] = [];
  const re = /this\.addSql\(\s*`([\s\S]*?)`\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(upBody)) !== null) {
    out.push(m[1]);
  }
  return out;
}

async function main() {
  const client = new Client({
    host: process.env.DATABASE_HOST ?? 'localhost',
    port: Number(process.env.DATABASE_PORT ?? 5434),
    user: process.env.DATABASE_USER ?? 'demo',
    password: process.env.DATABASE_PASSWORD ?? 'demo',
    database: process.env.DATABASE_NAME ?? 'nest_batch_demo',
  });
  await client.connect();
  console.log('Connected to postgres.');

  // Read migration files in order
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.ts')).sort();
  for (const f of files) {
    console.log(`\n--- Migration: ${f} ---`);
    const src = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    const sqls = extractUpSql(src);
    for (const sql of sqls) {
      console.log(`Executing: ${sql.slice(0, 80).replace(/\s+/g, ' ')}...`);
      try {
        await client.query(sql);
        console.log('  OK');
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes('already exists')) {
          console.log('  (skipped — already exists)');
        } else {
          throw err;
        }
      }
    }
  }

  // Verify tables
  const res = await client.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND (table_name LIKE 'batch_%' OR table_name = 'product')
    ORDER BY table_name;
  `);
  console.log('\nTables created:');
  for (const row of res.rows) {
    console.log(`  - ${row.table_name}`);
  }

  await client.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
