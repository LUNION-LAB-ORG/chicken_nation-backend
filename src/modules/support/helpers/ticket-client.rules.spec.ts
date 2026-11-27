import { TicketStatus } from '@prisma/client';

import {
  estTicketEnCours,
  issueCreationTicket,
  lireDureeAudio,
  pieceJointeTicket,
} from './ticket-client.rules';

/**
 * Tickets du client (27/11) : « au lieu de retrouver le ticket déjà ouvert, il
 * me crée un autre ». Une commande n'a qu'une demande en cours.
 */
describe('tickets du client : une demande en cours par commande', () => {
  const ticket = (id: string, orderId: string | null) => ({ id, orderId });

  it('sans demande en cours, on crée', () => {
    expect(issueCreationTicket([], 'cmd-1')).toEqual({ voie: 'creer' });
  });

  it('la demande en cours de la même commande est rouverte', () => {
    const enCours = [ticket('t-2', 'cmd-2'), ticket('t-1', 'cmd-1')];
    expect(issueCreationTicket(enCours, 'cmd-1')).toEqual({ voie: 'rouvrir', ticket: enCours[1] });
  });

  it('une demande en cours sur une autre commande est montrée, la plus récente', () => {
    const enCours = [ticket('t-2', 'cmd-2'), ticket('t-3', 'cmd-3')];
    expect(issueCreationTicket(enCours, 'cmd-1')).toEqual({ voie: 'autre_demande', ticket: enCours[0] });
  });

  it('sans commande, une demande en cours reste une autre demande', () => {
    const enCours = [ticket('t-1', null)];
    expect(issueCreationTicket(enCours, null)).toEqual({ voie: 'autre_demande', ticket: enCours[0] });
    expect(issueCreationTicket(enCours, undefined)).toEqual({ voie: 'autre_demande', ticket: enCours[0] });
  });

  it('ouvert et en traitement sont en cours ; résolu et fermé ne le sont plus', () => {
    expect(estTicketEnCours(TicketStatus.OPEN)).toBe(true);
    expect(estTicketEnCours(TicketStatus.IN_PROGRESS)).toBe(true);
    expect(estTicketEnCours(TicketStatus.RESOLVED)).toBe(false);
    expect(estTicketEnCours(TicketStatus.CLOSED)).toBe(false);
    expect(estTicketEnCours(null)).toBe(false);
  });
});

describe('tickets du client : note vocale', () => {
  it("l'ancienne origine du message (une chaîne) n'est jamais servie", () => {
    expect(pieceJointeTicket('mobile_app')).toBeNull();
    expect(pieceJointeTicket(null)).toBeNull();
    expect(pieceJointeTicket(['a'])).toBeNull();
    expect(pieceJointeTicket({ source: 'mobile_app' })).toBeNull();
  });

  it('la note vocale est servie avec sa durée', () => {
    expect(pieceJointeTicket({ audioUrl: 'chicken-nation/tickets-audio/1-a.m4a', audioDurationMs: 4200.4 })).toEqual({
      audioUrl: 'chicken-nation/tickets-audio/1-a.m4a',
      audioDurationMs: 4200,
    });
    expect(pieceJointeTicket({ audioUrl: 'a.m4a', audioDurationMs: 'x' })).toEqual({ audioUrl: 'a.m4a', audioDurationMs: null });
    expect(pieceJointeTicket({ audioUrl: 'a.m4a', autre: 'secret' })).toEqual({ audioUrl: 'a.m4a', audioDurationMs: null });
  });

  it('la durée vient du formulaire en chaîne ; une valeur aberrante est ignorée', () => {
    expect(lireDureeAudio('4200')).toBe(4200);
    expect(lireDureeAudio(1500.6)).toBe(1501);
    expect(lireDureeAudio('')).toBeNull();
    expect(lireDureeAudio(undefined)).toBeNull();
    expect(lireDureeAudio('-5')).toBeNull();
    expect(lireDureeAudio(99_999_999)).toBeNull();
  });
});
