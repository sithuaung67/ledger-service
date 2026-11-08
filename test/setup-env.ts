import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';

// Point every test at the test database, never the dev database.
const line = readFileSync(join(__dirname, '..', '.env.test'), 'utf8').match(/DATABASE_URL="([^"]+)"/);
if (!line) throw new Error('.env.test must define DATABASE_URL');
process.env.DATABASE_URL = line[1];
