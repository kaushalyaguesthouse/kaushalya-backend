# Production operations, backup, and disaster recovery

## Environment and release setup

Use Node.js 20+, install reproducibly with `npm ci`, copy `.env.example` to the platform's secret store, and validate the release with `npm test`, `npm run check`, and `git diff --check`. Never put `.env` in an image or source control. Production requires the Supabase service-role key, Razorpay credentials, two independent admin secrets of at least 32 characters, and HTTPS-only allowed origins. Deploy migrations in numeric order before the application release.

## Backup

1. Enable Supabase point-in-time recovery when the plan supports it and retain daily logical backups in a separate account/region.
2. Before each migration, run `pg_dump --format=custom --no-owner --no-acl "$DATABASE_URL" > "kaushalya-$(date -u +%Y%m%dT%H%M%SZ).dump"` from a trusted host.
3. Encrypt the dump, copy it to immutable object storage, record its SHA-256 checksum, and test a restore at least monthly. Restrict access because bookings and reviews contain personal data.
4. Back up secret *configuration metadata* and rotation procedures separately; never place plaintext secrets in the database dump.

## Restore

Provision an isolated PostgreSQL instance at the same major version, verify the dump checksum, and run `pg_restore --clean --if-exists --no-owner --no-acl --dbname "$RESTORE_DATABASE_URL" backup.dump`. Apply any later migrations in order, run `ANALYZE`, point a staging application at the restored database, and verify all three health endpoints plus booking/payment invariants. Only then schedule the production cutover. Rotate database and provider credentials after any security incident.

## Migration and rollback

Take a fresh backup, review locks with `EXPLAIN`/staging data, apply `migrations/001_production_schema.sql` and then `002_production_integrity_indexes.sql`, and retain the deployment log. Migrations are additive; application rollback means restoring the prior artifact while leaving compatible columns/indexes in place. A destructive schema rollback requires a tested restore rather than ad-hoc `DROP` statements.

## Disaster recovery runbook

Declare an incident owner, stop writes, preserve logs, identify the last known-good recovery point, restore into a new project, validate row counts/constraints and payment reconciliation, rotate every Supabase/Razorpay/admin/email secret, then change application configuration and resume traffic gradually. Verify `/health`, `/health/database`, and `/health/application`; exercise login, quote, a synthetic pay-later booking, review moderation, housekeeping, and invoice generation. Document recovery point/time objectives, timestamps, data loss, and follow-up actions. Run this exercise quarterly.

## Shutdown and monitoring

The process handles `SIGTERM`/`SIGINT`, stops accepting traffic, drains HTTP requests, removes Supabase channels, and force-closes after ten seconds. Alert on 5xx rates, repeated authentication failures, payment verification errors, database health failures, memory growth, and shutdowns. Logs are newline-delimited JSON and intentionally omit request bodies and credentials.
