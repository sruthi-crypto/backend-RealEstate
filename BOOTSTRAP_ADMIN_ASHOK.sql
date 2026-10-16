-- One-time recovery for the deleted admin account.
-- Run this in Supabase SQL Editor.
-- Then initialize Google Authenticator using the admin setup flow.

INSERT INTO public.users (
  username,
  email,
  password_hash,
  role,
  is_active,
  "twoFactorEnabled"
)
VALUES (
  'ashokreddysinga123',
  'ashokreddysinga123@gmail.com',
  -- Admin login uses Google Authenticator; this satisfies older schemas
  -- that incorrectly require password_hash for every user row.
  '0000000000000000000000000000000000000000000000000000000000000000',
  'admin',
  true,
  false
)
ON CONFLICT (email) DO UPDATE SET
  username = EXCLUDED.username,
  password_hash = EXCLUDED.password_hash,
  role = 'admin',
  is_active = true,
  "twoFactorEnabled" = false,
  "twoFactorSecret" = NULL;

SELECT id, username, email, role, is_active, "twoFactorEnabled"
FROM public.users
WHERE email = 'ashokreddysinga123@gmail.com';
