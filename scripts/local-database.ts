/** Database tooling is deliberately limited to loopback connections. */
export function requireLocalDatabase(connectionString: string | undefined): string {
  if (!connectionString) throw new Error('A local database URL is required');
  const url = new URL(connectionString);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  ) {
    throw new Error('Database scripts and integration tests only accept local PostgreSQL URLs');
  }
  if (url.searchParams.has('host') || url.searchParams.has('hostaddr')) {
    throw new Error('Database host overrides are not allowed');
  }
  return connectionString;
}
