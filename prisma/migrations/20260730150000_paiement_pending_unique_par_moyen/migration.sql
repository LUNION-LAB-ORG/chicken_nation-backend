-- ENCAISSEMENT PARTAGÉ : un client peut régler en PLUSIEURS moyens à la
-- livraison (ex. une partie Wave + une partie Orange Money). L'index « un seul
-- PENDING par commande » devient « un seul PENDING par commande ET PAR MOYEN » :
--   - le partage est possible (N lignes, une par moyen, montants agrégés) ;
--   - le rejeu/la concurrence restent verrouillés PAR LA BASE : deux webhooks
--     identiques créent les mêmes couples (order_id, source) → P2002 sur la
--     première ligne, la transaction du perdant est annulée en bloc (no-op).
-- Contrat : les livreurs déclarent UN montant par moyen (agrégé côté app).

DROP INDEX IF EXISTS "Paiement_order_pending_unique";

CREATE UNIQUE INDEX IF NOT EXISTS "Paiement_order_source_pending_unique"
  ON "Paiement" ("order_id", "source")
  WHERE "status" = 'PENDING';
