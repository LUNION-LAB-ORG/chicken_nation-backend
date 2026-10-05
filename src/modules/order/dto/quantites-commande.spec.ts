/**
 * Quantités des lignes de commande : entiers d'au moins 1, plafonnés.
 * Une quantité de supplément négative ou décimale (-3, 0,01) faisait baisser
 * le prix de la commande, le serveur multipliant prix x quantité.
 */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OrderItemDto, QUANTITE_MAX_LIGNE, SupplementItemDto } from './order-create.dto';
import { CreateOrderItemDto, SupplementItemBackofficeDto } from './create-order-item.dto';

const PLAT = '11111111-1111-4111-8111-111111111111';
const SUPP = '22222222-2222-4222-8222-222222222222';

const erreursQuantite = async (classe: any, corps: object) =>
  (await validate(plainToInstance(classe, corps) as object, { forbidUnknownValues: false }))
    .filter((e) => e.property === 'quantity');

describe('quantités des lignes de commande', () => {
  it.each([
    ['client (OrderItemDto)', OrderItemDto],
    ['personnel (CreateOrderItemDto)', CreateOrderItemDto],
  ])('plat, %s : entier de 1 au plafond', async (_nom, classe) => {
    for (const ok of [1, 2, 50, QUANTITE_MAX_LIGNE, '3']) {
      expect(await erreursQuantite(classe, { dish_id: PLAT, quantity: ok })).toHaveLength(0);
    }
    for (const ko of [0, -3, 0.01, 1.5, QUANTITE_MAX_LIGNE + 1, 'abc', null]) {
      expect(await erreursQuantite(classe, { dish_id: PLAT, quantity: ko })).not.toHaveLength(0);
    }
  });

  it.each([
    ['client (SupplementItemDto)', SupplementItemDto],
    ['personnel (SupplementItemBackofficeDto)', SupplementItemBackofficeDto],
  ])('supplément, %s : entier de 1 au plafond', async (_nom, classe) => {
    for (const ok of [1, 4, '2']) {
      expect(await erreursQuantite(classe, { id: SUPP, quantity: ok })).toHaveLength(0);
    }
    for (const ko of [0, -3, 0.01, 2.5, QUANTITE_MAX_LIGNE + 1, 'x']) {
      expect(await erreursQuantite(classe, { id: SUPP, quantity: ko })).not.toHaveLength(0);
    }
  });

  it('une ligne avec un supplément en quantité négative est refusée en entier', async () => {
    const ligne = plainToInstance(OrderItemDto, { dish_id: PLAT, quantity: 1, supplements: [{ id: SUPP, quantity: -3 }] });
    const erreurs = await validate(ligne as object, { forbidUnknownValues: false });
    expect(erreurs.some((e) => e.property === 'supplements')).toBe(true);
  });
});
