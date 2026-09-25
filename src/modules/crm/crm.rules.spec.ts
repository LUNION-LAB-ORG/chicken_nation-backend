import { CrmCallOutcome as O, CrmSegment as P, CrmStatus as S } from '@prisma/client';
import {
  commandeEffective,
  chiffresTelephone,
  cleTelephone,
  compter,
  dateCourte,
  identiteContact,
  joursRestants,
  NOUVEAU_CYCLE,
  NOUVEAU_CYCLE_SQL,
  genererCodeCoupon,
  prenomPourMessage,
  publicALaCapture,
  remplirModele,
  statutApresAppel,
  statutSansConversion,
  versE164,
  BRUT_DEVENIR_VIDE,
  COMMANDE_VALIDE_SQL,
  COUPON_UTILISE_SQL,
  VENTE_VALIDE_SQL,
  arrondiOuNul,
  bornesMois,
  bornesPeriode,
  bornesTendance,
  calculerDevenir,
  classerGroupes,
  etapesEntonnoir,
  fenetreComplete,
  libelleLigne,
  libellesEntonnoir,
  pareto,
  porteePublics,
  pourcentage,
  publicsDe,
  raisonRetenue,
} from './crm.rules';
import { dansPeriode, filtreCampagne, filtreSegments, plage } from './services/crm-passages.query';

const ctx = (partiel: Partial<{ dejaJoint: boolean; tentatives: number; maxTentatives: number }> = {}) => ({
  dejaJoint: false,
  tentatives: 1,
  maxTentatives: 5,
  ...partiel,
});

describe('statutApresAppel', () => {
  it('un « pas de réponse » laisse le contact à appeler', () => {
    expect(statutApresAppel(S.A_APPELER, O.NON_JOINT, ctx())).toBe(S.A_APPELER);
  });

  it('trop de tentatives sur un numéro jamais joint : injoignable', () => {
    expect(statutApresAppel(S.A_APPELER, O.NON_JOINT, ctx({ tentatives: 5 }))).toBe(S.INJOIGNABLE);
  });

  it("un client déjà joint une fois n'est jamais déclaré injoignable pour des non-réponses", () => {
    expect(statutApresAppel(S.A_APPELER, O.NON_JOINT, ctx({ tentatives: 9, dejaJoint: true }))).toBe(S.A_APPELER);
    expect(statutApresAppel(S.A_RAPPELER, O.NON_JOINT, ctx({ tentatives: 9 }))).toBe(S.A_RAPPELER);
  });

  it('intéressé, à rappeler, pas intéressé, numéro invalide', () => {
    expect(statutApresAppel(S.A_APPELER, O.INTERESSE, ctx())).toBe(S.INTERESSE);
    expect(statutApresAppel(S.A_APPELER, O.A_RAPPELER, ctx())).toBe(S.A_RAPPELER);
    expect(statutApresAppel(S.INTERESSE, O.NON_INTERESSE, ctx())).toBe(S.NON_INTERESSE);
    expect(statutApresAppel(S.A_APPELER, O.NUMERO_INVALIDE, ctx())).toBe(S.INJOIGNABLE);
  });

  it('un coupon envoyé ne recule pas, sauf refus clair', () => {
    expect(statutApresAppel(S.COUPON_ENVOYE, O.NON_JOINT, ctx())).toBe(S.COUPON_ENVOYE);
    expect(statutApresAppel(S.COUPON_ENVOYE, O.INTERESSE, ctx())).toBe(S.COUPON_ENVOYE);
    expect(statutApresAppel(S.COUPON_ENVOYE, O.A_RAPPELER, ctx())).toBe(S.COUPON_ENVOYE);
    expect(statutApresAppel(S.COUPON_ENVOYE, O.NON_INTERESSE, ctx())).toBe(S.NON_INTERESSE);
  });

  it('un client qui avait refusé peut redevenir intéressé', () => {
    expect(statutApresAppel(S.NON_INTERESSE, O.INTERESSE, ctx())).toBe(S.INTERESSE);
  });
});

describe('raisonRetenue (raison de non-commande)', () => {
  const RAISON = 'raison-trop-cher';

  it("gardée quand le client n'est pas intéressé ou demande à être rappelé", () => {
    expect(raisonRetenue(O.NON_INTERESSE, RAISON)).toBe(RAISON);
    expect(raisonRetenue(O.A_RAPPELER, RAISON)).toBe(RAISON);
  });

  it('ignorée pour un client intéressé, même choisie avant de changer de statut', () => {
    expect(raisonRetenue(O.INTERESSE, RAISON)).toBeUndefined();
  });

  it("ignorée quand le client n'a pas été joint", () => {
    expect(raisonRetenue(O.NON_JOINT, RAISON)).toBeUndefined();
    expect(raisonRetenue(O.NUMERO_INVALIDE, RAISON)).toBeUndefined();
  });

  it('aucune raison choisie : rien', () => {
    expect(raisonRetenue(O.NON_INTERESSE, undefined)).toBeUndefined();
    expect(raisonRetenue(O.NON_INTERESSE, '')).toBeUndefined();
    expect(raisonRetenue(O.A_RAPPELER, null)).toBeUndefined();
  });
});

describe('statutSansConversion', () => {
  it('coupon encore actif : il reste « coupon envoyé »', () => {
    expect(statutSansConversion({ coupon_actif: true, last_call_outcome: O.NON_JOINT })).toBe(S.COUPON_ENVOYE);
  });

  it('sinon, repart du dernier appel', () => {
    expect(statutSansConversion({ coupon_actif: false, last_call_outcome: null })).toBe(S.A_APPELER);
    expect(statutSansConversion({ coupon_actif: false, last_call_outcome: O.INTERESSE })).toBe(S.INTERESSE);
    expect(statutSansConversion({ coupon_actif: false, last_call_outcome: O.NUMERO_INVALIDE })).toBe(S.INJOIGNABLE);
  });
});

describe('message du coupon', () => {
  it('remplit toutes les variables, même répétées', () => {
    const texte = remplirModele('{prenom}, {offre} avec {code} jusqu’au {expiration} : {lien} ({code})', {
      prenom: 'Awa',
      offre: '10 % sur la première commande',
      code: 'CN-ABC234',
      expiration: '01/10/2026',
      lien: 'https://exemple.test',
    });
    expect(texte).toBe(
      'Awa, 10 % sur la première commande avec CN-ABC234 jusqu’au 01/10/2026 : https://exemple.test (CN-ABC234)',
    );
  });

  it('sans prénom, on ne laisse pas un trou', () => {
    expect(prenomPourMessage(null)).toBe('cher client');
    expect(prenomPourMessage('  ')).toBe('cher client');
    expect(prenomPourMessage(' Awa ')).toBe('Awa');
  });

  it("date lisible au téléphone, à l'heure d'Abidjan (UTC)", () => {
    expect(dateCourte(new Date('2026-10-01T23:30:00.000Z'))).toBe('01/10/2026');
  });

  it('numéro au format Twilio', () => {
    expect(versE164('+225 07 00 00 00 01')).toBe('2250700000001');
    expect(versE164('0700000001')).toBe('2250700000001');
  });
});

describe('genererCodeCoupon', () => {
  it('six caractères faciles à dicter, sans 0, O, 1, I ni L', () => {
    for (let i = 0; i < 500; i++) {
      expect(genererCodeCoupon()).toMatch(/^CN-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/);
    }
  });
});

describe('commandeEffective', () => {
  it('exclut les commandes supprimées et les paiements en ligne encore en attente', () => {
    expect(commandeEffective('c1')).toEqual({
      customer_id: 'c1',
      entity_status: { not: 'DELETED' },
      NOT: { payment_method: 'ONLINE', paied: false, status: 'PENDING' },
    });
  });
});

describe('compter', () => {
  it('accorde à la française : singulier sous 2', () => {
    expect(compter(0, 'traité')).toBe('0 traité');
    expect(compter(1, 'conversion')).toBe('1 conversion');
    expect(compter(2, 'conversion')).toBe('2 conversions');
    expect(compter(3, 'contact traité', 'contacts traités')).toBe('3 contacts traités');
  });
});

describe('nouveau cycle', () => {
  it("remet le suivi à zéro sans toucher à l'historique ni au public", () => {
    expect(NOUVEAU_CYCLE.status).toBe(S.A_APPELER);
    expect(NOUVEAU_CYCLE.call_count).toBe(0);
    expect(NOUVEAU_CYCLE.assigned_to_id).toBeNull();
    expect(Object.keys(NOUVEAU_CYCLE)).not.toContain('segment');
    expect(Object.keys(NOUVEAU_CYCLE)).not.toContain('customer_id');
  });
  it('produit le même SQL que la version Prisma', () => {
    expect(NOUVEAU_CYCLE_SQL).toContain(`"status" = 'A_APPELER'`);
    expect(NOUVEAU_CYCLE_SQL).toContain('"call_count" = 0');
    expect(NOUVEAU_CYCLE_SQL).toContain('"converted_at" = NULL');
    expect(NOUVEAU_CYCLE_SQL.split(', ')).toHaveLength(Object.keys(NOUVEAU_CYCLE).length);
  });
});

describe('joursRestants', () => {
  const maintenant = new Date('2026-09-24T10:00:00Z');
  it('compte le jour entamé', () => {
    expect(joursRestants(new Date('2026-10-01T10:00:00Z'), maintenant)).toBe(7);
    expect(joursRestants(new Date('2026-09-24T11:00:00Z'), maintenant)).toBe(1);
  });
  it('ne descend jamais sous 1', () => {
    expect(joursRestants(new Date('2026-09-20T10:00:00Z'), maintenant)).toBe(1);
  });
});

describe('numéros', () => {
  it('ramène tous les formats ivoiriens à la même clé', () => {
    expect(cleTelephone('+225 07 01 00 00 01')).toBe('0701000001');
    expect(cleTelephone('0701000001')).toBe('0701000001');
    expect(cleTelephone('002250701000001')).toBe('0701000001');
    expect(cleTelephone('12345')).toBeNull();
  });
  it("n'écrit jamais un numéro étranger en +225", () => {
    expect(versE164('33612345678')).toBe('33612345678');
    expect(versE164('0701000001')).toBe('2250701000001');
    expect(versE164('+2250701000001')).toBe('2250701000001');
    expect(chiffresTelephone('00 33 6 12 34 56 78')).toBe('33612345678');
  });
});

describe('identiteContact', () => {
  it("préfère le compte de l'application", () => {
    const id = identiteContact({ name: 'Salif', phone: '0701', customer: { first_name: 'Awa', last_name: 'Koné', phone: '+2250700000001' } });
    expect(id).toMatchObject({ nom: 'Awa Koné', prenom: 'Awa', telephone: '+2250700000001' });
  });
  it('sans compte, garde le nom et le numéro relevés à la capture', () => {
    expect(identiteContact({ name: 'Koné Salif', phone: '0701000001', customer: null })).toMatchObject({
      nom: 'Koné Salif',
      prenom: 'Salif',
      telephone: '0701000001',
    });
    expect(identiteContact({ name: null, phone: '0701000002', customer: null }).nom).toBe('Client sans nom');
  });
});

describe('publicALaCapture (ce qui est arrivé en premier l\'emporte)', () => {
  const j = (n: number) => new Date(Date.UTC(2026, 8, 24) - n * 86_400_000);
  const base = { plateforme: P.YANGO, capteLe: j(7), joursInactivite: 30 };

  it('inscrit avant la capture, sans commande : reste inscrit sans commande', () => {
    expect(publicALaCapture({ ...base, inscritLe: j(80), derniereCommande: null })).toEqual({ segment: P.JAMAIS_COMMANDE, depuis: j(80) });
  });
  it('inscrit après la capture : client Yango depuis la capture', () => {
    expect(publicALaCapture({ ...base, inscritLe: j(2), derniereCommande: null })).toEqual({ segment: P.YANGO, depuis: j(7) });
  });
  it('devenu inactif avant la capture : client inactif depuis le jour du délai', () => {
    expect(publicALaCapture({ ...base, inscritLe: j(200), derniereCommande: j(130) })).toEqual({ segment: P.INACTIF, depuis: j(100) });
  });
  it('encore actif à la capture : client Yango', () => {
    expect(publicALaCapture({ ...base, inscritLe: j(200), derniereCommande: j(20) })).toEqual({ segment: P.YANGO, depuis: j(7) });
  });
  it('sans compte : client de la plateforme', () => {
    expect(publicALaCapture({ ...base, plateforme: P.GLOVO, inscritLe: null, derniereCommande: null })).toEqual({ segment: P.GLOVO, depuis: j(7) });
  });
});

// ---------------------------------------------------------------------------
// Tableaux de bord par public (lot 3)
// ---------------------------------------------------------------------------


describe('règles de lecture des ventes', () => {
  it('une vente compte si elle n’est ni annulée au registre, ni portée par une commande annulée ou supprimée', () => {
    expect(VENTE_VALIDE_SQL).toContain('v."cancelled_at" IS NULL');
    expect(VENTE_VALIDE_SQL).toContain(`ov."status" = 'CANCELLED'`);
    expect(VENTE_VALIDE_SQL).toContain(`ov."entity_status" = 'DELETED'`);
    expect(VENTE_VALIDE_SQL).toMatch(/NOT EXISTS/);
  });
  it('un coupon n’est « utilisé » que sur une commande qui compte', () => {
    expect(COUPON_UTILISE_SQL).toContain('c."used_at" IS NOT NULL');
    expect(COUPON_UTILISE_SQL).toContain(`oc."status" = 'CANCELLED'`);
  });
  it('une commande valide est effective et non annulée', () => {
    expect(COMMANDE_VALIDE_SQL).toContain(`o."entity_status" <> 'DELETED'`);
    expect(COMMANDE_VALIDE_SQL).toContain(`o."status" <> 'CANCELLED'`);
  });
});

describe('publicsDe', () => {
  it('fusionne segments et segment, sans doublon, dans l’ordre d’affichage', () => {
    expect(publicsDe({ segments: ['YANGO', 'GLOVO'], segment: 'YANGO' })).toEqual([P.GLOVO, P.YANGO]);
    expect(publicsDe({ segment: 'INACTIF' })).toEqual([P.INACTIF]);
  });
  it('ignore les valeurs inconnues ; rien demandé veut dire tous', () => {
    expect(publicsDe({ segments: ['AUTRE'] })).toEqual([]);
    expect(publicsDe({})).toEqual([]);
    expect(porteePublics([])).toEqual([P.JAMAIS_COMMANDE, P.INACTIF, P.GLOVO, P.YANGO]);
    expect(porteePublics([P.GLOVO])).toEqual([P.GLOVO]);
  });
});

describe('bornes de période (UTC)', () => {
  it('[from 00:00 ; to + 1 jour[', () => {
    expect(bornesPeriode({ from: '2026-09-01', to: '2026-09-30T15:00:00Z' })).toEqual({
      debut: new Date('2026-09-01T00:00:00.000Z'),
      fin: new Date('2026-10-01T00:00:00.000Z'),
    });
    expect(bornesPeriode({})).toEqual({ debut: null, fin: null });
  });
  it('en SQL : borne ouverte sans paramètre, rien sans période', () => {
    const sql = dansPeriode('k.created_at', { from: '2026-09-01', to: '2026-09-02' });
    expect(sql.sql).toBe('(k.created_at >= ? AND k.created_at < ?)');
    expect(sql.values).toEqual([new Date('2026-09-01T00:00:00.000Z'), new Date('2026-09-03T00:00:00.000Z')]);
    expect(dansPeriode('k.created_at', {}).sql).toBe('true');
    expect(plage('k.created_at', {}).sql).toBe('');
    expect(plage('k.created_at', { to: '2026-09-02' }).sql).toBe('AND (k.created_at < ?)');
  });
  it('filtres public et campagne', () => {
    expect(filtreSegments('y.segment', []).sql).toBe('');
    const f = filtreSegments('y.segment', [P.GLOVO, P.YANGO]);
    expect(f.sql).toBe('AND y.segment IN (?::"CrmSegment",?::"CrmSegment")');
    expect(f.values).toEqual(['GLOVO', 'YANGO']);
    expect(filtreCampagne('k.campaign_id', {}).sql).toBe('');
    expect(filtreCampagne('k.campaign_id', { campaign_id: 'x' }).values).toEqual(['x']);
  });
  it('mois entiers pour les cohortes', () => {
    expect(bornesMois({ from: '2026-03-15', to: '2026-05-02' })).toEqual({
      debut: new Date('2026-03-01T00:00:00.000Z'),
      fin: new Date('2026-06-01T00:00:00.000Z'),
    });
    expect(bornesMois({ to: '2026-12-31' }).fin).toEqual(new Date('2027-01-01T00:00:00.000Z'));
  });
  it('un mois de cohorte est complet quand son dernier entré a eu ses N jours', () => {
    expect(fenetreComplete('2026-08', 30, new Date('2026-09-30T00:00:00Z'))).toBe(false);
    expect(fenetreComplete('2026-08', 30, new Date('2026-10-01T00:00:00Z'))).toBe(true);
    expect(fenetreComplete('2026-12', 30, new Date('2027-01-31T00:00:00Z'))).toBe(true);
  });
});

describe('bornesTendance', () => {
  const maintenant = new Date('2026-09-24T10:00:00Z');
  it('sans début : depuis le premier passage', () => {
    expect(bornesTendance({ premierPassage: new Date('2026-07-10T08:00:00Z'), maintenant })).toEqual({
      debut: new Date('2026-07-10T00:00:00.000Z'),
      fin: new Date('2026-09-24T00:00:00.000Z'),
    });
  });
  it('au plus un an de points', () => {
    expect(bornesTendance({ premierPassage: new Date('2024-01-01T00:00:00Z'), maintenant }).debut).toEqual(
      new Date('2025-09-24T00:00:00.000Z'),
    );
    expect(bornesTendance({ from: '2020-01-01', to: '2026-01-10', premierPassage: null }).debut).toEqual(
      new Date('2025-01-10T00:00:00.000Z'),
    );
  });
  it('sans passage : les 30 derniers jours ; jamais un début après la fin', () => {
    expect(bornesTendance({ premierPassage: null, maintenant }).debut).toEqual(new Date('2026-08-26T00:00:00.000Z'));
    expect(bornesTendance({ from: '2026-10-01', to: '2026-09-01', premierPassage: null }).debut).toEqual(
      new Date('2026-09-01T00:00:00.000Z'),
    );
  });
});

describe('pourcentages et arrondis', () => {
  it('une décimale, 0 sans dénominateur', () => {
    expect(pourcentage(1, 3)).toBe(33.3);
    expect(pourcentage(5, 0)).toBe(0);
  });
  it('une valeur absente reste absente', () => {
    expect(arrondiOuNul(null)).toBeNull();
    expect(arrondiOuNul(undefined)).toBeNull();
    expect(arrondiOuNul(2.345)).toBe(2.3);
    expect(arrondiOuNul(0)).toBe(0);
  });
});

describe('entonnoir par public', () => {
  it('libellés du public seul, des deux publics captés, ou communs', () => {
    expect(libellesEntonnoir([P.INACTIF])).toEqual({ entree: 'Devenus inactifs', conversion: 'Reconquis' });
    expect(libellesEntonnoir([P.GLOVO, P.YANGO])).toEqual({ entree: 'Captés sur Glovo ou Yango', conversion: 'Commande directe' });
    expect(libellesEntonnoir([P.JAMAIS_COMMANDE, P.GLOVO])).toEqual({ entree: 'Entrés dans le CRM', conversion: 'Conversions' });
    expect(libelleLigne('CAPTES')).toBe('Glovo + Yango');
  });
  it('six étapes, parts sur les entrés et sur l’étape précédente', () => {
    const etapes = etapesEntonnoir({ entrees: 200, contactes: 100, joints: 50, interesses: 20, coupons: 10, commandes: 5 }, [P.JAMAIS_COMMANDE]);
    expect(etapes.map((e) => e.cle)).toEqual(['entrees', 'contactes', 'joints', 'interesses', 'coupons', 'commandes']);
    expect(etapes[0]).toMatchObject({ libelle: 'Inscrits', part_entree: 100, part_etape_precedente: 100 });
    expect(etapes[5]).toMatchObject({ libelle: 'Première commande', nombre: 5, part_entree: 2.5, part_inscrits: 2.5, part_etape_precedente: 50 });
  });
  it('aucune entrée : parts à 0, sans division par zéro', () => {
    const etapes = etapesEntonnoir({ entrees: 0, contactes: 0, joints: 0, interesses: 0, coupons: 0, commandes: 0 }, []);
    expect(etapes.every((e) => e.part_entree === 0)).toBe(true);
  });
});

describe('pareto', () => {
  it('trie, cumule et marque les raisons qui font 80 %', () => {
    const r = pareto([
      { raison: 'Trop cher', nombre: 10 },
      { raison: 'Livraison', nombre: 60 },
      { raison: 'Goût', nombre: 30 },
    ]);
    expect(r.total).toBe(100);
    expect(r.lignes.map((l) => [l.raison, l.part, l.cumul, l.principale])).toEqual([
      ['Livraison', 60, 60, true],
      ['Goût', 30, 90, true],
      ['Trop cher', 10, 100, false],
    ]);
  });
  it('liste vide', () => {
    expect(pareto([])).toEqual({ total: 0, lignes: [] });
  });
  it('le seuil de 80 % se juge sur la part exacte, pas sur son arrondi', () => {
    // Cumul avant la 3e ligne : 1999 / 2500 = 79,96 %, affiché 80 % mais encore sous le seuil.
    const r = pareto([
      { raison: 'A', nombre: 1500 },
      { raison: 'B', nombre: 499 },
      { raison: 'C', nombre: 300 },
      { raison: 'D', nombre: 201 },
    ]);
    expect(r.lignes.map((l) => l.principale)).toEqual([true, true, true, false]);
  });
});

describe('classerGroupes (GROUPING SETS)', () => {
  it('une ligne par public, Glovo + Yango, total ; écarte le groupe vide des publics non captés', () => {
    const lignes = [
      { g_segment: 0, g_groupe: 1, segment: 'GLOVO', groupe: null, x: 1 },
      { g_segment: 0, g_groupe: 1, segment: 'INACTIF', groupe: null, x: 2 },
      { g_segment: 1, g_groupe: 0, segment: null, groupe: 'CAPTES', x: 1 },
      { g_segment: 1, g_groupe: 0, segment: null, groupe: null, x: 2 },
      { g_segment: 1, g_groupe: 1, segment: null, groupe: null, x: 3 },
    ];
    const g = classerGroupes(lignes);
    expect(g.parPublic.get(P.GLOVO)?.x).toBe(1);
    expect(g.parPublic.get(P.INACTIF)?.x).toBe(2);
    expect(g.parPublic.has(P.YANGO)).toBe(false);
    expect(g.captes?.x).toBe(1);
    expect(g.total?.x).toBe(3);
  });
});

describe('calculerDevenir', () => {
  it('taux hors déjà-clients, taux à 30 jours sur les seuls mesurables, J+1', () => {
    const d = calculerDevenir(
      {
        ...BRUT_DEVENIR_VIDE,
        entrees: 10,
        contactes: 8,
        joints: 4,
        ventes: 3,
        base_taux: 8,
        ventes_base: 2,
        mesurables_fenetre: 4,
        ventes_fenetre: 1,
        mesurables_j1: 5,
        traites_j1: 4,
        delai_median_j: 2.26,
        captes: 10,
        deja_clients: 2,
        ventes_deja_clients: 1,
      },
      true,
    );
    expect(d).toMatchObject({
      taux_contact: 80,
      taux_joint: 50,
      taux_conversion: 25,
      taux_30j: 25,
      part_j1: 80,
      part_j2: 0,
      delai_median_j: 2.3,
      delai_moyen_j: null,
      deja_clients: 2,
    });
  });
  it('sans public capté : champs Glovo/Yango sans objet', () => {
    const d = calculerDevenir(BRUT_DEVENIR_VIDE, false);
    expect(d.deja_clients).toBeNull();
    expect(d.captes).toBeNull();
    expect(d.taux_conversion).toBe(0);
    expect(d.premier_appel_median_h).toBeNull();
  });
});
