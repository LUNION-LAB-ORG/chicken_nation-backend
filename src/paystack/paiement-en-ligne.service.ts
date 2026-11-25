import { BadRequestException, Injectable } from '@nestjs/common';
import { SettingsService } from 'src/modules/settings/settings.service';
import { PaystackService } from './paystack.service';

/** Réglages du back-office (table settings). */
export const CLES_PAIEMENT_EN_LIGNE = {
  actif: 'paiement_en_ligne_actif',
  fournisseur: 'paiement_fournisseur',
} as const;

export type Fournisseur = 'kkiapay' | 'paystack';

export interface ReglagesPaiementEnLigne {
  actif: boolean;
  fournisseur: Fournisseur;
}

export type MotifIndisponible = 'DESACTIVE' | 'MISE_A_JOUR' | 'RESTAURANT' | 'NON_CONFIGURE';

export interface DisponibilitePaiementEnLigne {
  disponible: boolean;
  fournisseur: Fournisseur;
  motif: MotifIndisponible | null;
  message: string | null;
}

/**
 * Messages pour le client, valables dans l'appli (où tout se paie en ligne)
 * comme sur le site (qui propose à part le paiement à la livraison).
 */
export const MESSAGES_INDISPONIBLE: Record<MotifIndisponible, string> = {
  DESACTIVE: 'Le paiement en ligne est momentanément indisponible. Réessayez un peu plus tard.',
  NON_CONFIGURE: 'Le paiement en ligne est momentanément indisponible. Réessayez un peu plus tard.',
  MISE_A_JOUR: "Mettez à jour l'application pour payer en ligne.",
  RESTAURANT: "Le paiement en ligne n'est pas encore disponible pour ce restaurant.",
};

/** Réglages lus en texte ; tout ce qui n'est pas reconnu garde le comportement d'avant (activé, KKiaPay). */
export function lireReglages(valeurs: Record<string, string | undefined>): ReglagesPaiementEnLigne {
  const actifBrut = (valeurs[CLES_PAIEMENT_EN_LIGNE.actif] ?? '').trim().toLowerCase();
  const fournisseurBrut = (valeurs[CLES_PAIEMENT_EN_LIGNE.fournisseur] ?? '').trim().toLowerCase();
  return {
    actif: !['false', '0', 'non', 'off'].includes(actifBrut),
    fournisseur: fournisseurBrut === 'paystack' ? 'paystack' : 'kkiapay',
  };
}

/**
 * L'appli ou le site sait-il payer par Paystack ? Il l'annonce par l'en-tête
 * `x-app-paiements` (liste séparée par des virgules). Les versions d'avant
 * Paystack ne l'envoient pas.
 */
export function compatiblePaystack(entete: string | string[] | undefined): boolean {
  const v = Array.isArray(entete) ? entete.join(',') : entete ?? '';
  return v
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .includes('paystack');
}

/** Verdict pur, une fois les réglages et l'état du sous-compte connus. */
export function verdictDisponibilite(params: {
  reglages: ReglagesPaiementEnLigne;
  compatiblePaystack: boolean;
  /** Paystack : clé secrète valable. */
  paystackConfigure: boolean;
  /** Paystack : sous-compte du restaurant utilisable ; null si aucun restaurant n'est encore connu. */
  sousCompteUtilisable: boolean | null;
}): DisponibilitePaiementEnLigne {
  const { reglages } = params;
  const indisponible = (motif: MotifIndisponible): DisponibilitePaiementEnLigne => ({
    disponible: false,
    fournisseur: reglages.fournisseur,
    motif,
    message: MESSAGES_INDISPONIBLE[motif],
  });
  if (!reglages.actif) return indisponible('DESACTIVE');
  if (reglages.fournisseur === 'paystack') {
    if (!params.compatiblePaystack) return indisponible('MISE_A_JOUR');
    if (!params.paystackConfigure) return indisponible('NON_CONFIGURE');
    if (params.sousCompteUtilisable === false) return indisponible('RESTAURANT');
  }
  return { disponible: true, fournisseur: reglages.fournisseur, motif: null, message: null };
}

/**
 * PAIEMENT EN LIGNE (25/11) : interrupteur et prestataire réglés au
 * back-office, valables pour l'appli et le site. Paystack choisi : seul un
 * restaurant dont le sous-compte est utilisable encaisse en ligne (jamais le
 * compte principal), et seules les versions qui savent payer par Paystack.
 */
@Injectable()
export class PaiementEnLigneService {
  private enCache: { valeur: ReglagesPaiementEnLigne; expire: number } | null = null;

  constructor(
    private readonly settings: SettingsService,
    private readonly paystack: PaystackService,
  ) {}

  invaliderCache(): void {
    this.enCache = null;
    this.paystack.invaliderCache();
  }

  async reglages(): Promise<ReglagesPaiementEnLigne> {
    const maintenant = Date.now();
    if (this.enCache && this.enCache.expire > maintenant) return this.enCache.valeur;
    const valeur = lireReglages(
      await this.settings.getMany([CLES_PAIEMENT_EN_LIGNE.actif, CLES_PAIEMENT_EN_LIGNE.fournisseur]),
    );
    this.enCache = { valeur, expire: maintenant + 30_000 };
    return valeur;
  }

  async disponibilite(params: {
    restaurantId: string | null;
    compatiblePaystack: boolean;
  }): Promise<DisponibilitePaiementEnLigne> {
    const reglages = await this.reglages();
    let paystackConfigure = false;
    let sousCompteUtilisable: boolean | null = null;
    if (reglages.actif && reglages.fournisseur === 'paystack' && params.compatiblePaystack) {
      paystackConfigure = !!(await this.paystack.config()).cle;
      if (paystackConfigure && params.restaurantId) {
        const { code, motif } = await this.paystack.sousCompteUtilisable(params.restaurantId);
        sousCompteUtilisable = !!code && !motif;
      }
    }
    return verdictDisponibilite({ reglages, compatiblePaystack: params.compatiblePaystack, paystackConfigure, sousCompteUtilisable });
  }

  /** Refuse (400, message pour le client) une commande à payer en ligne qui ne peut pas l'être. */
  async exigerDisponible(params: { restaurantId: string | null; compatiblePaystack: boolean }): Promise<DisponibilitePaiementEnLigne> {
    const d = await this.disponibilite(params);
    if (!d.disponible) throw new BadRequestException(d.message);
    return d;
  }
}
