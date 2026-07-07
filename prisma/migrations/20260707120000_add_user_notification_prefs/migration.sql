-- Préférences de notification par membre du staff (User).
-- Idempotent (ADD COLUMN IF NOT EXISTS) pour éviter tout drift Neon.
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "email_notifications_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "in_app_notifications_enabled" BOOLEAN NOT NULL DEFAULT true;
