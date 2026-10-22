/**
 * Réglage `deliverer.hors_service_sans_signal_min` : 0 coupe le filet et doit
 * être ACCEPTÉ (le `toNumber` du module course, lui, refuse 0).
 */
import { DelivererScoringSettingsHelper } from './deliverer-scoring-settings.helper';

const charger = async (valeur: string | undefined) => {
  const helper = new DelivererScoringSettingsHelper({
    getMany: jest.fn(async () =>
      valeur === undefined ? {} : { 'deliverer.hors_service_sans_signal_min': valeur },
    ),
  } as never);
  return (await helper.load()).horsServiceSansSignalMin;
};

describe('deliverer.hors_service_sans_signal_min', () => {
  it('absent : 20 minutes', async () => {
    expect(await charger(undefined)).toBe(20);
  });

  it('0 : accepté (filet coupé)', async () => {
    expect(await charger('0')).toBe(0);
  });

  it('valeur réglée : prise telle quelle', async () => {
    expect(await charger('45')).toBe(45);
  });

  it('négatif ou illisible : 20 minutes', async () => {
    expect(await charger('-5')).toBe(20);
    expect(await charger('vingt')).toBe(20);
  });
});
