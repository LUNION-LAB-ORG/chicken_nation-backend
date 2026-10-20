/**
 * Moyen de paiement absent ou inconnu à la création d'une commande : refus
 * en français, le texte que le site affiche. Recette du 20/10 : la réponse
 * était « payment_method must be one of the following values… », et le refus
 * prévu par `OrderService` (« Choisissez un moyen de paiement. ») n'était
 * jamais atteint.
 */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OrderCreateDto } from './order-create.dto';
import { REFUS_PAIEMENT_SITE } from '../helpers/paiement-livraison.rules';

const messagesPaiement = async (corps: object) =>
  (await validate(plainToInstance(OrderCreateDto, corps) as object, { forbidUnknownValues: false }))
    .filter((e) => e.property === 'payment_method')
    .flatMap((e) => Object.values(e.constraints ?? {}));

describe('moyen de paiement de la commande', () => {
  it('absent ou inconnu : « Choisissez un moyen de paiement. »', async () => {
    for (const corps of [{ type: 'DELIVERY' }, { type: 'DELIVERY', payment_method: 'CASH' }, { type: 'DELIVERY', payment_method: null }]) {
      expect(await messagesPaiement(corps)).toEqual([REFUS_PAIEMENT_SITE.moyenAbsent]);
    }
  });

  it('en ligne ou à la livraison : accepté', async () => {
    for (const payment_method of ['ONLINE', 'OFFLINE']) {
      expect(await messagesPaiement({ type: 'DELIVERY', payment_method })).toEqual([]);
    }
  });
});
