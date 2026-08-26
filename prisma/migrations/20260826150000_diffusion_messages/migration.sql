-- DIFFUSION DE MESSAGES : envoyer le même message à une liste de clients.
-- Additif. Aucune colonne existante n'est modifiée, aucune écriture bloquée.

-- 1. Marqueurs sur la conversation.
--    Une conversation issue d'une diffusion reste HORS de la boîte de réception
--    du backoffice tant que le client n'a pas répondu : sans cela, une seule
--    diffusion à mille clients noierait le service client pour de bon.
ALTER TABLE "Conversation"
  ADD COLUMN "isBroadcast" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "hasReply"    BOOLEAN NOT NULL DEFAULT false;

-- 2. Rattachement d'un message à sa diffusion.
ALTER TABLE "Message" ADD COLUMN "broadcastId" UUID;

-- 3. La diffusion elle-même.
CREATE TABLE "MessageBroadcast" (
  "id"             UUID         NOT NULL,
  "name"           VARCHAR      NOT NULL,
  "body"           TEXT         NOT NULL,
  "target_type"    VARCHAR      NOT NULL,
  "target_config"  JSONB        NOT NULL,
  "status"         VARCHAR      NOT NULL DEFAULT 'draft',
  "scheduled_at"   TIMESTAMP(6),
  "started_at"     TIMESTAMP(6),
  "sent_at"        TIMESTAMP(6),
  "total_targeted" INTEGER      NOT NULL DEFAULT 0,
  "enqueue_seq"    INTEGER      NOT NULL DEFAULT 0,
  "created_by"     VARCHAR      NOT NULL,
  "created_at"     TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MessageBroadcast_pkey" PRIMARY KEY ("id")
);

-- 4. Les destinataires, matérialisés à la création : l'audience est FIGÉE.
CREATE TABLE "MessageBroadcastRecipient" (
  "id"              UUID         NOT NULL,
  "broadcast_id"    UUID         NOT NULL,
  "customer_id"     UUID         NOT NULL,
  "status"          VARCHAR      NOT NULL DEFAULT 'pending',
  "claimed_at"      TIMESTAMP(6),
  "sent_at"         TIMESTAMP(6),
  "error"           TEXT,
  "conversation_id" UUID,
  "message_id"      UUID,
  "created_at"      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MessageBroadcastRecipient_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MessageBroadcast_status_created_at_idx"   ON "MessageBroadcast"("status", "created_at");
CREATE INDEX "MessageBroadcast_status_scheduled_at_idx" ON "MessageBroadcast"("status", "scheduled_at");
CREATE INDEX "MessageBroadcastRecipient_broadcast_id_status_idx" ON "MessageBroadcastRecipient"("broadcast_id", "status");
CREATE INDEX "MessageBroadcastRecipient_status_claimed_at_idx"   ON "MessageBroadcastRecipient"("status", "claimed_at");

-- Un client ne figure qu'une fois dans une diffusion. C'est le premier verrou
-- d'idempotence : une relance ne peut pas dédoubler l'audience.
CREATE UNIQUE INDEX "MessageBroadcastRecipient_broadcast_id_customer_id_key"
  ON "MessageBroadcastRecipient"("broadcast_id", "customer_id");

ALTER TABLE "Message"
  ADD CONSTRAINT "Message_broadcastId_fkey"
  FOREIGN KEY ("broadcastId") REFERENCES "MessageBroadcast"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MessageBroadcastRecipient"
  ADD CONSTRAINT "MessageBroadcastRecipient_broadcast_id_fkey"
  FOREIGN KEY ("broadcast_id") REFERENCES "MessageBroadcast"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MessageBroadcastRecipient"
  ADD CONSTRAINT "MessageBroadcastRecipient_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 5. ⚠️ VERROU D'IDEMPOTENCE FINAL, non exprimable par Prisma.
--    Une diffusion ne peut écrire qu'UNE seule fois dans une conversation.
--    Sans lui, la fenêtre entre la création du message et l'inscription de son
--    identifiant sur la ligne du destinataire suffit à livrer deux fois le même
--    message si le processus est relancé au mauvais moment.
CREATE UNIQUE INDEX "Message_conversation_broadcast_unique"
  ON "Message"("conversationId", "broadcastId")
  WHERE "broadcastId" IS NOT NULL;

-- 6. L'index qui sert les requêtes CHAUDES de la boîte de réception, qui
--    filtrent toutes `broadcastId IS NULL` (compteurs de non lus du staff).
CREATE INDEX "Message_conversation_isRead_hors_diffusion_idx"
  ON "Message"("conversationId", "isRead")
  WHERE "broadcastId" IS NULL;

-- 7. La boîte de réception ne liste que les conversations ordinaires, ou les
--    diffusions auxquelles un client a répondu.
CREATE INDEX "Conversation_inbox_idx"
  ON "Conversation"("updatedAt" DESC)
  WHERE "isBroadcast" = false OR "hasReply" = true;

-- 8. ⚠️ UN SEUL canal de diffusion par client.
--    Le consommateur fait un `findFirst` puis un `create` : deux diffusions qui
--    partent en même temps pour le même client ouvriraient deux canaux, et le
--    client verrait ses promotions se répartir entre deux fils.
CREATE UNIQUE INDEX "Conversation_canal_diffusion_unique"
  ON "Conversation"("customerId")
  WHERE "isBroadcast" = true AND "customerId" IS NOT NULL;
