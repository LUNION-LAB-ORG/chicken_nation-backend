import { IgnorerRelanceDto } from './ignorer-relance.dto';

/**
 * Corps de `POST /orders/relances/:orderId/annuler` (19/10) : les mêmes
 * raisons que pour ignorer, « Autre » avec un texte. Annule une commande du
 * site à payer à la livraison que le centre d'appels ne confirmera pas.
 */
export class AnnulerRelanceDto extends IgnorerRelanceDto {}
