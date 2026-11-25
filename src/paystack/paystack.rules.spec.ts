import { createHmac } from 'node:crypto';
import { PaiementMode, PaiementStatus } from '@prisma/client';
import {
  REFERENCE_TENTATIVE,
  TAUX_FRAIS_DEFAUT,
  depuisUnitePaystack,
  emailPourPaystack,
  fraisClient,
  lireTaux,
  messageSousCompte,
  pourCentFraisService,
  tauxClient,
  lireSousCompte,
  lireTransaction,
  masquerCompte,
  modeDeCle,
  motifSousCompteInutilisable,
  motifTransactionRefusee,
  referenceTentative,
  statutTentative,
  versUnitePaystack,
} from './paystack.rules';
import { ipAutorisee, signatureAncienneValide, signatureNouvelleValide } from './paystack-signature';
import { callbackAppli, callbackSite, lienProfondAccepte, lienRetourAppli } from './retour-paiement.rules';
import { compatiblePaystack, lireReglages, verdictDisponibilite } from './paiement-en-ligne.service';
import { bilanRemboursementPaystack, referenceRemboursementPaystack } from 'src/modules/paiements/helpers/remboursement.rules';

describe('Paystack : montants en XOF (multipliés par 100, docs 25/11)', () => {
  it('12 500 F → 1 250 000 ; retour au franc', () => {
    expect(versUnitePaystack(12500)).toBe(1_250_000);
    expect(depuisUnitePaystack(1_250_000)).toBe(12500);
    expect(depuisUnitePaystack('1250000')).toBe(12500);
  });
  it('refuse zéro, négatif, décimal et illisible', () => {
    expect(versUnitePaystack(0)).toBeNull();
    expect(versUnitePaystack(-5)).toBeNull();
    expect(versUnitePaystack(10.5)).toBeNull();
    expect(versUnitePaystack(Number.NaN)).toBeNull();
    expect(depuisUnitePaystack('12,5')).toBeNull();
    expect(depuisUnitePaystack(null)).toBeNull();
  });
});

describe('Paystack : frais de paiement ajoutés au client (25/11)', () => {
  it('tarifs par défaut : Mobile Money 2,3 %, carte 3,8 %, sans supplément', () => {
    expect(TAUX_FRAIS_DEFAUT).toEqual({ mobileMoney: 2.3, carte: 3.8 });
    expect(tauxClient(TAUX_FRAIS_DEFAUT, 'mobile_money')).toBe(2.3);
    expect(tauxClient(TAUX_FRAIS_DEFAUT, 'card')).toBe(3.8);
  });
  it('arrondi au franc supérieur, sans erreur de virgule', () => {
    // 10 000 F à 2,3 % : 230 F tout rond (jamais 231).
    expect(fraisClient(10000, 'mobile_money', TAUX_FRAIS_DEFAUT)).toBe(230);
    expect(fraisClient(10000, 'card', TAUX_FRAIS_DEFAUT)).toBe(380);
    // Commande de 10 100 F (10 000 F de plats + 1 % de frais de service) : 232,3 F → 233 F ; 383,8 F → 384 F.
    expect(fraisClient(10100, 'mobile_money', TAUX_FRAIS_DEFAUT)).toBe(233);
    expect(fraisClient(10100, 'card', TAUX_FRAIS_DEFAUT)).toBe(384);
    expect(fraisClient(1, 'mobile_money', TAUX_FRAIS_DEFAUT)).toBe(1);
    expect(fraisClient(0, 'mobile_money', TAUX_FRAIS_DEFAUT)).toBe(0);
    expect(fraisClient(10000, 'mobile_money', { mobileMoney: 0, carte: 0 })).toBe(0);
  });
  it('taux lus dans les réglages : virgule acceptée, hors bornes ou illisible → défaut', () => {
    expect(lireTaux('2,3', 9)).toBe(2.3);
    expect(lireTaux('4.567', 9)).toBe(4.57);
    expect(lireTaux('0', 9)).toBe(0);
    expect(lireTaux('', 9)).toBe(9);
    expect(lireTaux('abc', 9)).toBe(9);
    expect(lireTaux('-1', 9)).toBe(9);
    expect(lireTaux('45', 9)).toBe(9);
  });
  it('frais de service : le réglage est une fraction (0.01 = 1 %)', () => {
    expect(pourCentFraisService('0.01')).toBe(1);
    expect(pourCentFraisService('0.005')).toBe(0.5);
    expect(pourCentFraisService('0,18')).toBe(18);
    expect(pourCentFraisService('0')).toBe(0);
    expect(pourCentFraisService('abc')).toBe(0);
    expect(pourCentFraisService(undefined)).toBe(0);
  });
});

describe('Paystack : e-mail, référence, clé', () => {
  it("e-mail du client s'il est valide ; sinon une adresse technique stable qui ne révèle rien", () => {
    expect(emailPourPaystack('awa@exemple.ci', 'c1')).toBe('awa@exemple.ci');
    const a = emailPourPaystack(null, 'c1');
    expect(a).toMatch(/^[0-9a-f]{24}@clients\.chicken-nation\.com$/);
    expect(emailPourPaystack('', 'c1')).toBe(a);
    expect(emailPourPaystack('pas-un-email', 'c2')).not.toBe(a);
    // Domaines fictifs ou sans extension en lettres : Paystack les refuse (vu le 25/11 en mode test).
    expect(emailPourPaystack('koffi@exemple.test', 'c1')).toBe(a);
    expect(emailPourPaystack('koffi@serveur.local', 'c1')).toBe(a);
    expect(emailPourPaystack('koffi@gmail', 'c1')).toBe(a);
    expect(emailPourPaystack('koffi@gmail.c0m', 'c1')).toBe(a);
  });
  it('référence : commande + suffixe aléatoire, caractères permis par Paystack', () => {
    const r = referenceTentative('ORD-261125-44839', () => 'a1b2c3d4');
    expect(r).toBe('ORD-261125-44839-PA1B2C3D4');
    expect(REFERENCE_TENTATIVE.test(r)).toBe(true);
    expect(referenceTentative('ORD 1/2', () => 'ff')).toBe('ORD12-PFF');
    expect(REFERENCE_TENTATIVE.test('ORD-261125-44839')).toBe(false);
  });
  it('mode de la clé', () => {
    expect(modeDeCle('sk_test_abcdefgh123')).toBe('test');
    expect(modeDeCle('sk_live_abcdefgh123')).toBe('live');
    expect(modeDeCle('pk_test_abcdefgh123')).toBeNull();
    expect(modeDeCle('')).toBeNull();
  });
});

describe('Paystack : sous-compte du restaurant', () => {
  const brut = {
    subaccount_code: 'ACCT_zone4abc',
    business_name: 'Chicken Nation Zone 4',
    settlement_bank: 'Wave',
    account_number: '0707070707',
    percentage_charge: 0,
    active: true,
    currency: 'XOF',
  };
  it('utilisable : actif, en XOF, compte principal à 0 % ; numéro masqué', () => {
    const s = lireSousCompte(brut)!;
    expect(s.compte).toBe('••••••0707');
    expect(motifSousCompteInutilisable(s)).toBeNull();
    expect(motifSousCompteInutilisable(s, 1)).toBeNull();
  });
  it('compte principal à 1 % (99 % pour le restaurant) : accepté avec des frais de service de 1 %, refusé sans', () => {
    const s = lireSousCompte({ ...brut, percentage_charge: 1 });
    expect(motifSousCompteInutilisable(s, 1)).toBeNull();
    expect(motifSousCompteInutilisable(s, 0)).toBe('PART_COMPTE_PRINCIPAL');
    expect(messageSousCompte('PART_COMPTE_PRINCIPAL', s, 0)).toBe(
      'Ce sous-compte laisse 1 % au compte principal : le maximum est le taux des frais de service (0 %). Corrigez le pourcentage dans le tableau de bord Paystack, ou les frais de service.',
    );
  });
  it('refusé si le compte principal garde plus que les frais de service, inactif, autre devise ou inconnu', () => {
    expect(motifSousCompteInutilisable(lireSousCompte({ ...brut, percentage_charge: 2.5 }), 1)).toBe('PART_COMPTE_PRINCIPAL');
    // 99 saisi par erreur à la place de 1 : le compte principal prendrait presque tout.
    expect(motifSousCompteInutilisable(lireSousCompte({ ...brut, percentage_charge: 99 }), 1)).toBe('PART_COMPTE_PRINCIPAL');
    expect(motifSousCompteInutilisable(lireSousCompte({ ...brut, percentage_charge: undefined }), 1)).toBe('PART_COMPTE_PRINCIPAL');
    expect(motifSousCompteInutilisable(lireSousCompte({ ...brut, active: false }), 1)).toBe('INACTIF');
    expect(motifSousCompteInutilisable(lireSousCompte({ ...brut, currency: 'GHS' }), 1)).toBe('DEVISE');
    expect(motifSousCompteInutilisable(lireSousCompte({}), 1)).toBe('INCONNU');
  });
  it('masquage', () => {
    expect(masquerCompte('1234')).toBe('1234');
    expect(masquerCompte(null)).toBeNull();
  });
});

describe('Paystack : transaction vérifiée', () => {
  const brut = {
    reference: 'ORD-1-PAB12',
    status: 'success',
    amount: 1_050_000,
    fees: 21_000,
    currency: 'XOF',
    channel: 'mobile_money',
    domain: 'test',
    paid_at: '2026-11-25T12:00:00.000Z',
    metadata: JSON.stringify({ order_id: 'o-1' }),
    subaccount: { subaccount_code: 'ACCT_zone4abc' },
    authorization: { bank: 'Wave', mobile_money_number: '0707070707' },
    customer: { email: 'x@y.ci' },
  };
  const attendu = { reference: 'ORD-1-PAB12', orderId: 'o-1', sousCompte: 'ACCT_zone4abc', mode: 'test' as const };

  it('lue dans le vocabulaire des paiements : 10 500 F, frais 210 F, Wave en Mobile Money', () => {
    const t = lireTransaction(brut, 'ORD-1-PAB12');
    expect(t).toEqual(
      expect.objectContaining({
        statut: PaiementStatus.SUCCESS,
        montant: 10500,
        frais: 210,
        mode: PaiementMode.MOBILE_MONEY,
        source: 'wave',
        orderId: 'o-1',
        sousCompte: 'ACCT_zone4abc',
      }),
    );
    expect(lireTransaction({ ...brut, channel: 'card', authorization: { brand: 'visa' } }, 'x').mode).toBe(PaiementMode.CARD);
    expect(lireTransaction({ ...brut, status: 'abandoned' }, 'x').statut).toBe(PaiementStatus.FAILED);
  });

  it('acceptée pour sa commande ; refusée pour un autre mode, une autre devise, une autre commande ou un autre sous-compte', () => {
    expect(motifTransactionRefusee(lireTransaction(brut, 'x'), attendu)).toBeNull();
    expect(motifTransactionRefusee(lireTransaction({ ...brut, domain: 'live' }, 'x'), attendu)).toMatch(/mode/);
    expect(motifTransactionRefusee(lireTransaction({ ...brut, currency: 'NGN' }, 'x'), attendu)).toMatch(/devise/);
    expect(motifTransactionRefusee(lireTransaction({ ...brut, metadata: { order_id: 'o-2' } }, 'x'), attendu)).toMatch(/autre commande/);
    expect(motifTransactionRefusee(lireTransaction({ ...brut, subaccount: { subaccount_code: 'ACCT_autre' } }, 'x'), attendu)).toMatch(/sous-compte/);
    expect(motifTransactionRefusee(lireTransaction({ ...brut, reference: 'ORD-2-PCD' }, 'x'), attendu)).toMatch(/référence/);
  });

  it('statut de la tentative', () => {
    expect(statutTentative({ statutPaystack: 'success' })).toBe('PAYEE');
    expect(statutTentative({ statutPaystack: 'failed' })).toBe('ECHEC');
    expect(statutTentative({ statutPaystack: 'abandoned' })).toBe('ABANDON');
    expect(statutTentative({ statutPaystack: 'ongoing' })).toBe('INITIEE');
  });
});

describe('Paystack : signature des webhooks (docs 25/11)', () => {
  const corps = '{"event":"charge.success","data":{"reference":"ORD-1-PAB12"}}';
  const secret = 'whsec_abcdefgh12345678';
  const t = 1_764_072_000;
  const sig = createHmac('sha512', secret).update(`${t}.${corps}`).digest('hex');

  it('nouveau schéma : t et v1 (plusieurs v1 possibles), fenêtre de 300 s', () => {
    expect(signatureNouvelleValide(corps, `t=${t},v1=whk_1:${sig}`, [secret], t + 10)).toBe(true);
    expect(signatureNouvelleValide(corps, `t=${t},v1=whk_0:${'0'.repeat(128)},v1=whk_1:${sig}`, [secret], t)).toBe(true);
    expect(signatureNouvelleValide(corps, `t=${t},v1=whk_1:${sig}`, [secret], t + 301)).toBe(false);
    expect(signatureNouvelleValide(corps + ' ', `t=${t},v1=whk_1:${sig}`, [secret], t)).toBe(false);
    expect(signatureNouvelleValide(corps, `t=${t},v1=whk_1:${sig}`, ['whsec_autre1234'], t)).toBe(false);
    expect(signatureNouvelleValide(corps, undefined, [secret], t)).toBe(false);
  });
  it('ancien schéma : x-paystack-signature = HMAC SHA512 du corps avec la clé secrète', () => {
    const cle = 'sk_test_abcdefgh123';
    const h = createHmac('sha512', cle).update(corps).digest('hex');
    expect(signatureAncienneValide(corps, h, [cle])).toBe(true);
    expect(signatureAncienneValide(corps, h, ['sk_test_autre12345'])).toBe(false);
    expect(signatureAncienneValide(corps, 'abc', [cle])).toBe(false);
  });
  it('IP de Paystack (contrôle facultatif)', () => {
    expect(ipAutorisee('::ffff:52.31.139.75', ['52.31.139.75'])).toBe(true);
    expect(ipAutorisee('1.2.3.4', ['52.31.139.75'])).toBe(false);
    expect(ipAutorisee('1.2.3.4', [])).toBe(true);
  });
});

describe('Retour après la page de paiement', () => {
  it("lien profond de l'appli seulement (Expo hors production) : jamais une adresse web", () => {
    expect(lienProfondAccepte('chickennation://paiement-retour', true)).toBe('chickennation://paiement-retour');
    expect(lienProfondAccepte('exp://192.168.1.5:8081/--/paiement-retour', false)).toBeTruthy();
    expect(lienProfondAccepte('exp://192.168.1.5:8081/--/paiement-retour', true)).toBeNull();
    expect(lienProfondAccepte('https://pirate.example/x', false)).toBeNull();
    expect(lienProfondAccepte('javascript://alert(1)', false)).toBeNull();
    expect(lienProfondAccepte('chickennation://x" onload="y', true)).toBeNull();
    expect(lienProfondAccepte('chickennation://user@hote/x', true)).toBeNull();
  });
  it('référence ajoutée au lien ; adresses de retour', () => {
    expect(lienRetourAppli('chickennation://paiement-retour', 'ORD-1-PAB', true)).toBe('chickennation://paiement-retour?reference=ORD-1-PAB');
    expect(lienRetourAppli('chickennation://x?a=1', 'R-PA', true)).toBe('chickennation://x?a=1&reference=R-PA');
    expect(callbackAppli('chickennation://paiement-retour')).toBe(
      'https://api-private.chicken-nation.com/api/v1/paystack/retour?vers=chickennation%3A%2F%2Fpaiement-retour',
    );
    expect(callbackSite('o-1')).toBe('https://www.chicken-nation.com/fr/commander/o-1');
  });
});

describe('Disponibilité du paiement en ligne', () => {
  const base = { compatiblePaystack: true, paystackConfigure: true, sousCompteUtilisable: true };
  it('réglages illisibles : comportement d’avant (activé, KKiaPay)', () => {
    expect(lireReglages({})).toEqual({ actif: true, fournisseur: 'kkiapay' });
    expect(lireReglages({ paiement_en_ligne_actif: 'false', paiement_fournisseur: 'PAYSTACK' })).toEqual({ actif: false, fournisseur: 'paystack' });
  });
  it('en-tête de l’appli', () => {
    expect(compatiblePaystack('kkiapay, paystack')).toBe(true);
    expect(compatiblePaystack(undefined)).toBe(false);
  });
  it('coupé, ancienne appli, Paystack sans clé, restaurant sans sous-compte : indisponible avec le bon message', () => {
    expect(verdictDisponibilite({ ...base, reglages: { actif: false, fournisseur: 'paystack' } }).motif).toBe('DESACTIVE');
    expect(verdictDisponibilite({ ...base, compatiblePaystack: false, reglages: { actif: true, fournisseur: 'paystack' } }).motif).toBe('MISE_A_JOUR');
    expect(verdictDisponibilite({ ...base, paystackConfigure: false, reglages: { actif: true, fournisseur: 'paystack' } }).motif).toBe('NON_CONFIGURE');
    const r = verdictDisponibilite({ ...base, sousCompteUtilisable: false, reglages: { actif: true, fournisseur: 'paystack' } });
    expect(r).toEqual(expect.objectContaining({ disponible: false, motif: 'RESTAURANT' }));
    expect(r.message).toBe("Le paiement en ligne n'est pas encore disponible pour ce restaurant.");
  });
  it('KKiaPay : l’ancienne appli continue ; Paystack prêt : disponible', () => {
    expect(verdictDisponibilite({ ...base, compatiblePaystack: false, reglages: { actif: true, fournisseur: 'kkiapay' } }).disponible).toBe(true);
    expect(verdictDisponibilite({ ...base, reglages: { actif: true, fournisseur: 'paystack' } }).disponible).toBe(true);
    // Restaurant pas encore connu (livraison avant l’adresse) : on ne refuse pas d’avance.
    expect(verdictDisponibilite({ ...base, sousCompteUtilisable: null, reglages: { actif: true, fournisseur: 'paystack' } }).disponible).toBe(true);
  });
  it('aucun message avec un tiret cadratin', () => {
    for (const actif of [true, false]) {
      for (const compatible of [true, false]) {
        const m = verdictDisponibilite({ ...base, compatiblePaystack: compatible, reglages: { actif, fournisseur: 'paystack' } }).message ?? '';
        expect(m).not.toMatch(/[–—]/);
      }
    }
  });
});

describe('Remboursement Paystack', () => {
  const paiement = { status: PaiementStatus.SUCCESS, amount: 10500, total: 10500, rembourse_at: null };
  it('remboursable si Paystack dit payée au même montant', () => {
    expect(bilanRemboursementPaystack(paiement, { statutPaystack: 'success', montant: 10500 }).remboursable).toBe(true);
  });
  it('déjà remboursée chez Paystack : seulement à enregistrer ; demande en cours, montant différent, non payée : bloqué', () => {
    expect(bilanRemboursementPaystack(paiement, { statutPaystack: 'reversed', montant: 10500 })).toEqual(
      expect.objectContaining({ remboursable: false, constatable: true }),
    );
    expect(bilanRemboursementPaystack({ ...paiement, demandeEnCours: true }, { statutPaystack: 'success', montant: 10500 }).raison).toMatch(/en cours/);
    expect(bilanRemboursementPaystack(paiement, { statutPaystack: 'success', montant: 9000 }).remboursable).toBe(false);
    expect(bilanRemboursementPaystack(paiement, { statutPaystack: 'abandoned', montant: 10500 }).remboursable).toBe(false);
    expect(bilanRemboursementPaystack(paiement, null).remboursable).toBe(false);
  });
  it('notre référence : une par paiement, 8 à 64 caractères permis', () => {
    const r = referenceRemboursementPaystack('3f2a9c1e-1111-4222-8333-444455556666');
    expect(r).toMatch(/^CNR-[A-Za-z0-9]{8,60}$/);
    expect(r.length).toBeLessThanOrEqual(64);
  });
});
