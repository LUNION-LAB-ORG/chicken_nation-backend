import { CrmCallOutcome as O, CrmStatus as S } from '@prisma/client';
import {
  commandeEffective,
  compter,
  dateCourte,
  joursRestants,
  NOUVEAU_CYCLE,
  NOUVEAU_CYCLE_SQL,
  genererCodeCoupon,
  prenomPourMessage,
  remplirModele,
  statutApresAppel,
  statutSansConversion,
  versE164,
} from './crm.rules';

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
