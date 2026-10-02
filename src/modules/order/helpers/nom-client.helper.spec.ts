/**
 * Nom inscrit sur une commande : jamais « null null ».
 *
 * Signalement du 02/10 : un client du site sans prénom ni nom (étape « nom »
 * sautée par un rechargement) commandait au nom de « null null », que
 * voyaient la caisse, le livreur et Turbo.
 */

import { Customer, EntityStatus } from '@prisma/client';
import { nomSurLaCommande } from './nom-client.helper';
import { OrderHelper } from './order.helper';
import { OrderV2Helper } from './orderv2.helper';

const TELEPHONE = '+2250700000000';

describe('nomSurLaCommande', () => {
  it('garde le nom saisi pour la commande, sans ses espaces', () => {
    expect(nomSurLaCommande('  Awa Koné ', { first_name: 'Autre', last_name: 'Nom' }, TELEPHONE)).toBe('Awa Koné');
  });

  it('sans nom saisi, reprend le prénom et le nom du profil', () => {
    expect(nomSurLaCommande(undefined, { first_name: 'Awa', last_name: 'Koné' }, TELEPHONE)).toBe('Awa Koné');
    expect(nomSurLaCommande('', { first_name: 'Awa', last_name: 'Koné' }, TELEPHONE)).toBe('Awa Koné');
    expect(nomSurLaCommande('   ', { first_name: 'Awa', last_name: 'Koné' }, TELEPHONE)).toBe('Awa Koné');
  });

  it('profil incomplet : seulement la partie connue, jamais « null »', () => {
    expect(nomSurLaCommande('', { first_name: 'Awa', last_name: null }, TELEPHONE)).toBe('Awa');
    expect(nomSurLaCommande('', { first_name: null, last_name: 'Koné' }, TELEPHONE)).toBe('Koné');
    expect(nomSurLaCommande('', { first_name: ' ', last_name: 'Koné ' }, TELEPHONE)).toBe('Koné');
  });

  it('ni nom saisi ni profil : le téléphone de la commande', () => {
    expect(nomSurLaCommande('', { first_name: null, last_name: null }, TELEPHONE)).toBe(TELEPHONE);
    expect(nomSurLaCommande(null, {}, TELEPHONE)).toBe(TELEPHONE);
  });

  it('rien du tout : chaîne vide, jamais « null » ni « undefined »', () => {
    expect(nomSurLaCommande(undefined, {}, undefined)).toBe('');
  });

  it('nom reçu déjà recollé avec des valeurs vides : « null null » ne compte pas', () => {
    // `${client.first_name} ${client.last_name}` avec un profil vide.
    expect(nomSurLaCommande('null null', { first_name: null, last_name: null }, TELEPHONE)).toBe(TELEPHONE);
    expect(nomSurLaCommande('undefined undefined', {}, TELEPHONE)).toBe(TELEPHONE);
    expect(nomSurLaCommande(' NULL  Null ', { first_name: 'Awa', last_name: 'Koné' }, TELEPHONE)).toBe('Awa Koné');
  });

  it('nom recollé à moitié : seule la partie connue reste', () => {
    expect(nomSurLaCommande('Awa null', {}, TELEPHONE)).toBe('Awa');
    expect(nomSurLaCommande('null Koné', {}, TELEPHONE)).toBe('Koné');
    expect(nomSurLaCommande('', { first_name: 'null', last_name: 'Koné' }, TELEPHONE)).toBe('Koné');
  });

  it('un nom composé garde ses morceaux, espaces en trop retirés', () => {
    expect(nomSurLaCommande('  Marie   Ange  Kouassi ', {}, TELEPHONE)).toBe('Marie Ange Kouassi');
    // Un morceau qui CONTIENT « null » n'est pas un morceau vide.
    expect(nomSurLaCommande('Nullard', {}, TELEPHONE)).toBe('Nullard');
  });
});

/** Client créé à la vérification du code : téléphone seul, sans nom. */
const clientSansNom = {
  id: 'c1',
  phone: TELEPHONE,
  email: null,
  first_name: null,
  last_name: null,
  loyalty_level: null,
  total_points: 0,
  entity_status: EntityStatus.ACTIVE,
  notification_settings: null,
} as unknown as Customer;

const prismaAvec = (client: Customer) => ({
  customer: { findFirst: jest.fn().mockResolvedValue(client) },
});

describe('resolveCustomerData : client sans prénom ni nom', () => {
  it('createv2 (application, site) : nom vide → téléphone, pas « null null »', async () => {
    const helper = Object.create(OrderV2Helper.prototype) as OrderV2Helper;
    Object.assign(helper, { prisma: prismaAvec(clientSansNom) });

    const donnees = await helper.resolveCustomerData({ customer_id: 'c1', fullname: '' });

    expect(donnees.fullname).toBe(TELEPHONE);
    expect(donnees.phone).toBe(TELEPHONE);
  });

  it("create (personnel, ancienne route client) : même repli", async () => {
    const helper = Object.create(OrderHelper.prototype) as OrderHelper;
    Object.assign(helper, { prisma: prismaAvec(clientSansNom) });

    const donnees = await helper.resolveCustomerData({ customer_id: 'c1', items: [] } as never);

    expect(donnees.fullname).toBe(TELEPHONE);
  });

  it('createv2 : « null null » reçu → téléphone', async () => {
    const helper = Object.create(OrderV2Helper.prototype) as OrderV2Helper;
    Object.assign(helper, { prisma: prismaAvec(clientSansNom) });

    const donnees = await helper.resolveCustomerData({ customer_id: 'c1', fullname: 'null null' });

    expect(donnees.fullname).toBe(TELEPHONE);
  });

  it('le téléphone saisi pour la commande sert de repli, avant celui du compte', async () => {
    const helper = Object.create(OrderV2Helper.prototype) as OrderV2Helper;
    Object.assign(helper, { prisma: prismaAvec(clientSansNom) });

    const donnees = await helper.resolveCustomerData({ customer_id: 'c1', phone: '+2250500000000' });

    expect(donnees.fullname).toBe('+2250500000000');
  });
});
