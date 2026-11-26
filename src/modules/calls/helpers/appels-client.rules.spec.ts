import { CallStatus, UserRole } from '@prisma/client';

import {
  appelantClient,
  appliClientARafraichir,
  appliClientPrete,
  correspondantDuClient,
  nomClient,
  nomClientPourLivreur,
  peutAppelerClient,
  phasePourClient,
} from './appels-client.rules';
import { partiesAPrevenir } from './appels-livreur.rules';

const JOUR = 24 * 60 * 60 * 1000;

describe('Appels avec les clients : règles', () => {
  it('nom du client pour le personnel : prénom et nom, à défaut le téléphone, à défaut « Client »', () => {
    expect(nomClient({ first_name: ' Awa ', last_name: 'Koné', phone: '+2250707070707' })).toBe('Awa Koné');
    expect(nomClient({ first_name: null, last_name: '', phone: '+2250707070707' })).toBe('+2250707070707');
    expect(nomClient(null)).toBe('Client');
  });

  it('nom du client pour le livreur : le prénom, jamais le numéro', () => {
    expect(nomClientPourLivreur({ first_name: 'Awa', last_name: 'Koné' })).toBe('Awa');
    expect(nomClientPourLivreur({ first_name: '', last_name: 'Koné' })).toBe('Koné');
    expect(nomClientPourLivreur({ first_name: null, last_name: null })).toBe('Client');
    expect(nomClientPourLivreur(null)).toBe('Client');
  });

  it('appelant client vu du personnel : id, nom, téléphone, commande', () => {
    expect(
      appelantClient(
        { id: 'c1', first_name: 'Awa', last_name: 'Koné', phone: '+2250707070707' },
        { id: 'o1', reference: 'ORD-1' },
      ),
    ).toEqual({ id: 'c1', nom: 'Awa Koné', telephone: '+2250707070707', commande_id: 'o1', commande_reference: 'ORD-1' });
    expect(appelantClient({ id: 'c1' }, null)).toEqual({
      id: 'c1',
      nom: 'Client',
      telephone: null,
      commande_id: null,
      commande_reference: null,
    });
  });

  it('seuls l’admin et le rôle CALL_CENTER appellent un client dans l’appli', () => {
    expect(peutAppelerClient(UserRole.ADMIN)).toBe(true);
    expect(peutAppelerClient(UserRole.CALL_CENTER)).toBe(true);
    expect(peutAppelerClient(UserRole.MARKETING)).toBe(false);
    expect(peutAppelerClient(UserRole.MANAGER)).toBe(false);
    expect(peutAppelerClient(null)).toBe(false);
  });

  it('appli du client prête : elle l’a dit il y a 45 jours au plus', () => {
    const maintenant = new Date('2026-11-26T12:00:00Z').getTime();
    expect(appliClientPrete(null, maintenant)).toBe(false);
    expect(appliClientPrete(new Date(maintenant - 2 * JOUR), maintenant)).toBe(true);
    expect(appliClientPrete(new Date(maintenant - 45 * JOUR), maintenant)).toBe(true);
    expect(appliClientPrete(new Date(maintenant - 46 * JOUR), maintenant)).toBe(false);
  });

  it('repère de l’appli réécrit une fois par jour au plus', () => {
    const maintenant = new Date('2026-11-26T12:00:00Z').getTime();
    expect(appliClientARafraichir(null, maintenant)).toBe(true);
    expect(appliClientARafraichir(new Date(maintenant - 60 * 60 * 1000), maintenant)).toBe(false);
    expect(appliClientARafraichir(new Date(maintenant - JOUR), maintenant)).toBe(true);
  });

  it('correspondant du client : le livreur quand il l’appelle, sinon le service client', () => {
    expect(correspondantDuClient({ caller_customer_id: 'c1', target_deliverer_id: 'l1' })).toBe('LIVREUR');
    expect(correspondantDuClient({ caller_customer_id: 'c1', target_deliverer_id: null })).toBe('SERVICE_CLIENT');
    expect(correspondantDuClient({ caller_customer_id: null, target_deliverer_id: null })).toBe('SERVICE_CLIENT');
  });

  it('phase vue du client', () => {
    expect(phasePourClient({ status: CallStatus.RINGING, caller_customer_id: 'c1' }, 'c1')).toEqual({
      direction: 'outgoing',
      phase: 'calling',
    });
    expect(phasePourClient({ status: CallStatus.RINGING, caller_customer_id: null }, 'c1')).toEqual({
      direction: 'incoming',
      phase: 'ringing',
    });
    expect(phasePourClient({ status: CallStatus.ONGOING, caller_customer_id: null }, 'c1')).toEqual({
      direction: 'incoming',
      phase: 'connected',
    });
  });

  it('fin d’un appel avec un client : l’autre côté est prévenu, jamais celui qui raccroche', () => {
    const clientAppelleAgent = {
      caller_id: null,
      caller_deliverer_id: null,
      caller_customer_id: 'c1',
      answered_by_id: 'u1',
      target_deliverer_id: null,
      target_customer_id: null,
    };
    expect(partiesAPrevenir(clientAppelleAgent, { type: 'customer', id: 'c1' })).toEqual([{ type: 'user', id: 'u1' }]);
    expect(partiesAPrevenir(clientAppelleAgent, { type: 'user', id: 'u1' })).toEqual([{ type: 'customer', id: 'c1' }]);

    const clientAppelleLivreur = { ...clientAppelleAgent, answered_by_id: null, target_deliverer_id: 'l1' };
    expect(partiesAPrevenir(clientAppelleLivreur, { type: 'deliverer', id: 'l1' })).toEqual([
      { type: 'customer', id: 'c1' },
    ]);
    expect(partiesAPrevenir(clientAppelleLivreur, { type: 'customer', id: 'c1' })).toEqual([
      { type: 'deliverer', id: 'l1' },
    ]);

    const agentAppelleClient = {
      caller_id: 'u1',
      caller_deliverer_id: null,
      answered_by_id: null,
      target_deliverer_id: null,
      target_customer_id: 'c1',
    };
    expect(partiesAPrevenir(agentAppelleClient, { type: 'user', id: 'u1' })).toEqual([{ type: 'customer', id: 'c1' }]);
    expect(partiesAPrevenir(agentAppelleClient, { type: 'customer', id: 'c1' })).toEqual([{ type: 'user', id: 'u1' }]);
  });
});
