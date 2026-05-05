-- Migration ciblée (pattern Neon, pas de drift).
--
-- P-chat livreur ↔ support : étend le module Tickets pour supporter le livreur
-- comme demandeur ET comme auteur de message. Le module Conversation
-- (client ↔ restaurant) n'est PAS modifié — hors scope.
--
-- 3 changements :
--   1. Deliverer.expo_push_token (token Expo pour notif push)
--   2. TicketThread.delivererId (le livreur qui a ouvert le ticket)
--   3. TicketMessage.authorDelivererId (auteur livreur d'un message)

-- ── Deliverer : expo push token ──────────────────────────────────────────
ALTER TABLE "Deliverer"
  ADD COLUMN IF NOT EXISTS "expo_push_token" VARCHAR(255);

-- ── TicketThread : delivererId (demandeur livreur) ───────────────────────
ALTER TABLE "TicketThread"
  ADD COLUMN IF NOT EXISTS "delivererId" UUID;

DO $$ BEGIN
  ALTER TABLE "TicketThread"
    ADD CONSTRAINT "TicketThread_delivererId_fkey"
    FOREIGN KEY ("delivererId") REFERENCES "Deliverer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "TicketThread_delivererId_idx"
  ON "TicketThread" ("delivererId");

-- ── TicketMessage : authorDelivererId (auteur livreur) ───────────────────
ALTER TABLE "TicketMessage"
  ADD COLUMN IF NOT EXISTS "authorDelivererId" UUID;

DO $$ BEGIN
  ALTER TABLE "TicketMessage"
    ADD CONSTRAINT "TicketMessage_authorDelivererId_fkey"
    FOREIGN KEY ("authorDelivererId") REFERENCES "Deliverer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "TicketMessage_authorDelivererId_idx"
  ON "TicketMessage" ("authorDelivererId");
