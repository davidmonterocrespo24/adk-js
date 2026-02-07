/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {drizzle} from 'drizzle-orm/node-postgres';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import {Pool} from 'pg';
import * as schema from './schema.js';

// Support ESM and CJS
const dirname =
  typeof __dirname !== 'undefined'
    ? __dirname
    : path.dirname(new URL(import.meta.url).pathname);

export type PostgresDB = ReturnType<typeof drizzle<typeof schema>>;

let dbInstance: PostgresDB | undefined;

/**
 * Returns the postgres database instance.
 */
export function getDb(connectionString?: string): PostgresDB {
  if (!dbInstance) {
    if (!connectionString) {
      connectionString = process.env.DATABASE_URL;
    }

    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is not set');
    }

    if (!isPostgresConnectionString(connectionString)) {
      throw new Error(
        'Invalid DATABASE_URL. It should start with "postgresql://".',
      );
    }

    const pool = new Pool({connectionString});
    dbInstance = drizzle(pool, {schema});
  }

  return dbInstance;
}

/**
 * Checks if the given connection string is a Postgres connection string.
 */
export function isPostgresConnectionString(connectionString: string): boolean {
  return connectionString.startsWith('postgresql://');
}

/**
 * Sets up the database by running migrations.
 */
export async function setupDatabase(connectionString: string): Promise<void> {
  await migrate(getDb(connectionString), {
    migrationsFolder: path.join(dirname, 'migrations'),
  });
}

/**
 * Checks if the database is set up.
 */
export async function checkDatabaseSetup(
  connectionString: string,
): Promise<boolean> {
  // try {
  //   const db = getDb(connectionString);

  //   return true;
  // } catch (e: unknown) {
  //   console.error('Database is not set up:', e);
  //   return false;
  // }
  return !!connectionString;
}

export {schema};
