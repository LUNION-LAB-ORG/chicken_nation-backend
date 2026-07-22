-- Parrainage v2 : le filleul reçoit un CADEAU À GRATTER à l'inscription (Reward),
-- et le parrain est récompensé quand le filleul UTILISE ce cadeau sur une commande.
-- Additif + idempotent (Neon / double-backend).

ALTER TABLE "Referral" ADD COLUMN IF NOT EXISTS "filleul_reward_id" UUID;
