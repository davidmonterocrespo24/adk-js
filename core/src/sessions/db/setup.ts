import {
  checkDatabaseSetup as checkPostgresDatabaseSetup,
  isPostgresConnectionString,
  setupDatabase as setupPostgresDatabase,
} from './postgres/index.js';

const SUPPORTED_DATABASE_TYPES = [
  'postgres',
  // 'mysql',
  // 'sqlite',
  // 'mssql',
  // 'oracle',
];

/**
 * Checks if the given connection string is a database connection string.
 */
export function checkDatabaseSetup(connectionString: string): Promise<boolean> {
  if (isPostgresConnectionString(connectionString)) {
    return checkPostgresDatabaseSetup(connectionString);
  }

  throw new Error(
    `Unsupported database type, supported types: ${SUPPORTED_DATABASE_TYPES.join(
      ', ',
    )}`,
  );
}

/**
 * Sets up the database by running migrations.
 */
export function setupDatabase(connectionString: string): Promise<void> {
  if (isPostgresConnectionString(connectionString)) {
    return setupPostgresDatabase(connectionString);
  }

  throw new Error(
    `Unsupported database type, supported types: ${SUPPORTED_DATABASE_TYPES.join(
      ', ',
    )}`,
  );
}
