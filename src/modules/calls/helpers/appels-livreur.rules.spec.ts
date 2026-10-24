import { CallStatus, UserRole } from '@prisma/client';

import {
  appelantLivreur,
  lireAppelsLivreursActifs,
  nomLivreur,
  partiesAPrevenir,
  peutAppelerLivreur,
  phasePourLivreur,
} from './appels-livreur.rules';

describe('Appels avec les livreurs : règles', () => {
  it('nom du livreur : prénom et nom, à défaut le téléphone, à défaut « Livreur »', () => {
    expect(nomLivreur({ first_name: ' Koffi ', last_name: 'Kouassi', phone: '+2250701020304' })).toBe('Koffi Kouassi');
    expect(nomLivreur({ first_name: null, last_name: '', phone: '+2250701020304' })).toBe('+2250701020304');
    expect(nomLivreur(null)).toBe('Livreur');
  });

  it('appelant livreur vu du personnel : id, nom, téléphone, restaurant, course', () => {
    expect(
      appelantLivreur(
        { id: 'l1', first_name: 'Koffi', last_name: 'Kouassi', phone: '+2250701020304', restaurant: { name: 'Angré' } },
        { reference: 'CRS-A1' },
      ),
    ).toEqual({
      id: 'l1',
      nom: 'Koffi Kouassi',
      telephone: '+2250701020304',
      restaurant: 'Angré',
      course_reference: 'CRS-A1',
    });
    expect(appelantLivreur({ id: 'l1', phone: '+2250701020304' })).toMatchObject({
      restaurant: null,
      course_reference: null,
    });
  });

  it('réglage calls.livreurs_actif : actif par défaut, coupé seulement par une valeur explicite', () => {
    for (const v of [null, undefined, '', '1', 'true', 'oui', 'n’importe quoi']) {
      expect(lireAppelsLivreursActifs(v)).toBe(true);
    }
    for (const v of ['0', ' 0 ', 'false', 'OFF', 'non', 'no']) {
      expect(lireAppelsLivreursActifs(v)).toBe(false);
    }
  });

  it('seuls le service client et l’admin appellent un livreur', () => {
    expect(peutAppelerLivreur(UserRole.CALL_CENTER)).toBe(true);
    expect(peutAppelerLivreur(UserRole.ADMIN)).toBe(true);
    expect(peutAppelerLivreur(UserRole.MARKETING)).toBe(false);
    expect(peutAppelerLivreur(UserRole.CAISSIER)).toBe(false);
    expect(peutAppelerLivreur(null)).toBe(false);
  });

  it('fin d’appel : toutes les parties sauf celle qui raccroche', () => {
    const livreurAppelle = { caller_id: null, caller_deliverer_id: 'l1', answered_by_id: 'u1', target_deliverer_id: null };
    expect(partiesAPrevenir(livreurAppelle, { type: 'deliverer', id: 'l1' })).toEqual([{ type: 'user', id: 'u1' }]);
    expect(partiesAPrevenir(livreurAppelle, { type: 'user', id: 'u1' })).toEqual([{ type: 'deliverer', id: 'l1' }]);

    const agentAppelle = { caller_id: 'u1', caller_deliverer_id: null, answered_by_id: null, target_deliverer_id: 'l1' };
    expect(partiesAPrevenir(agentAppelle, { type: 'user', id: 'u1' })).toEqual([{ type: 'deliverer', id: 'l1' }]);
    // Un admin qui coupe l'appel des autres les prévient tous.
    expect(partiesAPrevenir(agentAppelle, { type: 'user', id: 'admin' })).toEqual([
      { type: 'user', id: 'u1' },
      { type: 'deliverer', id: 'l1' },
    ]);

    // Appel entre membres du personnel : comme avant, l'autre côté seulement.
    const personnel = { caller_id: 'u1', caller_deliverer_id: null, answered_by_id: 'u2', target_deliverer_id: null };
    expect(partiesAPrevenir(personnel, { type: 'user', id: 'u1' })).toEqual([{ type: 'user', id: 'u2' }]);
    expect(partiesAPrevenir(personnel, { type: 'user', id: 'u2' })).toEqual([{ type: 'user', id: 'u1' }]);
  });

  it('phase vue du livreur', () => {
    expect(phasePourLivreur({ status: CallStatus.RINGING, caller_deliverer_id: 'l1' }, 'l1')).toEqual({
      direction: 'outgoing',
      phase: 'calling',
    });
    expect(phasePourLivreur({ status: CallStatus.RINGING, caller_deliverer_id: null }, 'l1')).toEqual({
      direction: 'incoming',
      phase: 'ringing',
    });
    expect(phasePourLivreur({ status: CallStatus.ONGOING, caller_deliverer_id: null }, 'l1')).toEqual({
      direction: 'incoming',
      phase: 'connected',
    });
  });
});
