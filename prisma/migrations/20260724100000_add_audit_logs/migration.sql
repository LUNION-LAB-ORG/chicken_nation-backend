-- Journal d'audit du personnel (backoffice). Additif + idempotent.
-- Table dénormalisée : aucune FK vers User/Restaurant (le log survit à la
-- suppression de son auteur ; actor_name/role sont figés à l'écriture).

CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "actor_id"      UUID,
  "actor_name"    VARCHAR,
  "actor_role"    VARCHAR,
  "restaurant_id" UUID,
  "action"        VARCHAR NOT NULL,
  "module"        VARCHAR,
  "entity_id"     VARCHAR,
  "method"        VARCHAR NOT NULL,
  "path"          TEXT NOT NULL,
  "status_code"   INTEGER,
  "duration_ms"   INTEGER,
  "ip"            VARCHAR,
  "user_agent"    TEXT,
  "summary"       TEXT,
  "metadata"      JSONB,
  "created_at"    TIMESTAMP(6) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "audit_logs_created_at_idx"  ON "audit_logs" ("created_at");
CREATE INDEX IF NOT EXISTS "audit_logs_actor_id_idx"    ON "audit_logs" ("actor_id");
CREATE INDEX IF NOT EXISTS "audit_logs_module_idx"      ON "audit_logs" ("module");
CREATE INDEX IF NOT EXISTS "audit_logs_action_idx"      ON "audit_logs" ("action");
CREATE INDEX IF NOT EXISTS "audit_logs_status_code_idx" ON "audit_logs" ("status_code");
