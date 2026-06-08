-- ============================================================
-- Ajoute User.expo_push_token (notifications push staff mobile)
-- ============================================================
-- Token Expo Push enregistré par l'app Chicken Nation Pro au login.
-- NULL si l'utilisateur ne s'est jamais connecté sur mobile, ou s'il
-- a refusé les permissions de notifications.
--
-- Migration idempotente (IF NOT EXISTS) pour rejouer sans erreur sur
-- Neon, en cas de drift mineur.
-- ============================================================

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "expo_push_token" VARCHAR(255);
