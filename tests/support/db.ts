// Post-checks in the application's database, after the UI steps: did the record really land, with the right data?
//
//   const [order] = await dbQuery('select status from orders where order_no = $1', [orderNo]);
//
// The database is the project's, for the environment of the run: set it in the app under Projects > Edit >
// Database (placeholders: $1, $2 for PostgreSQL, ? for MySQL). The app passes it as E2E_DB_URL.
// Every query runs in a READ ONLY transaction that is rolled back: a post-check can never change data.
import pg from 'pg';
import mysql from 'mysql2/promise';

export async function dbQuery<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const url = process.env.E2E_DB_URL;
  if (!url) throw new Error(`No database is set for this project in environment "${process.env.E2E_ENV || 'none'}": an admin adds it under Projects > Edit > Database`);
  const protocol = new URL(url).protocol;

  if (protocol === 'postgres:' || protocol === 'postgresql:') {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query('BEGIN READ ONLY');
      return (await client.query(sql, params)).rows as T[];
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }
  }

  if (protocol === 'mysql:') {
    const conn = await mysql.createConnection(url);
    try {
      await conn.query('START TRANSACTION READ ONLY');
      const [rows] = await conn.query(sql, params);
      return rows as T[];
    } finally {
      await conn.query('ROLLBACK').catch(() => {});
      await conn.end();
    }
  }

  throw new Error('E2E_DB_URL must start with postgres:// or mysql://');
}
