-- PRIX FIGÉ SUR LA LIGNE DE COMMANDE (06/08).
--
-- Une ligne ne gardait que `amount`, dont le sens diffère selon le canal
-- (prix unitaire côté call center, prix unitaire fois quantité côté
-- application), et le prix des suppléments n'était enregistré nulle part.
-- Les calculs de chiffre d'affaires, le reçu PDF et les tickets relisaient
-- donc le prix VIVANT du catalogue : changer un prix aujourd'hui réécrivait
-- le chiffre d'affaires d'hier.
--
-- Ces colonnes gravent ce qui a réellement été payé. Additif et idempotent :
-- rien ne les lit encore, les lecteurs basculeront un par un.

ALTER TABLE "OrderItem"
  ADD COLUMN IF NOT EXISTS "unit_price"    DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "options_price" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "line_total"    DOUBLE PRECISION;

-- REPRISE DE L'HISTORIQUE, au mieux de ce que la base sait encore dire.
-- On ne peut pas reconstituer le prix des suppléments passés (jamais stocké),
-- on pose donc options_price = 0 et on déduit le reste de `amount`, en tenant
-- compte des deux sémantiques. Heuristique assumée : une ligne dont `amount`
-- dépasse le prix catalogue courant multiplié par la quantité a été écrite par
-- le call center (prix unitaire), les autres par l'application.
UPDATE "OrderItem" oi
SET options_price = 0,
    unit_price = CASE
      WHEN oi.quantity > 0 AND oi.amount > 0 AND d.price > 0
           AND oi.amount <= d.price * 1.5 THEN oi.amount            -- prix unitaire (call center)
      WHEN oi.quantity > 0 THEN oi.amount / oi.quantity             -- prix × quantité (application)
      ELSE oi.amount
    END,
    line_total = CASE
      WHEN oi.quantity > 0 AND oi.amount > 0 AND d.price > 0
           AND oi.amount <= d.price * 1.5 THEN oi.amount * oi.quantity
      ELSE oi.amount
    END
FROM "Dish" d
WHERE d.id = oi.dish_id AND oi.line_total IS NULL;
