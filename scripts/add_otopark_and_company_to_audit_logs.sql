-- SQL migration to add otopark_name and company_name columns to audit_logs table
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS otopark_name text;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS company_name text;
