-- 1. Add role column to admin_users table (default to 'admin')
ALTER TABLE admin_users 
ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'admin';

-- Update existing users to 'admin' role if their role is NULL
UPDATE admin_users 
SET role = 'admin' 
WHERE role IS NULL;

-- 2. Add management_approval column to applications table (default to 'Beklemede')
ALTER TABLE applications 
ADD COLUMN IF NOT EXISTS management_approval VARCHAR(50) DEFAULT 'Beklemede';

-- Update existing approved or rejected applications to have appropriate management approval state
UPDATE applications 
SET management_approval = 'İzin Verildi' 
WHERE status = 'Onaylandı' AND management_approval = 'Beklemede';

UPDATE applications 
SET management_approval = 'Reddedildi' 
WHERE status = 'Reddedildi' AND management_approval = 'Beklemede';
