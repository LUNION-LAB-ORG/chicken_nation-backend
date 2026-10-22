/**
 * Journée de service : de 05 h 00 à 05 h 00 le lendemain, heure d'Abidjan
 * (= UTC). Les dates des tests sont écrites en UTC : le résultat ne dépend
 * pas du fuseau de la machine.
 */
import { HEURE_DEBUT_JOURNEE_SERVICE, journeeDeService } from './journee-service.rules';

const iso = (j: { debut: Date; fin: Date }) => [j.debut.toISOString(), j.fin.toISOString()];

describe('journeeDeService', () => {
  it('commence à 5 h', () => {
    expect(HEURE_DEBUT_JOURNEE_SERVICE).toBe(5);
  });

  it('05 h 00 pile : la nouvelle journée commence', () => {
    expect(iso(journeeDeService(new Date('2026-10-22T05:00:00.000Z')))).toEqual([
      '2026-10-22T05:00:00.000Z',
      '2026-10-23T05:00:00.000Z',
    ]);
  });

  it('04 h 59 : encore la journée de la veille', () => {
    expect(iso(journeeDeService(new Date('2026-10-22T04:59:59.999Z')))).toEqual([
      '2026-10-21T05:00:00.000Z',
      '2026-10-22T05:00:00.000Z',
    ]);
  });

  it('minuit : encore la journée de la veille', () => {
    expect(iso(journeeDeService(new Date('2026-10-22T00:00:00.000Z')))).toEqual([
      '2026-10-21T05:00:00.000Z',
      '2026-10-22T05:00:00.000Z',
    ]);
  });

  it('0 h 40, après le dernier service : même journée que 23 h la veille', () => {
    const tard = journeeDeService(new Date('2026-10-21T23:00:00.000Z'));
    const apresMinuit = journeeDeService(new Date('2026-10-22T00:40:00.000Z'));
    expect(iso(apresMinuit)).toEqual(iso(tard));
  });

  it('midi et 23 h 59 : la journée du jour', () => {
    const attendu = ['2026-10-22T05:00:00.000Z', '2026-10-23T05:00:00.000Z'];
    expect(iso(journeeDeService(new Date('2026-10-22T12:00:00.000Z')))).toEqual(attendu);
    expect(iso(journeeDeService(new Date('2026-10-22T23:59:59.999Z')))).toEqual(attendu);
  });

  it('nuit du 31 décembre : la journée de la veille passe le changement d\'année', () => {
    expect(iso(journeeDeService(new Date('2027-01-01T03:00:00.000Z')))).toEqual([
      '2026-12-31T05:00:00.000Z',
      '2027-01-01T05:00:00.000Z',
    ]);
  });

  it('nuit du 1er mars : la veille est le 28 février', () => {
    expect(journeeDeService(new Date('2027-03-01T02:00:00.000Z')).debut.toISOString()).toBe(
      '2027-02-28T05:00:00.000Z',
    );
  });

  it('dure toujours 24 h', () => {
    for (const instant of ['2026-10-22T04:59:00Z', '2026-10-22T05:00:00Z', '2026-10-22T18:30:00Z']) {
      const { debut, fin } = journeeDeService(new Date(instant));
      expect(fin.getTime() - debut.getTime()).toBe(24 * 60 * 60 * 1000);
    }
  });
});
