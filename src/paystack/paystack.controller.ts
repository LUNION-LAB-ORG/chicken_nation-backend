import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  Put,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { Queue } from 'bullmq';
import { isUUID } from 'class-validator';
import type { Request, Response } from 'express';
import { PrismaService } from 'src/database/services/prisma.service';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { SettingsService } from 'src/modules/settings/settings.service';
import { CLES_PAIEMENT_EN_LIGNE, PaiementEnLigneService } from './paiement-en-ligne.service';
import { ErreurPaystack } from './paystack-http';
import { ipAutorisee, signatureAncienneValide, signatureNouvelleValide } from './paystack-signature';
import {
  IP_WEBHOOK_PAYSTACK,
  REFERENCE_TENTATIVE,
  TAUX_FRAIS_MAX,
  messageSousCompte,
  motifSousCompteInutilisable,
} from './paystack.rules';
import { CLES_PAYSTACK, PaystackService } from './paystack.service';
import { TravailWebhookPaystack } from './paystack-webhook.consumer';
import { lienRetourAppli } from './retour-paiement.rules';

/**
 * PAYSTACK (25/11) : webhook public, page de retour après paiement, et écran
 * d'administration (réglages, sous-comptes des restaurants).
 */
@Controller('paystack')
export class PaystackController {
  private readonly logger = new Logger(PaystackController.name);

  constructor(
    private readonly paystack: PaystackService,
    private readonly paiementEnLigne: PaiementEnLigneService,
    private readonly settings: SettingsService,
    private readonly prisma: PrismaService,
    @InjectQueue('paystack-webhooks') private readonly file: Queue<TravailWebhookPaystack>,
  ) {}

  /**
   * Webhook Paystack. Ordre : IP (si le contrôle est activé) → 403 ; aucune
   * clé ni secret → 503 (Paystack réessaiera) ; signature → 401 ; corps
   * illisible → 400 ; événement sans objet, référence étrangère, mode
   * différent de la clé → 200 ignoré ; sinon enfilé, 200 tout de suite.
   * Adresse à déclarer chez Paystack : https://<api>/api/v1/paystack/webhook
   */
  @Post('webhook')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('paystack-signature') signatureNouvelle?: string,
    @Headers('x-paystack-signature') signatureAncienne?: string,
  ): Promise<{ recu: true }> {
    if (process.env.PAYSTACK_CONTROLE_IP === 'true' && !ipAutorisee(req.ip, IP_WEBHOOK_PAYSTACK)) {
      throw new HttpException('Origine non autorisée.', HttpStatus.FORBIDDEN);
    }
    const config = await this.paystack.config();
    if (!config.cle && !config.secretsWebhook.length) {
      throw new HttpException("Paystack n'est pas configuré.", HttpStatus.SERVICE_UNAVAILABLE);
    }
    const brut = req.rawBody?.toString('utf8') ?? '';
    const valide =
      signatureNouvelleValide(brut, signatureNouvelle, config.secretsWebhook, Math.floor(Date.now() / 1000)) ||
      signatureAncienneValide(brut, signatureAncienne, config.cle ? [config.cle] : []);
    if (!valide) {
      this.logger.warn('Webhook Paystack : signature invalide, refusé.');
      throw new HttpException('Signature invalide.', HttpStatus.UNAUTHORIZED);
    }
    let evenement: { event?: unknown; data?: Record<string, unknown> };
    try {
      evenement = JSON.parse(brut);
    } catch {
      throw new BadRequestException('Corps illisible.');
    }
    const type = typeof evenement?.event === 'string' ? evenement.event.slice(0, 60) : '';
    const data = evenement?.data && typeof evenement.data === 'object' ? evenement.data : {};
    const reference =
      type === 'charge.success' ? data.reference : type.startsWith('refund.') ? data.transaction_reference : undefined;
    if (typeof reference !== 'string' || !REFERENCE_TENTATIVE.test(reference)) return { recu: true };
    if (data.domain !== config.mode) {
      this.logger.error(`Webhook Paystack d'un autre mode que la clé, ignoré (${type}, ${reference}).`);
      return { recu: true };
    }
    const statut = type.startsWith('refund.') && typeof data.status === 'string' ? data.status : undefined;
    const jobId = `${type}_${reference}${statut ? `_${statut}` : ''}`.replace(/[^A-Za-z0-9_.-]/g, '_');
    try {
      await this.file.add('evenement', { type, reference, statut }, { jobId });
    } catch (e) {
      // File indisponible : 503, Paystack réessaiera (jamais 200 sur une perte).
      this.logger.error(`Webhook Paystack non enfilé (${type}, ${reference}) : ${(e as Error).message}`);
      throw new HttpException('Indisponible, réessayez.', HttpStatus.SERVICE_UNAVAILABLE);
    }
    return { recu: true };
  }

  /**
   * Retour du client après la page de paiement (callback_url) : renvoie vers
   * l'appli (lien profond validé), qui ferme la page et vérifie le paiement.
   * Page lisible si l'appli ne s'ouvre pas.
   */
  @Get('retour')
  @ApiExcludeEndpoint()
  retour(@Query('vers') vers: string | undefined, @Query('reference') reference: string | undefined, @Res() res: Response) {
    const ref = typeof reference === 'string' && REFERENCE_TENTATIVE.test(reference) ? reference : '';
    const lien = lienRetourAppli(vers, ref);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (lien) res.setHeader('Refresh', `0;url=${lien}`);
    const bouton = lien ? `<p><a href="${lien.replace(/"/g, '&quot;')}" style="display:inline-block;padding:14px 22px;border-radius:12px;background:#F17922;color:#fff;text-decoration:none;font-weight:600">Revenir à l'application</a></p>` : '';
    res.status(lien ? 302 : 200);
    if (lien) res.setHeader('Location', lien);
    res.send(
      `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Paiement</title></head>` +
        `<body style="font-family:system-ui,sans-serif;text-align:center;padding:48px 16px;color:#1a1a1a">` +
        `<h1 style="font-size:20px">Paiement terminé</h1><p>Revenez à l'application Chicken Nation pour suivre votre commande.</p>${bouton}</body></html>`,
    );
  }

  // ---------------------------------------------------------------------------
  // Administration
  // ---------------------------------------------------------------------------

  /** État de la configuration : réglages, clé, adresse du webhook, sous-compte de chaque restaurant. */
  @Get('configuration')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.SETTINGS, Action.READ)
  async configuration(@Query('relire') relire?: string) {
    if (relire === '1') this.paiementEnLigne.invaliderCache();
    const [reglages, config, restaurants] = await Promise.all([
      this.paiementEnLigne.reglages(),
      this.paystack.config(),
      this.prisma.restaurant.findMany({
        where: { entity_status: { not: 'DELETED' } },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    const codes = await this.paystack.codesSousComptes(restaurants.map((r) => r.id));
    const lignes = await Promise.all(
      restaurants.map(async (r) => {
        const code = codes[r.id];
        if (!code) return { id: r.id, nom: r.name, sous_compte: null, utilisable: false, motif: 'Aucun sous-compte relié.' };
        if (!config.cle) return { id: r.id, nom: r.name, sous_compte: { code }, utilisable: false, motif: "Clé secrète Paystack absente." };
        try {
          const s = await this.paystack.lireSousCompte(code, { frais: relire === '1' });
          const motif = motifSousCompteInutilisable(s, config.frais.supplement);
          return {
            id: r.id,
            nom: r.name,
            sous_compte: s ? { ...s } : { code },
            utilisable: !motif,
            motif: motif ? messageSousCompte(motif, s, config.frais.supplement) : null,
          };
        } catch (e) {
          return { id: r.id, nom: r.name, sous_compte: { code }, utilisable: false, motif: messageErreur(e) };
        }
      }),
    );
    return {
      en_ligne_actif: reglages.actif,
      fournisseur: reglages.fournisseur,
      paystack: {
        cle_configuree: !!config.cle,
        mode: config.mode,
        secret_webhook_configure: config.secretsWebhook.length > 0,
        webhook_path: '/api/v1/paystack/webhook',
      },
      // Frais ajoutés au client, en pourcentage : taux du moyen + supplément.
      frais: {
        mobile_money: config.frais.mobileMoney,
        carte: config.frais.carte,
        supplement: config.frais.supplement,
      },
      restaurants: lignes,
    };
  }

  /** Sous-comptes du compte Paystack, pour les relier aux restaurants. */
  @Get('sous-comptes')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.SETTINGS, Action.READ)
  async sousComptes() {
    try {
      const [liste, { frais }] = await Promise.all([this.paystack.listerSousComptes(), this.paystack.config()]);
      return liste.map((s) => {
        const motif = motifSousCompteInutilisable(s, frais.supplement);
        return { ...s, utilisable: !motif, motif: motif ? messageSousCompte(motif, s, frais.supplement) : null };
      });
    } catch (e) {
      throw new BadRequestException(messageErreur(e));
    }
  }

  /**
   * Relie (ou délie, `code` vide) le sous-compte d'un restaurant. Le
   * sous-compte est lu chez Paystack : un sous-compte inconnu, inactif ou qui
   * laisse une part au compte principal est refusé.
   */
  @Put('restaurants/:id/sous-compte')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.SETTINGS, Action.UPDATE)
  async relierSousCompte(@Param('id') id: string, @Body() body: { code?: string | null }) {
    if (!isUUID(id)) throw new BadRequestException('Restaurant invalide.');
    const restaurant = await this.prisma.restaurant.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!restaurant) throw new BadRequestException('Restaurant introuvable.');
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!code) {
      await this.settings.set(CLES_PAYSTACK.sousCompte(id), '', `Sous-compte Paystack de ${restaurant.name}`);
      this.paiementEnLigne.invaliderCache();
      return { id, sous_compte: null };
    }
    if (!/^ACCT_[A-Za-z0-9]{4,}$/.test(code)) throw new BadRequestException('Code de sous-compte invalide (ACCT_…).');
    let s;
    try {
      s = await this.paystack.lireSousCompte(code, { frais: true });
    } catch (e) {
      throw new BadRequestException(messageErreur(e));
    }
    const partMax = (await this.paystack.config()).frais.supplement;
    const motif = motifSousCompteInutilisable(s, partMax);
    if (motif) throw new BadRequestException(messageSousCompte(motif, s, partMax));
    await this.settings.set(CLES_PAYSTACK.sousCompte(id), code, `Sous-compte Paystack de ${restaurant.name}`);
    this.paiementEnLigne.invaliderCache();
    return { id, sous_compte: s };
  }

  /**
   * Interrupteur et prestataire du paiement en ligne (appli et site), et
   * frais Paystack ajoutés au client (pourcentages de 0 à 20, deux décimales).
   */
  @Put('reglages')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.SETTINGS, Action.UPDATE)
  async reglages(
    @Body()
    body: {
      en_ligne_actif?: boolean;
      fournisseur?: string;
      frais?: { mobile_money?: unknown; carte?: unknown; supplement?: unknown };
    },
  ) {
    if (body?.frais && typeof body.frais === 'object') {
      const champs: [unknown, string, string][] = [
        [body.frais.mobile_money, CLES_PAYSTACK.fraisMobileMoney, 'Paystack · frais Mobile Money (%)'],
        [body.frais.carte, CLES_PAYSTACK.fraisCarte, 'Paystack · frais carte bancaire (%)'],
        [body.frais.supplement, CLES_PAYSTACK.fraisSupplement, 'Paystack · supplément (%)'],
      ];
      for (const [valeur, cle, description] of champs) {
        if (valeur === undefined) continue;
        const t = typeof valeur === 'number' ? valeur : Number(String(valeur).replace(',', '.'));
        if (!Number.isFinite(t) || t < 0 || t > TAUX_FRAIS_MAX) {
          throw new BadRequestException(`Taux invalide : un pourcentage entre 0 et ${TAUX_FRAIS_MAX}.`);
        }
        await this.settings.set(cle, String(Math.round(t * 100) / 100), description);
      }
    }
    if (typeof body?.en_ligne_actif === 'boolean') {
      await this.settings.set(CLES_PAIEMENT_EN_LIGNE.actif, body.en_ligne_actif ? 'true' : 'false', 'Paiement en ligne (appli et site)');
    }
    if (body?.fournisseur !== undefined) {
      if (body.fournisseur !== 'kkiapay' && body.fournisseur !== 'paystack') {
        throw new BadRequestException('Prestataire inconnu.');
      }
      await this.settings.set(CLES_PAIEMENT_EN_LIGNE.fournisseur, body.fournisseur, 'Prestataire du paiement en ligne');
    }
    this.paiementEnLigne.invaliderCache();
    const [reglages, config] = await Promise.all([this.paiementEnLigne.reglages(), this.paystack.config()]);
    return {
      ...reglages,
      frais: { mobile_money: config.frais.mobileMoney, carte: config.frais.carte, supplement: config.frais.supplement },
    };
  }
}

function messageErreur(e: unknown): string {
  if (e instanceof ErreurPaystack) {
    if (e.nature === 'NON_CONFIGURE') return "Clé secrète Paystack absente ou invalide.";
    if (e.nature === 'INJOIGNABLE') return 'Paystack ne répond pas. Réessayez dans un instant.';
    if (e.nature === 'INTROUVABLE') return 'Inconnu chez Paystack.';
    return e.messagePaystack ? `Paystack refuse : ${e.messagePaystack}` : 'Paystack refuse la demande.';
  }
  return 'Erreur inattendue.';
}
