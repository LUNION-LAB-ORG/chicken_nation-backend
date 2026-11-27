/**
 * Ouvert ou fermé selon les horaires (`RestaurantService.isRestaurantOpen`).
 *
 * Cas visé le 27/11 : un restaurant qui ferme APRÈS MINUIT (« 22:00-02:00 »,
 * « 10:00-01:00 »). Entre minuit et la fermeture, c'est le créneau de la
 * VEILLE qui court encore ; le serveur le jugeait fermé et refusait les
 * commandes, alors que l'appli le disait ouvert.
 *
 * Les dates sont construites à l'heure locale du serveur, comme `new Date()`.
 */

import { RestaurantService } from './restaurant.service';

type Horaires = Record<string, string>[];

const ouvert = (horaires: Horaires, date: Date) =>
  RestaurantService.prototype.isRestaurantOpen.call(null as never, horaires, date);

// 27/11/2026 est un vendredi (jour 5), le 28 un samedi (6), le 29 un dimanche (7), le 30 un lundi (1).
const le = (jour: number, heure: number, minute = 0, seconde = 0) => new Date(2026, 10, jour, heure, minute, seconde);

const tousLesJours = (plage: string): Horaires => [1, 2, 3, 4, 5, 6, 7].map((j) => ({ [String(j)]: plage }));

describe('RestaurantService.isRestaurantOpen', () => {
  describe('horaires dans la journée', () => {
    const horaires = tousLesJours('10:00-22:00');

    it('ouvert entre l’ouverture et la fermeture, bornes comprises', () => {
      expect(ouvert(horaires, le(27, 10, 0))).toBe(true);
      expect(ouvert(horaires, le(27, 14, 30))).toBe(true);
      expect(ouvert(horaires, le(27, 22, 0))).toBe(true);
    });

    it('fermé avant et après', () => {
      expect(ouvert(horaires, le(27, 9, 59))).toBe(false);
      expect(ouvert(horaires, le(27, 22, 0, 30))).toBe(false);
      expect(ouvert(horaires, le(28, 0, 30))).toBe(false);
    });
  });

  describe('fermeture après minuit', () => {
    const horaires = tousLesJours('22:00-02:00');

    it('ouvert le soir, dès l’ouverture', () => {
      expect(ouvert(horaires, le(27, 22, 0))).toBe(true);
      expect(ouvert(horaires, le(27, 23, 30))).toBe(true);
    });

    it('ouvert après minuit, jusqu’à la fermeture', () => {
      expect(ouvert(horaires, le(28, 0, 30))).toBe(true);
      expect(ouvert(horaires, le(28, 1, 0))).toBe(true);
      expect(ouvert(horaires, le(28, 2, 0))).toBe(true);
    });

    it('fermé entre la fermeture et l’ouverture suivante', () => {
      expect(ouvert(horaires, le(28, 2, 0, 30))).toBe(false);
      expect(ouvert(horaires, le(28, 3, 0))).toBe(false);
      expect(ouvert(horaires, le(28, 21, 59))).toBe(false);
    });

    it('« 10:00-01:00 » : ouvert à 00:30, fermé à 05:00', () => {
      const longs = tousLesJours('10:00-01:00');
      expect(ouvert(longs, le(28, 0, 30))).toBe(true);
      expect(ouvert(longs, le(28, 5, 0))).toBe(false);
      expect(ouvert(longs, le(28, 10, 0))).toBe(true);
    });
  });

  describe('après minuit, c’est le créneau de la veille qui compte', () => {
    it('veille ouverte tard, jour fermé : encore ouvert en début de nuit, puis fermé', () => {
      // Samedi 22:00-02:00, dimanche fermé.
      const horaires: Horaires = [{ '6': '22:00-02:00' }, { '7': 'Fermé' }];
      expect(ouvert(horaires, le(29, 1, 0))).toBe(true);
      expect(ouvert(horaires, le(29, 3, 0))).toBe(false);
      expect(ouvert(horaires, le(29, 23, 0))).toBe(false);
    });

    it('veille fermée : pas ouvert en début de nuit, même si le jour ouvre tard', () => {
      // Dimanche fermé, lundi 22:00-02:00.
      const horaires: Horaires = [{ '7': 'Fermé' }, { '1': '22:00-02:00' }];
      expect(ouvert(horaires, le(30, 1, 0))).toBe(false);
      expect(ouvert(horaires, le(30, 22, 30))).toBe(true);
    });

    it('veille dans la journée seulement : rien ne déborde', () => {
      const horaires: Horaires = [{ '5': '10:00-22:00' }, { '6': '10:00-22:00' }];
      expect(ouvert(horaires, le(28, 1, 0))).toBe(false);
    });
  });

  describe('plusieurs créneaux, jours fermés, horaires absents', () => {
    it('deux créneaux dans la journée', () => {
      const horaires = tousLesJours('08:00-12:00,14:00-22:00');
      expect(ouvert(horaires, le(27, 9, 0))).toBe(true);
      expect(ouvert(horaires, le(27, 13, 0))).toBe(false);
      expect(ouvert(horaires, le(27, 15, 0))).toBe(true);
    });

    it('un créneau du soir qui déborde, après un créneau du midi', () => {
      const horaires = tousLesJours('11:00-15:00,19:00-01:00');
      expect(ouvert(horaires, le(28, 0, 30))).toBe(true);
      expect(ouvert(horaires, le(28, 16, 0))).toBe(false);
    });

    it('jour marqué fermé, jour absent, horaires absents ou illisibles : fermé', () => {
      expect(ouvert([{ '5': 'Fermé' }], le(27, 14, 0))).toBe(false);
      expect(ouvert([{ '5': 'closed' }], le(27, 14, 0))).toBe(false);
      expect(ouvert([{ '1': '10:00-22:00' }], le(27, 14, 0))).toBe(false);
      expect(ouvert([], le(27, 14, 0))).toBe(false);
      expect(ouvert(null as never, le(27, 14, 0))).toBe(false);
      expect(ouvert([{ '5': 'midi-soir' }], le(27, 14, 0))).toBe(false);
      expect(ouvert([{ '5': '25:00-26:00' }], le(27, 14, 0))).toBe(false);
    });

    it('ouvert toute la journée (« 00:00-23:59 »)', () => {
      const horaires = tousLesJours('00:00-23:59');
      expect(ouvert(horaires, le(27, 0, 0))).toBe(true);
      expect(ouvert(horaires, le(27, 23, 59))).toBe(true);
    });
  });
});
