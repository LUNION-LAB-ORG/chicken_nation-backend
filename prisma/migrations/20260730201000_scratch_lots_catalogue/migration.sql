-- CATALOGUE GRATTE & GAGNE — création des lots (version RÉVISÉE 30/07) :
--
--   • Palier 0 SUPPRIMÉ : les paniers < 10 000 F ne gagnent RIEN (le plancher
--     — révélation des points — reste géré à part, is_floor).
--   • Palier 1 : bon d'achat à 500 F (et non 1 000 F) ; le code promo -10 %
--     est RETIRÉ du catalogue.
--   • CADEAUX (plats offerts) : réservés aux clients un peu fidèles —
--     min_paid_orders = 3 commandes payées OU min_revenue = 25 000 F de CA
--     net sur la fenêtre d'éligibilité (défaut 90 j). L'un des deux suffit.
--     Les suppléments offerts et les bons restent accessibles à tous.
--
-- IDEMPOTENT : chaque lot n'est créé que s'il n'existe pas déjà (par label) —
-- rejouable sans doublon sur les deux backends. Les lots GIFT résolvent le
-- plat/supplément PAR NOM (insensible à la casse, le moins cher en cas de
-- variantes) et snapshotent nom/prix/image comme l'éditeur backoffice ; si le
-- produit est introuvable, le lot n'est PAS créé (vérifier après déploiement :
--   SELECT label FROM "ScratchLot" ORDER BY min_cart, label;
-- et créer les manquants depuis le backoffice).

-- ============================================================ PALIER 1 (≥ 10 000 F)

INSERT INTO "ScratchLot" (id, label, reward_type, payload, weight, unit_cost, min_cart, frequency_cap, stock, min_paid_orders, min_revenue, is_floor, active, updated_at)
SELECT gen_random_uuid(), 'Bon d''achat 500 FCFA', 'VOUCHER', jsonb_build_object('amount', 500), 20, 500, 10000, NULL, NULL, 0, 0, false, true, now()
WHERE NOT EXISTS (SELECT 1 FROM "ScratchLot" WHERE label = 'Bon d''achat 500 FCFA');

INSERT INTO "ScratchLot" (id, label, reward_type, payload, weight, unit_cost, min_cart, frequency_cap, stock, min_paid_orders, min_revenue, is_floor, active, updated_at)
SELECT gen_random_uuid(), 'Cristalline offerte', 'GIFT',
       jsonb_build_object('item_type','SUPPLEMENT','supplement_id', s.id, 'label', s.name, 'name', s.name, 'price', s.price, 'quantity', 1)
         || CASE WHEN s.image IS NOT NULL THEN jsonb_build_object('image', s.image) ELSE '{}'::jsonb END,
       20, 500, 10000, NULL, NULL, 0, 0, false, true, now()
FROM (SELECT id, name, price, image FROM "Supplement" WHERE available = true AND name ILIKE 'cristalline%' ORDER BY price ASC LIMIT 1) s
WHERE NOT EXISTS (SELECT 1 FROM "ScratchLot" WHERE label = 'Cristalline offerte');

INSERT INTO "ScratchLot" (id, label, reward_type, payload, weight, unit_cost, min_cart, frequency_cap, stock, min_paid_orders, min_revenue, is_floor, active, updated_at)
SELECT gen_random_uuid(), 'Ketchup offert', 'GIFT',
       jsonb_build_object('item_type','SUPPLEMENT','supplement_id', s.id, 'label', s.name, 'name', s.name, 'price', s.price, 'quantity', 1)
         || CASE WHEN s.image IS NOT NULL THEN jsonb_build_object('image', s.image) ELSE '{}'::jsonb END,
       12, 1000, 10000, NULL, NULL, 0, 0, false, true, now()
FROM (SELECT id, name, price, image FROM "Supplement" WHERE available = true AND name ILIKE 'ketchup%' ORDER BY price ASC LIMIT 1) s
WHERE NOT EXISTS (SELECT 1 FROM "ScratchLot" WHERE label = 'Ketchup offert');

INSERT INTO "ScratchLot" (id, label, reward_type, payload, weight, unit_cost, min_cart, frequency_cap, stock, min_paid_orders, min_revenue, is_floor, active, updated_at)
SELECT gen_random_uuid(), 'Mayonnaise offerte', 'GIFT',
       jsonb_build_object('item_type','SUPPLEMENT','supplement_id', s.id, 'label', s.name, 'name', s.name, 'price', s.price, 'quantity', 1)
         || CASE WHEN s.image IS NOT NULL THEN jsonb_build_object('image', s.image) ELSE '{}'::jsonb END,
       12, 1000, 10000, NULL, NULL, 0, 0, false, true, now()
FROM (SELECT id, name, price, image FROM "Supplement" WHERE available = true AND name ILIKE 'mayonnaise%' ORDER BY price ASC LIMIT 1) s
WHERE NOT EXISTS (SELECT 1 FROM "ScratchLot" WHERE label = 'Mayonnaise offerte');

INSERT INTO "ScratchLot" (id, label, reward_type, payload, weight, unit_cost, min_cart, frequency_cap, stock, min_paid_orders, min_revenue, is_floor, active, updated_at)
SELECT gen_random_uuid(), 'Coca canette offert', 'GIFT',
       jsonb_build_object('item_type','SUPPLEMENT','supplement_id', s.id, 'label', s.name, 'name', s.name, 'price', s.price, 'quantity', 1)
         || CASE WHEN s.image IS NOT NULL THEN jsonb_build_object('image', s.image) ELSE '{}'::jsonb END,
       12, 1000, 10000, NULL, NULL, 0, 0, false, true, now()
FROM (SELECT id, name, price, image FROM "Supplement" WHERE available = true AND name ILIKE 'coca%canette%' ORDER BY price ASC LIMIT 1) s
WHERE NOT EXISTS (SELECT 1 FROM "ScratchLot" WHERE label = 'Coca canette offert');

INSERT INTO "ScratchLot" (id, label, reward_type, payload, weight, unit_cost, min_cart, frequency_cap, stock, min_paid_orders, min_revenue, is_floor, active, updated_at)
SELECT gen_random_uuid(), 'Sprite offert', 'GIFT',
       jsonb_build_object('item_type','SUPPLEMENT','supplement_id', s.id, 'label', s.name, 'name', s.name, 'price', s.price, 'quantity', 1)
         || CASE WHEN s.image IS NOT NULL THEN jsonb_build_object('image', s.image) ELSE '{}'::jsonb END,
       10, 1000, 10000, NULL, NULL, 0, 0, false, true, now()
FROM (SELECT id, name, price, image FROM "Supplement" WHERE available = true AND name ILIKE 'sprite%' ORDER BY price ASC LIMIT 1) s
WHERE NOT EXISTS (SELECT 1 FROM "ScratchLot" WHERE label = 'Sprite offert');

INSERT INTO "ScratchLot" (id, label, reward_type, payload, weight, unit_cost, min_cart, frequency_cap, stock, min_paid_orders, min_revenue, is_floor, active, updated_at)
SELECT gen_random_uuid(), 'Glace vanille offerte', 'GIFT',
       jsonb_build_object('item_type','SUPPLEMENT','supplement_id', s.id, 'label', s.name, 'name', s.name, 'price', s.price, 'quantity', 1)
         || CASE WHEN s.image IS NOT NULL THEN jsonb_build_object('image', s.image) ELSE '{}'::jsonb END,
       10, 1000, 10000, NULL, NULL, 0, 0, false, true, now()
FROM (SELECT id, name, price, image FROM "Supplement" WHERE available = true AND name ILIKE 'glace vanille%' ORDER BY price ASC LIMIT 1) s
WHERE NOT EXISTS (SELECT 1 FROM "ScratchLot" WHERE label = 'Glace vanille offerte');

INSERT INTO "ScratchLot" (id, label, reward_type, payload, weight, unit_cost, min_cart, frequency_cap, stock, min_paid_orders, min_revenue, is_floor, active, updated_at)
SELECT gen_random_uuid(), 'Frites moyen offertes', 'GIFT',
       jsonb_build_object('item_type','SUPPLEMENT','supplement_id', s.id, 'label', s.name, 'name', s.name, 'price', s.price, 'quantity', 1)
         || CASE WHEN s.image IS NOT NULL THEN jsonb_build_object('image', s.image) ELSE '{}'::jsonb END,
       8, 1500, 10000, NULL, NULL, 0, 0, false, true, now()
FROM (SELECT id, name, price, image FROM "Supplement" WHERE available = true AND name ILIKE 'frite%moyen%' ORDER BY price ASC LIMIT 1) s
WHERE NOT EXISTS (SELECT 1 FROM "ScratchLot" WHERE label = 'Frites moyen offertes');

-- ============================================================ PALIER 2 (≥ 30 000 F)

INSERT INTO "ScratchLot" (id, label, reward_type, payload, weight, unit_cost, min_cart, frequency_cap, stock, min_paid_orders, min_revenue, is_floor, active, updated_at)
SELECT gen_random_uuid(), 'Bon d''achat 2 000 FCFA', 'VOUCHER', jsonb_build_object('amount', 2000), 5, 2000, 30000, NULL, NULL, 0, 0, false, true, now()
WHERE NOT EXISTS (SELECT 1 FROM "ScratchLot" WHERE label = 'Bon d''achat 2 000 FCFA');

INSERT INTO "ScratchLot" (id, label, reward_type, payload, weight, unit_cost, min_cart, frequency_cap, stock, min_paid_orders, min_revenue, is_floor, active, updated_at)
SELECT gen_random_uuid(), '6 Nuggets offerts', 'GIFT',
       jsonb_build_object('item_type','DISH','dish_id', d.id, 'label', d.name, 'name', d.name, 'price', d.price, 'quantity', 1)
         || CASE WHEN d.image IS NOT NULL THEN jsonb_build_object('image', d.image) ELSE '{}'::jsonb END,
       5, 2000, 30000, NULL, NULL, 3, 25000, false, true, now()
FROM (SELECT id, name, price, image FROM "Dish" WHERE entity_status <> 'DELETED' AND name ILIKE '%nugget%' ORDER BY price ASC LIMIT 1) d
WHERE NOT EXISTS (SELECT 1 FROM "ScratchLot" WHERE label = '6 Nuggets offerts');

INSERT INTO "ScratchLot" (id, label, reward_type, payload, weight, unit_cost, min_cart, frequency_cap, stock, min_paid_orders, min_revenue, is_floor, active, updated_at)
SELECT gen_random_uuid(), 'Chicken Sandwich offert', 'GIFT',
       jsonb_build_object('item_type','DISH','dish_id', d.id, 'label', d.name, 'name', d.name, 'price', d.price, 'quantity', 1)
         || CASE WHEN d.image IS NOT NULL THEN jsonb_build_object('image', d.image) ELSE '{}'::jsonb END,
       5, 2000, 30000, NULL, NULL, 3, 25000, false, true, now()
FROM (SELECT id, name, price, image FROM "Dish" WHERE entity_status <> 'DELETED' AND name ILIKE '%chicken%sandwich%' ORDER BY price ASC LIMIT 1) d
WHERE NOT EXISTS (SELECT 1 FROM "ScratchLot" WHERE label = 'Chicken Sandwich offert');

INSERT INTO "ScratchLot" (id, label, reward_type, payload, weight, unit_cost, min_cart, frequency_cap, stock, min_paid_orders, min_revenue, is_floor, active, updated_at)
SELECT gen_random_uuid(), 'Fitini offert', 'GIFT',
       jsonb_build_object('item_type','DISH','dish_id', d.id, 'label', d.name, 'name', d.name, 'price', d.price, 'quantity', 1)
         || CASE WHEN d.image IS NOT NULL THEN jsonb_build_object('image', d.image) ELSE '{}'::jsonb END,
       4, 2500, 30000, NULL, NULL, 3, 25000, false, true, now()
FROM (SELECT id, name, price, image FROM "Dish" WHERE entity_status <> 'DELETED' AND name ILIKE 'fitini%' ORDER BY price ASC LIMIT 1) d
WHERE NOT EXISTS (SELECT 1 FROM "ScratchLot" WHERE label = 'Fitini offert');

INSERT INTO "ScratchLot" (id, label, reward_type, payload, weight, unit_cost, min_cart, frequency_cap, stock, min_paid_orders, min_revenue, is_floor, active, updated_at)
SELECT gen_random_uuid(), 'Chicken Burger offert', 'GIFT',
       jsonb_build_object('item_type','DISH','dish_id', d.id, 'label', d.name, 'name', d.name, 'price', d.price, 'quantity', 1)
         || CASE WHEN d.image IS NOT NULL THEN jsonb_build_object('image', d.image) ELSE '{}'::jsonb END,
       2, 4000, 30000, NULL, NULL, 3, 25000, false, true, now()
FROM (SELECT id, name, price, image FROM "Dish" WHERE entity_status <> 'DELETED' AND name ILIKE '%chicken%burger%' ORDER BY price ASC LIMIT 1) d
WHERE NOT EXISTS (SELECT 1 FROM "ScratchLot" WHERE label = 'Chicken Burger offert');

-- ============================================================ PALIER 3 (≥ 50 000 F)

INSERT INTO "ScratchLot" (id, label, reward_type, payload, weight, unit_cost, min_cart, frequency_cap, stock, min_paid_orders, min_revenue, is_floor, active, updated_at)
SELECT gen_random_uuid(), 'Bon d''achat 3 000 FCFA', 'VOUCHER', jsonb_build_object('amount', 3000), 3, 3000, 50000, 1, NULL, 0, 0, false, true, now()
WHERE NOT EXISTS (SELECT 1 FROM "ScratchLot" WHERE label = 'Bon d''achat 3 000 FCFA');

INSERT INTO "ScratchLot" (id, label, reward_type, payload, weight, unit_cost, min_cart, frequency_cap, stock, min_paid_orders, min_revenue, is_floor, active, updated_at)
SELECT gen_random_uuid(), 'Soutrali offert', 'GIFT',
       jsonb_build_object('item_type','DISH','dish_id', d.id, 'label', d.name, 'name', d.name, 'price', d.price, 'quantity', 1)
         || CASE WHEN d.image IS NOT NULL THEN jsonb_build_object('image', d.image) ELSE '{}'::jsonb END,
       2, 5000, 50000, 1, NULL, 3, 25000, false, true, now()
FROM (SELECT id, name, price, image FROM "Dish" WHERE entity_status <> 'DELETED' AND name ILIKE 'soutrali%' AND name NOT ILIKE '%max%' ORDER BY price ASC LIMIT 1) d
WHERE NOT EXISTS (SELECT 1 FROM "ScratchLot" WHERE label = 'Soutrali offert');

INSERT INTO "ScratchLot" (id, label, reward_type, payload, weight, unit_cost, min_cart, frequency_cap, stock, min_paid_orders, min_revenue, is_floor, active, updated_at)
SELECT gen_random_uuid(), '8 Ailes Crispy offertes', 'GIFT',
       jsonb_build_object('item_type','DISH','dish_id', d.id, 'label', d.name, 'name', d.name, 'price', d.price, 'quantity', 1)
         || CASE WHEN d.image IS NOT NULL THEN jsonb_build_object('image', d.image) ELSE '{}'::jsonb END,
       2, 5000, 50000, 1, NULL, 3, 25000, false, true, now()
FROM (SELECT id, name, price, image FROM "Dish" WHERE entity_status <> 'DELETED' AND name ILIKE '8%ailes%' ORDER BY price ASC LIMIT 1) d
WHERE NOT EXISTS (SELECT 1 FROM "ScratchLot" WHERE label = '8 Ailes Crispy offertes');

-- ============================================================ PALIER 4 (≥ 80 000 F)

INSERT INTO "ScratchLot" (id, label, reward_type, payload, weight, unit_cost, min_cart, frequency_cap, stock, min_paid_orders, min_revenue, is_floor, active, updated_at)
SELECT gen_random_uuid(), 'Agbôlor offert', 'GIFT',
       jsonb_build_object('item_type','DISH','dish_id', d.id, 'label', d.name, 'name', d.name, 'price', d.price, 'quantity', 1)
         || CASE WHEN d.image IS NOT NULL THEN jsonb_build_object('image', d.image) ELSE '{}'::jsonb END,
       1, 7000, 80000, 1, 20, 3, 25000, false, true, now()
FROM (SELECT id, name, price, image FROM "Dish" WHERE entity_status <> 'DELETED' AND name ILIKE 'agb_lor%' AND name NOT ILIKE '%max%' ORDER BY price ASC LIMIT 1) d
WHERE NOT EXISTS (SELECT 1 FROM "ScratchLot" WHERE label = 'Agbôlor offert');

INSERT INTO "ScratchLot" (id, label, reward_type, payload, weight, unit_cost, min_cart, frequency_cap, stock, min_paid_orders, min_revenue, is_floor, active, updated_at)
SELECT gen_random_uuid(), 'Soutrali Max offert', 'GIFT',
       jsonb_build_object('item_type','DISH','dish_id', d.id, 'label', d.name, 'name', d.name, 'price', d.price, 'quantity', 1)
         || CASE WHEN d.image IS NOT NULL THEN jsonb_build_object('image', d.image) ELSE '{}'::jsonb END,
       1, 7000, 80000, 1, 20, 3, 25000, false, true, now()
FROM (SELECT id, name, price, image FROM "Dish" WHERE entity_status <> 'DELETED' AND name ILIKE 'soutrali%max%' ORDER BY price ASC LIMIT 1) d
WHERE NOT EXISTS (SELECT 1 FROM "ScratchLot" WHERE label = 'Soutrali Max offert');

-- ============================================================ PALIER 5 (≥ 100 000 F)

INSERT INTO "ScratchLot" (id, label, reward_type, payload, weight, unit_cost, min_cart, frequency_cap, stock, min_paid_orders, min_revenue, is_floor, active, updated_at)
SELECT gen_random_uuid(), 'Box du Champion offerte', 'GIFT',
       jsonb_build_object('item_type','DISH','dish_id', d.id, 'label', d.name, 'name', d.name, 'price', d.price, 'quantity', 1)
         || CASE WHEN d.image IS NOT NULL THEN jsonb_build_object('image', d.image) ELSE '{}'::jsonb END,
       1, 8500, 100000, 1, 10, 3, 25000, false, true, now()
FROM (SELECT id, name, price, image FROM "Dish" WHERE entity_status <> 'DELETED' AND name ILIKE '%champion%' ORDER BY price ASC LIMIT 1) d
WHERE NOT EXISTS (SELECT 1 FROM "ScratchLot" WHERE label = 'Box du Champion offerte');

INSERT INTO "ScratchLot" (id, label, reward_type, payload, weight, unit_cost, min_cart, frequency_cap, stock, min_paid_orders, min_revenue, is_floor, active, updated_at)
SELECT gen_random_uuid(), 'Gbonhi familial offert', 'GIFT',
       jsonb_build_object('item_type','DISH','dish_id', d.id, 'label', d.name, 'name', d.name, 'price', d.price, 'quantity', 1)
         || CASE WHEN d.image IS NOT NULL THEN jsonb_build_object('image', d.image) ELSE '{}'::jsonb END,
       1, 12000, 100000, 1, 5, 3, 25000, false, true, now()
FROM (SELECT id, name, price, image FROM "Dish" WHERE entity_status <> 'DELETED' AND name ILIKE 'gbonhi%' ORDER BY price ASC LIMIT 1) d
WHERE NOT EXISTS (SELECT 1 FROM "ScratchLot" WHERE label = 'Gbonhi familial offert');

INSERT INTO "ScratchLot" (id, label, reward_type, payload, weight, unit_cost, min_cart, frequency_cap, stock, min_paid_orders, min_revenue, is_floor, active, updated_at)
SELECT gen_random_uuid(), 'Babatchê offert', 'GIFT',
       jsonb_build_object('item_type','DISH','dish_id', d.id, 'label', d.name, 'name', d.name, 'price', d.price, 'quantity', 1)
         || CASE WHEN d.image IS NOT NULL THEN jsonb_build_object('image', d.image) ELSE '{}'::jsonb END,
       1, 22000, 100000, 1, 2, 3, 25000, false, true, now()
FROM (SELECT id, name, price, image FROM "Dish" WHERE entity_status <> 'DELETED' AND name ILIKE 'babatch_%' ORDER BY price ASC LIMIT 1) d
WHERE NOT EXISTS (SELECT 1 FROM "ScratchLot" WHERE label = 'Babatchê offert');
