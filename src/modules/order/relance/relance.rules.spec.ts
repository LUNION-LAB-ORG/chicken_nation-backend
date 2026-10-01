/**
 * Classement des paniers non payés de l'application : la fonction pure qui
 * décide de la liste, des compteurs, du badge, du bandeau, de la tâche
 * d'alerte et de chaque geste d'agent. Aucune base, aucune horloge.
 */
import { PaiementStatus } from '@prisma/client';
import {
  BrouillonLu,
  CommandeEffectiveLue,
  FENETRE_HEURES,
  RECENTE_MINUTES,
  RELANCE_SETTINGS,
  ReglesRelance,
  RelanceLue,
  classerBrouillons,
  doitAlerter,
  groupeDeLaCommande,
  libelleMotif,
  lireRegles,
  messageSortie,
  motifSortie,
} from './relance.rules';

const MAINTENANT = new Date('2026-10-01T12:00:00.000Z');
const ilYa = (minutes: number) => new Date(MAINTENANT.getTime() - minutes * 60_000);
const dans = (minutes: number) => new Date(MAINTENANT.getTime() + minutes * 60_000);

const REGLES: ReglesRelance = lireRegles({});
const RESTO_A = 'resto-a';
const RESTO_B = 'resto-b';
const AWA = 'agent-awa';
const YAO = 'agent-yao';

let numero = 0;
function brouillon(minutes: number, surcharge: Partial<BrouillonLu> = {}): BrouillonLu {
  numero += 1;
  return {
    id: `b${String(numero).padStart(3, '0')}`,
    reference: `ORD-261001-${numero}`,
    created_at: ilYa(minutes),
    customer_id: 'client-1',
    restaurant_id: RESTO_A,
    fullname: 'Anne Marie Aka',
    phone: '+2250700000001',
    type: 'DELIVERY',
    amount: 5050,
    customer: { phone: '+2250700000001', first_name: 'Anne', last_name: 'Aka' },
    restaurant: { id: RESTO_A, name: 'Riviera' },
    paiements: [],
    relance: null,
    ...surcharge,
  };
}

function relance(surcharge: Partial<RelanceLue> = {}): RelanceLue {
  return {
    alerte_le: null,
    pris_par_id: null,
    pris_par: null,
    pris_le: null,
    prise_expire_le: null,
    ignore_le: null,
    ...surcharge,
  };
}

function effective(minutes: number, surcharge: Partial<CommandeEffectiveLue> = {}): CommandeEffectiveLue {
  numero += 1;
  return {
    id: `e${numero}`,
    reference: `ORD-261001-9${numero}`,
    created_at: ilYa(minutes),
    customer_id: 'client-1',
    phone: '+2250700000001',
    customer: { phone: '+2250700000001' },
    ...surcharge,
  };
}

const classer = (
  brouillons: BrouillonLu[],
  effectives: CommandeEffectiveLue[] = [],
  moi = AWA,
  regles = REGLES,
) => classerBrouillons({ brouillons, effectives, maintenant: MAINTENANT, regles, moi });

describe('classerBrouillons', () => {
  it('1. brouillon de 2 min : en cours de paiement, aucune alerte', () => {
    const b = brouillon(2);
    const { groupes } = classer([b]);
    expect(groupes).toHaveLength(1);
    expect(groupes[0].etat).toBe('EN_COURS');
  });

  it('2. brouillon de 4 min : à relancer', () => {
    const { groupes } = classer([brouillon(4)]);
    expect(groupes[0].etat).toBe('A_RELANCER');
  });

  it('3. brouillon de 4 h : absent (hors fenêtre)', () => {
    const { groupes, exclus } = classer([brouillon(4 * 60)]);
    expect(groupes).toEqual([]);
    expect(exclus.size).toBe(0);
  });

  it('4. paiement réussi qui couvre le panier : exclu, paiement à confirmer', () => {
    const b = brouillon(5, {
      paiements: [{ status: PaiementStatus.SUCCESS, amount: 5000, total: 5000, created_at: ilYa(4) }],
    });
    const { groupes, exclus } = classer([b]);
    expect(groupes).toEqual([]);
    // 5 000 F reçus sur 5 050 F : dans la tolérance d'arrondi de 50 F.
    expect(exclus.get(b.id)).toEqual({ motif: 'PAIEMENT_A_CONFIRMER' });
  });

  it('4 bis. paiement partiel : reste à relancer, avec le signal du montant reçu', () => {
    const b = brouillon(10, {
      paiements: [{ status: PaiementStatus.SUCCESS, amount: 2000, total: 2000, created_at: ilYa(9) }],
    });
    const { groupes, exclus } = classer([b]);
    expect(exclus.size).toBe(0);
    expect(groupes[0].etat).toBe('A_RELANCER');
    expect(groupes[0].signaux.paiement_partiel).toEqual({ reference: b.reference, recu: 2000, montant: 5050 });
  });

  it('5. commande payée ensuite par le même compte : exclu, a recommandé', () => {
    const b = brouillon(10);
    const e = effective(2, { phone: null, customer: null });
    const { groupes, exclus } = classer([b], [e]);
    expect(groupes).toEqual([]);
    expect(exclus.get(b.id)).toEqual({ motif: 'RECOMMANDE', reference: e.reference });
  });

  it('6. même cas depuis un autre compte du même numéro (« 225… » et « +225… »)', () => {
    const b = brouillon(10, { phone: '+2250700000001' });
    const e = effective(2, { customer_id: 'autre-compte', phone: '2250700000001', customer: { phone: null } });
    const { exclus } = classer([b], [e]);
    expect(exclus.get(b.id)?.motif).toBe('RECOMMANDE');
  });

  it('7. recommande annulée ensuite : le panier reste à relancer', () => {
    const b = brouillon(10);
    const { groupes, exclus } = classer([b], [effective(2, { status: 'CANCELLED' })]);
    expect(exclus.size).toBe(0);
    expect(groupes[0].etat).toBe('A_RELANCER');
  });

  it('7 bis. une commande payée AVANT le panier ne l’exclut pas', () => {
    const { groupes } = classer([brouillon(10)], [effective(60)]);
    expect(groupes[0].etat).toBe('A_RELANCER');
  });

  it('8. deux paniers du même client (4 et 6 min) : un seul groupe, tête = le plus récent', () => {
    const recent = brouillon(4);
    const ancien = brouillon(6);
    const { groupes } = classer([ancien, recent]);
    expect(groupes).toHaveLength(1);
    expect(groupes[0].tete.id).toBe(recent.id);
    expect(groupes[0].autres.map((b) => b.id)).toEqual([ancien.id]);
    expect(groupes[0].ids).toEqual([recent.id, ancien.id].sort());
  });

  it('8 bis. même client, deux comptes, même numéro : un seul groupe', () => {
    const a = brouillon(6, { customer_id: 'compte-1', phone: '2250700000001' });
    const b = brouillon(4, { customer_id: 'compte-2', phone: '+225 07 00 00 00 01' });
    expect(classer([a, b]).groupes).toHaveLength(1);
  });

  it('8 ter. même client dans deux restaurants : deux groupes', () => {
    const a = brouillon(6, { restaurant_id: RESTO_A });
    const b = brouillon(5, { restaurant_id: RESTO_B, restaurant: { id: RESTO_B, name: 'Cocody' } });
    expect(classer([a, b]).groupes).toHaveLength(2);
  });

  it('9. deux paniers (9 min et 1 min) : le client réessaie, groupe en cours', () => {
    const { groupes } = classer([brouillon(9), brouillon(1)]);
    expect(groupes).toHaveLength(1);
    expect(groupes[0].etat).toBe('EN_COURS');
  });

  it('9 bis. paiement tenté il y a 1 min sur un vieux panier : en cours', () => {
    const b = brouillon(20, {
      paiements: [{ status: PaiementStatus.FAILED, amount: 5050, total: 5050, created_at: ilYa(1) }],
    });
    const { groupes, prochaineEcheance } = classer([b]);
    expect(groupes[0].etat).toBe('EN_COURS');
    expect(prochaineEcheance).toEqual(dans(REGLES.delai_minutes - 1));
  });

  it('10. prise valable : pris ; prise expirée : à relancer ; par_moi juste', () => {
    const pris = brouillon(8, {
      relance: relance({ pris_par_id: AWA, pris_par: { id: AWA, fullname: 'Agent Awa' }, pris_le: ilYa(2), prise_expire_le: dans(8) }),
    });
    const pourAwa = classer([pris], [], AWA).groupes[0];
    const pourYao = classer([pris], [], YAO).groupes[0];
    expect(pourAwa.etat).toBe('PRIS');
    expect(pourAwa.prise).toEqual(expect.objectContaining({ par_id: AWA, par_nom: 'Agent Awa', par_moi: true }));
    expect(pourYao.prise?.par_moi).toBe(false);

    const expire = brouillon(20, {
      customer_id: 'client-2',
      phone: '0711111111',
      relance: relance({ pris_par_id: AWA, pris_le: ilYa(15), prise_expire_le: ilYa(5) }),
    });
    const groupe = classer([expire]).groupes[0];
    expect(groupe.etat).toBe('A_RELANCER');
    expect(groupe.prise).toBeNull();
  });

  it('10 bis. un panier apparu après la prise reste dans le groupe pris', () => {
    const ancien = brouillon(8, { relance: relance({ pris_par_id: AWA, prise_expire_le: dans(8) }) });
    const nouveau = brouillon(1);
    const { groupes } = classer([ancien, nouveau]);
    expect(groupes).toHaveLength(1);
    expect(groupes[0].etat).toBe('PRIS');
    expect(groupes[0].tete.id).toBe(nouveau.id);
  });

  it('11. un panier ignoré et un plus récent non ignoré : à relancer sur le récent ; tous ignorés : absent', () => {
    const ignore = brouillon(9, { relance: relance({ ignore_le: ilYa(5) }) });
    const recent = brouillon(5);
    const { groupes } = classer([ignore, recent]);
    expect(groupes).toHaveLength(1);
    expect(groupes[0].tete.id).toBe(recent.id);
    expect(groupes[0].etat).toBe('A_RELANCER');
    expect(groupes[0].ignores).toEqual([ignore.id]);

    const seul = classer([ignore]);
    expect(seul.groupes).toEqual([]);
    expect(seul.groupesIgnores).toEqual([{ cle: ignore.id, restaurant_id: RESTO_A, ignores: [ignore.id] }]);
    expect(groupeDeLaCommande(seul, ignore.id)).toEqual({ ignore: seul.groupesIgnores[0] });
  });

  it('12. commande payée 6 min avant le panier : signal commande récente', () => {
    const b = brouillon(5);
    const e = effective(11);
    const { groupes } = classer([b], [e]);
    expect(groupes[0].signaux.commande_recente).toEqual({ reference: e.reference, created_at: e.created_at });
    // Au delà de la fenêtre « récente » : aucun signal.
    expect(classer([b], [effective(5 + RECENTE_MINUTES + 1)]).groupes[0].signaux.commande_recente).toBeNull();
  });

  it('13. paiement refusé : signal', () => {
    const b = brouillon(5, {
      paiements: [{ status: PaiementStatus.FAILED, amount: 5050, total: 5050, created_at: ilYa(4) }],
    });
    expect(classer([b]).groupes[0].signaux.paiement_refuse).toBe(true);
    expect(classer([brouillon(5, { customer_id: 'x', phone: '0799999999' })]).groupes[0].signaux.paiement_refuse).toBe(false);
  });

  it('14. prochaine échéance : la plus proche des passages au délai et des fins de prise', () => {
    const enCours = brouillon(1, { customer_id: 'c-1', phone: '0700000011' }); // à relancer dans 2 min
    const pris = brouillon(9, {
      customer_id: 'c-2',
      phone: '0700000022',
      relance: relance({ pris_par_id: YAO, prise_expire_le: dans(1) }),
    });
    const aRelancer = brouillon(30, { customer_id: 'c-3', phone: '0700000033' });
    expect(classer([enCours, pris, aRelancer]).prochaineEcheance).toEqual(dans(1));
    expect(classer([enCours, aRelancer]).prochaineEcheance).toEqual(dans(2));
    expect(classer([aRelancer]).prochaineEcheance).toBeNull();
  });

  it("ordre de l'écran : mes prises, à relancer (plus ancien d'abord), prises des collègues, en cours", () => {
    const enCours = brouillon(1, { customer_id: 'c-1', phone: '0700000011' });
    const priseYao = brouillon(20, { customer_id: 'c-2', phone: '0700000022', relance: relance({ pris_par_id: YAO, prise_expire_le: dans(5) }) });
    const recent = brouillon(5, { customer_id: 'c-3', phone: '0700000033' });
    const ancien = brouillon(40, { customer_id: 'c-4', phone: '0700000044' });
    const priseAwa = brouillon(15, { customer_id: 'c-5', phone: '0700000055', relance: relance({ pris_par_id: AWA, prise_expire_le: dans(5) }) });
    const ordre = classer([enCours, priseYao, recent, ancien, priseAwa]).groupes.map((g) => g.cle);
    expect(ordre).toEqual([priseAwa.id, ancien.id, recent.id, priseYao.id, enCours.id]);
  });
});

describe('classerBrouillons : paniers annulés par le client (01/10)', () => {
  /** Panier que le client a annulé dans l'application, `annule` minutes avant maintenant. */
  const annule = (minutes: number, annuleIlYa: number, surcharge: Partial<BrouillonLu> = {}) =>
    brouillon(minutes, {
      auto: true,
      status: 'CANCELLED',
      paied: false,
      payment_method: 'ONLINE',
      entity_status: 'DELETED',
      cancelled_by: 'client',
      cancelled_at: ilYa(annuleIlYa),
      ...surcharge,
    });

  it('inclus comme un panier en attente : à relancer passé le délai, avec la date d’annulation', () => {
    const b = annule(6, 2);
    const { groupes, exclus } = classer([b]);
    expect(exclus.size).toBe(0);
    expect(groupes).toHaveLength(1);
    expect(groupes[0].etat).toBe('A_RELANCER');
    expect(groupes[0].tete.id).toBe(b.id);
    expect(groupes[0].signaux.annulee_par_client).toEqual({ le: ilYa(2) });
  });

  it('même délai : annulé 1 min après sa création, il reste en cours jusqu’au délai', () => {
    const { groupes } = classer([annule(2, 1)]);
    expect(groupes[0].etat).toBe('EN_COURS');
    expect(groupes[0].echeance).toEqual(dans(REGLES.delai_minutes - 2));
  });

  it('même fenêtre : au delà de 3 h, absent', () => {
    expect(classer([annule(FENETRE_HEURES * 60 + 1, 30)]).groupes).toEqual([]);
  });

  it('regroupé avec les autres paniers du client : tête = le plus récent, signal = l’annulation la plus récente', () => {
    const premier = annule(40, 35);
    const second = annule(20, 15);
    const enAttente = brouillon(8);
    const { groupes } = classer([premier, second, enAttente]);
    expect(groupes).toHaveLength(1);
    expect(groupes[0].tete.id).toBe(enAttente.id);
    expect(groupes[0].ids).toEqual([premier.id, second.id, enAttente.id].sort());
    expect(groupes[0].signaux.annulee_par_client).toEqual({ le: ilYa(15) });
  });

  it('tête annulée : sa date, même si un panier plus ancien a été annulé après', () => {
    const ancien = annule(30, 1);
    const tete = annule(10, 5);
    expect(classer([ancien, tete]).groupes[0].signaux.annulee_par_client).toEqual({ le: ilYa(5) });
  });

  it('exclu si le client a payé une commande ensuite : a recommandé', () => {
    const b = annule(20, 18);
    const e = effective(5);
    const { groupes, exclus } = classer([b], [e]);
    expect(groupes).toEqual([]);
    expect(exclus.get(b.id)).toEqual({ motif: 'RECOMMANDE', reference: e.reference });
  });

  it('exclu si un paiement réussi le couvre : paiement à confirmer', () => {
    const b = annule(20, 18, {
      paiements: [{ status: PaiementStatus.SUCCESS, amount: 5050, total: 5050, created_at: ilYa(19) }],
    });
    expect(classer([b]).exclus.get(b.id)).toEqual({ motif: 'PAIEMENT_A_CONFIRMER' });
  });

  it('ignoré : hors alertes, comme les autres ; pris : pris', () => {
    const ignore = annule(20, 18, { relance: relance({ ignore_le: ilYa(1) }) });
    expect(classer([ignore]).groupes).toEqual([]);
    const pris = annule(20, 18, { relance: relance({ pris_par_id: YAO, prise_expire_le: dans(5), pris_le: ilYa(1) }) });
    expect(classer([pris]).groupes[0].etat).toBe('PRIS');
  });

  it('un panier en attente seul ne porte pas le signal', () => {
    expect(classer([brouillon(10)]).groupes[0].signaux.annulee_par_client).toBeNull();
  });
});

describe('réglages', () => {
  it('15. hors bornes ou illisibles : défauts', () => {
    expect(lireRegles({})).toEqual({
      delai_minutes: 3,
      duree_prise_minutes: 10,
      rappel_minutes: 5,
      fenetre_heures: FENETRE_HEURES,
      recente_minutes: RECENTE_MINUTES,
    });
    expect(
      lireRegles({
        [RELANCE_SETTINGS.DELAI_MINUTES]: '0',
        [RELANCE_SETTINGS.DUREE_PRISE_MINUTES]: 'dix',
        [RELANCE_SETTINGS.RAPPEL_MINUTES]: '61',
      }),
    ).toEqual(lireRegles({}));
    expect(lireRegles({ [RELANCE_SETTINGS.DELAI_MINUTES]: '2.5' }).delai_minutes).toBe(3);
    expect(lireRegles({ [RELANCE_SETTINGS.RAPPEL_MINUTES]: '' }).rappel_minutes).toBe(5);
  });

  it('valeurs dans les bornes : retenues, 0 coupe le rappel', () => {
    const r = lireRegles({
      [RELANCE_SETTINGS.DELAI_MINUTES]: ' 5 ',
      [RELANCE_SETTINGS.DUREE_PRISE_MINUTES]: '15',
      [RELANCE_SETTINGS.RAPPEL_MINUTES]: '0',
    });
    expect(r).toEqual(expect.objectContaining({ delai_minutes: 5, duree_prise_minutes: 15, rappel_minutes: 0 }));
  });

  it('le délai réglé décide du passage en relance', () => {
    const regles = lireRegles({ [RELANCE_SETTINGS.DELAI_MINUTES]: '10' });
    expect(classer([brouillon(6)], [], AWA, regles).groupes[0].etat).toBe('EN_COURS');
  });
});

describe("doitAlerter (tâche d'alerte)", () => {
  it('jamais alertée : oui', () => {
    expect(doitAlerter(null, MAINTENANT)).toBe(true);
    expect(doitAlerter(relance(), MAINTENANT)).toBe(true);
  });

  it('déjà alertée, sans prise : non (rétablir ne fait pas sonner de nouveau)', () => {
    expect(doitAlerter(relance({ alerte_le: ilYa(10) }), MAINTENANT)).toBe(false);
  });

  it('prise expirée après la dernière alerte : oui, une fois', () => {
    const lu = relance({ alerte_le: ilYa(20), pris_par_id: AWA, prise_expire_le: ilYa(1) });
    expect(doitAlerter(lu, MAINTENANT)).toBe(true);
    // Réalertée depuis : plus rien tant qu'une nouvelle prise n'expire pas.
    expect(doitAlerter({ ...lu, alerte_le: ilYa(0.5) }, MAINTENANT)).toBe(false);
  });

  it('prise encore valable : non', () => {
    expect(doitAlerter(relance({ alerte_le: ilYa(20), prise_expire_le: dans(1) }), MAINTENANT)).toBe(false);
  });
});

describe('motifs de sortie et messages', () => {
  it('motif lu sur la commande, dans l’ordre de la conception', () => {
    expect(motifSortie({ auto: false, status: 'ACCEPTED', paied: false })).toBe('REPRISE');
    expect(motifSortie({ auto: true, status: 'PENDING', paied: true })).toBe('PAYEE');
    // Acceptée par le personnel sans paiement : jamais « a payé ».
    expect(motifSortie({ auto: true, status: 'ACCEPTED', paied: false })).toBe('CONFIRMEE');
    expect(motifSortie({ auto: true, status: 'ACCEPTED', paied: true })).toBe('PAYEE');
    expect(motifSortie({ auto: true, status: 'CANCELLED', paied: false })).toBe('ANNULEE');
    expect(motifSortie({ auto: true, status: 'PENDING', paied: false, entity_status: 'DELETED' })).toBe('SUPPRIMEE');
    expect(motifSortie({ auto: true, status: 'PENDING', paied: false })).toBeNull();
  });

  it('messages 409 : textes exacts, durées tirées des réglages', () => {
    expect(messageSortie('PAYEE')).toBe("Cette commande n'est plus à relancer : a payé dans l'application.");
    expect(messageSortie('CONFIRMEE')).toBe("Cette commande n'est plus à relancer : confirmée par l'équipe.");
    expect(messageSortie('REPRISE', { auteur: 'Agent Awa' })).toBe(
      "Cette commande n'est plus à relancer : reprise au téléphone par Agent Awa.",
    );
    expect(messageSortie('RECOMMANDE', { reference: 'ORD-261001-42390' })).toBe(
      "Cette commande n'est plus à relancer : a recommandé (ORD-261001-42390).",
    );
    expect(messageSortie('PAIEMENT_A_CONFIRMER')).toBe(
      "Cette commande n'est plus à relancer : paiement reçu, confirmation en cours.",
    );
    expect(messageSortie('HORS_FENETRE', { fenetre_heures: 3 })).toBe(
      "Cette commande a plus de 3 h : elle n'est plus suivie ici.",
    );
    expect(libelleMotif('HORS_FENETRE', { fenetre_heures: 5 })).toBe('Plus de 5 h : suivi par le CRM');
  });

  it('aucun tiret long ni « N/A » dans les textes produits', () => {
    const textes = [
      ...(['REPRISE', 'PAYEE', 'CONFIRMEE', 'ANNULEE', 'SUPPRIMEE', 'PAIEMENT_A_CONFIRMER', 'RECOMMANDE', 'HORS_FENETRE'] as const).flatMap(
        (m) => [libelleMotif(m, { reference: 'ORD-1', auteur: 'Awa' }), messageSortie(m, { reference: 'ORD-1' })],
      ),
      messageSortie(null),
    ];
    for (const texte of textes) {
      expect(texte).not.toMatch(/[–—]/);
      expect(texte).not.toMatch(/N\/A/);
    }
  });
});
