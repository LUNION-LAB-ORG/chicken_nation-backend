/**
 * PAIEMENT À LA LIVRAISON SUR LE SITE (19/10) : la règle « commande à
 * confirmer », ses trois écritures (mémoire, Prisma, SQL) et le réglage.
 *
 * Le piège NULL est vérifié ici avec un évaluateur à TROIS valeurs, qui lit
 * un `where` Prisma comme le ferait Postgres : une comparaison à NULL ne vaut
 * ni vrai ni faux, et la ligne sort du filtre. Le moteur en mémoire de la
 * relance (`correspond`) raisonne, lui, à deux valeurs : il sert à vérifier
 * l'équivalence des règles, pas ce piège. La vérification sur une vraie base
 * reste à faire à la recette (R12).
 */
import { EntityStatus, OrderChannel, OrderStatus, PaymentMethod, Prisma } from '@prisma/client';
import { COMMANDE_EFFECTIVE_SQL, commandeEffective } from 'src/modules/crm/crm.rules';
import { BROUILLON_WHERE, estBrouillon } from './brouillons.rules';
import {
  A_CONFIRMER_SQL,
  A_CONFIRMER_WHERE,
  estAConfirmer,
  PAS_A_CONFIRMER_WHERE,
  paiementLivraisonActif,
  REFUS_PAIEMENT_SITE,
  REGLAGE_PAIEMENT_LIVRAISON_SITE,
} from './paiement-livraison.rules';
import { correspond } from '../relance/relance.base-simulee-spec';

type Ligne = Record<string, unknown>;
type Verite = boolean | null;

/**
 * Un `where` Prisma évalué avec la logique de SQL : `true`, `false` ou
 * `null` (inconnu). Une ligne n'est retenue que si le résultat vaut `true`.
 * `{ champ: { not: v } }` est lu comme `champ <> v` : le cas le plus strict
 * pour une colonne vide.
 */
function sql3(ligne: Ligne, where: Prisma.OrderWhereInput): Verite {
  const et = (valeurs: Verite[]): Verite =>
    valeurs.includes(false) ? false : valeurs.includes(null) ? null : true;
  const ou = (valeurs: Verite[]): Verite =>
    valeurs.includes(true) ? true : valeurs.includes(null) ? null : false;
  const non = (v: Verite): Verite => (v === null ? null : !v);

  const resultats: Verite[] = [];
  for (const [cle, condition] of Object.entries(where as Ligne)) {
    if (condition === undefined) continue;
    if (cle === 'AND') {
      const liste = (Array.isArray(condition) ? condition : [condition]) as Prisma.OrderWhereInput[];
      resultats.push(et(liste.map((c) => sql3(ligne, c))));
      continue;
    }
    if (cle === 'OR') {
      resultats.push(ou((condition as Prisma.OrderWhereInput[]).map((c) => sql3(ligne, c))));
      continue;
    }
    if (cle === 'NOT') {
      const liste = (Array.isArray(condition) ? condition : [condition]) as Prisma.OrderWhereInput[];
      resultats.push(et(liste.map((c) => non(sql3(ligne, c)))));
      continue;
    }
    const valeur = ligne[cle] ?? null;
    if (condition === null) {
      resultats.push(valeur === null);
      continue;
    }
    if (typeof condition === 'object' && 'not' in (condition as Ligne)) {
      const interdit = (condition as Ligne).not;
      resultats.push(interdit === null ? valeur !== null : valeur === null ? null : valeur !== interdit);
      continue;
    }
    resultats.push(valeur === null ? null : valeur === condition);
  }
  return et(resultats);
}

const retenue = (ligne: Ligne, where: Prisma.OrderWhereInput) => sql3(ligne, where) === true;

const CANAUX = [null, ...Object.values(OrderChannel)];
const MOYENS = [null, ...Object.values(PaymentMethod)];

/** Toutes les combinaisons des six champs de la règle, canal et moyen vides compris. */
function* combinaisons(): Generator<Ligne> {
  for (const auto of [true, false])
    for (const status of Object.values(OrderStatus))
      for (const paied of [true, false])
        for (const payment_method of MOYENS)
          for (const entity_status of Object.values(EntityStatus))
            for (const channel of CANAUX) yield { auto, status, paied, payment_method, entity_status, channel };
}

/** Commande du site à payer à la livraison, juste créée. */
const aConfirmer = (surcharge: Ligne = {}): Ligne => ({
  auto: true,
  channel: OrderChannel.WEB,
  payment_method: PaymentMethod.OFFLINE,
  paied: false,
  status: OrderStatus.PENDING,
  entity_status: EntityStatus.ACTIVE,
  ...surcharge,
});

describe('estAConfirmer et A_CONFIRMER_WHERE', () => {
  it('même verdict sur toutes les combinaisons (canal et moyen de paiement vides compris)', () => {
    let nombre = 0;
    for (const commande of combinaisons()) {
      const attendu = correspond(commande, A_CONFIRMER_WHERE as Ligne);
      expect({ commande, verdict: estAConfirmer(commande) }).toEqual({ commande, verdict: attendu });
      // Avec la logique de SQL aussi : la règle positive ne dépend d'aucune colonne vide.
      expect({ commande, verdict: retenue(commande, A_CONFIRMER_WHERE) }).toEqual({ commande, verdict: attendu });
      if (attendu) nombre += 1;
    }
    // Un seul cas : site, à la livraison, auto, en attente, non payée, non supprimée (ACTIVE ou INACTIVE).
    expect(nombre).toBe(Object.values(EntityStatus).length - 1);
  });

  it('le canal APP, le centre d’appels, la caisse et un canal vide ne sont jamais à confirmer', () => {
    for (const channel of [OrderChannel.APP, OrderChannel.CALL_CENTER, OrderChannel.RESTAURANT, null, undefined]) {
      expect(estAConfirmer(aConfirmer({ channel }))).toBe(false);
    }
    expect(estAConfirmer(aConfirmer())).toBe(true);
    expect(estAConfirmer(aConfirmer({ auto: false }))).toBe(false);
    expect(estAConfirmer(aConfirmer({ status: OrderStatus.ACCEPTED }))).toBe(false);
    expect(estAConfirmer(aConfirmer({ paied: true }))).toBe(false);
    expect(estAConfirmer(aConfirmer({ payment_method: PaymentMethod.ONLINE }))).toBe(false);
    expect(estAConfirmer(aConfirmer({ entity_status: EntityStatus.DELETED }))).toBe(false);
    expect(estAConfirmer(null)).toBe(false);
    expect(estAConfirmer(undefined)).toBe(false);
  });
});

describe('PAS_A_CONFIRMER_WHERE', () => {
  it('complément exact de la règle (hors entity_status), en mémoire', () => {
    for (const commande of combinaisons()) {
      const active = { ...commande, entity_status: EntityStatus.ACTIVE };
      expect({ commande, verdict: correspond(commande, PAS_A_CONFIRMER_WHERE as Ligne) }).toEqual({
        commande,
        verdict: !estAConfirmer(active),
      });
    }
  });

  it('complément exact AVEC LA LOGIQUE DE SQL : jamais inconnu, même sans canal ni moyen de paiement', () => {
    for (const commande of combinaisons()) {
      const active = { ...commande, entity_status: EntityStatus.ACTIVE };
      expect({ commande, verdict: sql3(commande, PAS_A_CONFIRMER_WHERE) }).toEqual({
        commande,
        verdict: !estAConfirmer(active),
      });
    }
  });

  it('le piège : un NOT de la règle ferait sortir une commande sans canal, la forme positive la garde', () => {
    const ancienneEnEspeces = aConfirmer({ channel: null });
    expect(sql3(ancienneEnEspeces, { NOT: A_CONFIRMER_WHERE })).toBeNull();
    expect(sql3(ancienneEnEspeces, PAS_A_CONFIRMER_WHERE)).toBe(true);
  });
});

describe('commandeEffective et BROUILLON_WHERE avec la logique de SQL', () => {
  it('une commande à confirmer n’est pas effective : c’est un brouillon', () => {
    const c = aConfirmer();
    expect(retenue(c, commandeEffective())).toBe(false);
    expect(retenue(c, BROUILLON_WHERE)).toBe(true);
    expect(estBrouillon(c)).toBe(true);
  });

  it('une commande en espèces de l’application, ou sans canal (avant le 02/10, HubRise), reste effective', () => {
    for (const channel of [OrderChannel.APP, null]) {
      const c = aConfirmer({ channel });
      expect({ channel, effective: retenue(c, commandeEffective()) }).toEqual({ channel, effective: true });
      expect({ channel, brouillon: retenue(c, BROUILLON_WHERE) }).toEqual({ channel, brouillon: false });
      expect(estBrouillon(c)).toBe(false);
    }
  });

  it('confirmée par le centre d’appels (manuelle, acceptée) : effective', () => {
    const c = aConfirmer({ auto: false, status: OrderStatus.ACCEPTED });
    expect(retenue(c, commandeEffective())).toBe(true);
    expect(retenue(c, BROUILLON_WHERE)).toBe(false);
  });

  it('estBrouillon dit ce que retient BROUILLON_WHERE en base, sur toutes les combinaisons', () => {
    for (const commande of combinaisons()) {
      expect({ commande, verdict: estBrouillon(commande) }).toEqual({
        commande,
        verdict: retenue(commande, BROUILLON_WHERE),
      });
    }
  });

  it('une commande retenue en base est soit effective, soit brouillon, jamais les deux', () => {
    for (const commande of combinaisons()) {
      if (commande.auto !== true) continue;
      const effective = retenue(commande, commandeEffective());
      const brouillon = retenue(commande, BROUILLON_WHERE);
      expect({ commande, deux: effective && brouillon }).toEqual({ commande, deux: false });
      // Hors moyen de paiement vide (règle d'avant, inchangée), aucune ne se perd.
      if (commande.payment_method !== null && commande.entity_status !== EntityStatus.DELETED) {
        expect({ commande, une: effective || brouillon }).toEqual({ commande, une: true });
      }
    }
  });
});

describe('A_CONFIRMER_SQL', () => {
  const sql = A_CONFIRMER_SQL('o').replace(/\s+/g, ' ');

  it('compare canal et moyen de paiement sans jamais valoir NULL', () => {
    expect(sql).toBe(
      `(o."auto" IS TRUE AND o."channel" IS NOT DISTINCT FROM 'WEB' AND o."payment_method" IS NOT DISTINCT FROM 'OFFLINE' AND o."paied" = false AND o."status" = 'PENDING')`,
    );
  });

  it('refuse un alias qui n’est pas un simple nom', () => {
    expect(() => A_CONFIRMER_SQL('o; DROP TABLE "Order"')).toThrow();
    expect(() => A_CONFIRMER_SQL('o."x"')).toThrow();
    expect(() => A_CONFIRMER_SQL('')).toThrow();
    expect(() => A_CONFIRMER_SQL('commande_2')).not.toThrow();
  });

  it('COMMANDE_EFFECTIVE_SQL écarte les commandes à confirmer', () => {
    expect(COMMANDE_EFFECTIVE_SQL.replace(/\s+/g, ' ')).toContain(`AND NOT ${sql}`);
  });
});

describe('paiementLivraisonActif (réglage order_paiement_livraison_site)', () => {
  it('clé du réglage', () => {
    expect(REGLAGE_PAIEMENT_LIVRAISON_SITE).toBe('order_paiement_livraison_site');
  });

  it('absent ou vide : proposé (décision du 19/10, l’option marche dès le déploiement)', () => {
    expect(paiementLivraisonActif(undefined)).toBe(true);
    expect(paiementLivraisonActif(null)).toBe(true);
    expect(paiementLivraisonActif('')).toBe(true);
    expect(paiementLivraisonActif('  ')).toBe(true);
  });

  it('« 1 », « true », « oui » : proposé', () => {
    for (const v of ['1', 'true', 'oui', ' OUI ', 'True']) expect({ v, actif: paiementLivraisonActif(v) }).toEqual({ v, actif: true });
  });

  it('« 0 », et toute valeur illisible : coupé', () => {
    for (const v of ['0', 'non', 'false', 'off', '2', 'désactivé']) {
      expect({ v, actif: paiementLivraisonActif(v) }).toEqual({ v, actif: false });
    }
  });
});

describe('textes des refus', () => {
  const textes = [
    REFUS_PAIEMENT_SITE.moyenAbsent,
    REFUS_PAIEMENT_SITE.indisponible,
    REFUS_PAIEMENT_SITE.livraisonSeulement,
    REFUS_PAIEMENT_SITE.dejaEnAttente('ORD-261019-12345'),
  ];

  it('ceux de la conception, espaces insécables comprises', () => {
    const lisible = (t: string) => t.replace(/\u00a0/g, ' ');
    expect(textes.map(lisible)).toEqual([
      'Choisissez un moyen de paiement.',
      'Le paiement à la livraison est indisponible pour le moment : payez en ligne.',
      "Sur le site, le paiement à la livraison n'est proposé que pour une livraison.",
      'Vous avez déjà une commande en attente de confirmation (ORD-261019-12345) : notre équipe vous appelle. ' +
        'Pour la changer, ouvrez-la puis « Modifier ma commande ».',
    ]);
  });

  it('aucun tiret cadratin ni demi-cadratin, jamais une espace ordinaire avant un deux-points', () => {
    for (const t of textes) {
      expect(t).not.toMatch(/[\u2013\u2014]/);
      expect(t).not.toMatch(/ [:;?!]/);
    }
  });
});
