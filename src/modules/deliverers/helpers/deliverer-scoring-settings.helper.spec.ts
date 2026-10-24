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

/** Réglage `deliverer.appli_fermee_apres_s` (demande du 24/10) : 0 coupe la règle de l'appli fermée. */
describe('deliverer.appli_fermee_apres_s', () => {
  const lire = async (valeur: string | undefined) => {
    const helper = new DelivererScoringSettingsHelper({
      getMany: jest.fn(async () => (valeur === undefined ? {} : { 'deliverer.appli_fermee_apres_s': valeur })),
    } as never);
    return (await helper.load()).appliFermeeApresS;
  };

  it('absent : 180 secondes', async () => {
    expect(await lire(undefined)).toBe(180);
  });

  it('0 : accepté (règle coupée)', async () => {
    expect(await lire('0')).toBe(0);
  });

  it('valeur réglée : prise telle quelle', async () => {
    expect(await lire('300')).toBe(300);
  });

  it('négatif ou illisible : 180 secondes', async () => {
    expect(await lire('-1')).toBe(180);
    expect(await lire('trois minutes')).toBe(180);
  });

  it('la clé est lue avec les autres réglages des livreurs', async () => {
    const getMany = jest.fn(async () => ({}));
    await new DelivererScoringSettingsHelper({ getMany } as never).load();
    expect((getMany.mock.calls[0] as unknown as [string[]])[0]).toContain('deliverer.appli_fermee_apres_s');
  });
});
