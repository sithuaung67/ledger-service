/** Tests run against a real PostgreSQL database (DATABASE_URL from .env.test). */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  testTimeout: 30000,
  maxWorkers: 1,
};
