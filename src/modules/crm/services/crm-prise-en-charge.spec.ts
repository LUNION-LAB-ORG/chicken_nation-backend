import { CrmCallOutcome, CrmEventType, CrmStatus } from '@prisma/client';
import { DEFAULT_MAX_ATTEMPTS, STATUTS_OUVERTS, statutApresAppel } from '../crm.rules';

describe('annuaire : statut NON_DEMARCHE', () => {
  /**
   * L'invariant qui protège les agents : une fiche de l'annuaire ne doit entrer
   * dans aucun portefeuille ni dans aucune file. Tout en dépend.
   */
  it('n’est jamais un statut ouvert', () => {
    expect(STATUTS_OUVERTS).not.toContain(CrmStatus.NON_DEMARCHE);
  });

  /**
   * Et l'invariant qui protège les chiffres : un client qui commande sans qu'on
   * l'appelle ne doit JAMAIS compter comme une conversion du call center.
   */
  it('n’est pas « converti »', () => {
    expect(CrmStatus.NON_DEMARCHE).not.toBe(CrmStatus.CONVERTI);
  });

  const ctx = { dejaJoint: false, tentatives: 1, maxTentatives: DEFAULT_MAX_ATTEMPTS };

  it('qualifier un appel le fait entrer dans l’entonnoir, comme un « à appeler »', () => {
    for (const outcome of Object.values(CrmCallOutcome)) {
      expect([outcome, statutApresAppel(CrmStatus.NON_DEMARCHE, outcome, ctx)]).toEqual([
        outcome,
        statutApresAppel(CrmStatus.A_APPELER, outcome, ctx),
      ]);
    }
  });

  /**
   * Le cas précis qui motivait la règle : sans elle, « pas de réponse » le
   * laissait non démarché avec des tentatives au compteur, c'est-à-dire
   * travaillé mais invisible partout.
   */
  it('ne reste pas « non démarché » après un appel sans réponse', () => {
    const apres = statutApresAppel(CrmStatus.NON_DEMARCHE, CrmCallOutcome.NON_JOINT, ctx);
    expect(apres).toBe(CrmStatus.A_APPELER);
  });

  it('passe injoignable après assez de tentatives, comme les autres', () => {
    const apres = statutApresAppel(CrmStatus.NON_DEMARCHE, CrmCallOutcome.NON_JOINT, {
      ...ctx,
      tentatives: DEFAULT_MAX_ATTEMPTS,
    });
    expect(apres).toBe(CrmStatus.INJOIGNABLE);
  });

  it('l’événement de prise en charge est une ASSIGNATION', () => {
    expect(CrmEventType.ASSIGNATION).toBeDefined();
  });
});
