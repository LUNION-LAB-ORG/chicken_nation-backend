import { Injectable } from '@nestjs/common';
import * as PDFDocument from 'pdfkit';
import { LIBELLES_PUBLIC } from '../crm.rules';
import { FichierExport } from './crm-export.service';
import { AnalyticsQueryDto } from '../dto/analytics.dto';
import { CrmAnalyticsService } from './crm-analytics.service';
import { Perimetre } from './crm-passages.query';

/** Un chiffre clé, avec ce qu'il valait sur la période précédente. */
export interface ChiffreCle {
  cle: string;
  libelle: string;
  valeur: number;
  precedent: number;
  /**
   * Variation en pourcentage, ou `null` quand la période précédente était à
   * zéro : une progression calculée depuis zéro est infinie, donc muette.
   * L'écran écrit « nouveau » plutôt qu'un pourcentage qui ne veut rien dire.
   */
  variation: number | null;
  /** Un montant s'affiche en francs, pas comme un décompte. */
  monnaie?: boolean;
}

const JOUR = 86_400_000;
const jour = (d: Date) => d.toISOString().slice(0, 10);

/**
 * RAPPORT D'ACTIVITÉ DU CRM sur une période.
 *
 * Tout était déjà calculé, mais éclaté sur huit points d'entrée : pour se
 * faire une idée il fallait ouvrir huit vues et noter les chiffres. Ce
 * service n'invente aucune requête, il ASSEMBLE les mêmes méthodes que le
 * tableau de bord. C'est délibéré : deux calculs parallèles du même chiffre
 * finissent toujours par diverger, et on passe ensuite des semaines à se
 * demander lequel dit vrai.
 *
 * Il ajoute la seule chose qui manquait vraiment : la COMPARAISON avec la
 * période précédente de même durée. « Savoir si les choses évoluent » ne se
 * lit pas sur un nombre absolu — 87 joints cette semaine ne dit rien tant
 * qu'on ignore que c'était 62 la semaine d'avant.
 */
@Injectable()
export class CrmRapportService {
  constructor(private readonly analytics: CrmAnalyticsService) {}

  /**
   * Bornes de la période et de celle qui la précède immédiatement, de même
   * durée. Sans dates, les sept derniers jours : la lecture hebdomadaire est
   * celle qui répond à « est-ce que ça bouge », le quotidien étant trop
   * bruité et le mensuel trop tardif pour corriger quoi que ce soit.
   */
  private bornes(q: AnalyticsQueryDto) {
    const fin = q.to ? new Date(`${q.to.slice(0, 10)}T00:00:00.000Z`) : new Date(`${jour(new Date())}T00:00:00.000Z`);
    const debut = q.from
      ? new Date(`${q.from.slice(0, 10)}T00:00:00.000Z`)
      : new Date(fin.getTime() - 6 * JOUR);
    const jours = Math.max(1, Math.round((fin.getTime() - debut.getTime()) / JOUR) + 1);
    const finPrecedente = new Date(debut.getTime() - JOUR);
    const debutPrecedent = new Date(finPrecedente.getTime() - (jours - 1) * JOUR);
    return { debut, fin, debutPrecedent, finPrecedente, jours };
  }

  async rapport(q: AnalyticsQueryDto & Perimetre) {
    const { debut, fin, debutPrecedent, finPrecedente, jours } = this.bornes(q);
    const periode = { ...q, from: jour(debut), to: jour(fin) };
    const precedente = { ...q, from: jour(debutPrecedent), to: jour(finPrecedente) };

    const [tendance, tendancePrec, vue, vuePrec, qualite, agents, raisons] = await Promise.all([
      this.analytics.tendance(periode),
      this.analytics.tendance(precedente),
      this.analytics.vueEnsemble(periode),
      this.analytics.vueEnsemble(precedente),
      this.analytics.qualite(periode),
      this.analytics.agents(periode),
      this.analytics.raisons(periode),
    ]);

    const cumul = (serie: { entrees: number; captures: number; appels: number; joints: number; coupons: number; conversions: number }[]) =>
      serie.reduce(
        (a, l) => ({
          entrees: a.entrees + l.entrees,
          captures: a.captures + l.captures,
          appels: a.appels + l.appels,
          joints: a.joints + l.joints,
          coupons: a.coupons + l.coupons,
          conversions: a.conversions + l.conversions,
        }),
        { entrees: 0, captures: 0, appels: 0, joints: 0, coupons: 0, conversions: 0 },
      );

    const a = cumul(tendance.serie);
    const b = cumul(tendancePrec.serie);

    /**
     * Appels et joints par public, cumulés sur la période. C'est la réponse à
     * « combien d'appels sur Glovo contre Yango », que rien ne donnait : la
     * série ventilait les entrées et les ventes, jamais les appels.
     */
    const cumulParPublic = (
      serie: { appels_par_public?: Record<string, number>; joints_par_public?: Record<string, number> }[],
      champ: 'appels_par_public' | 'joints_par_public',
    ) =>
      serie.reduce<Record<string, number>>((acc, l) => {
        for (const [pub, n] of Object.entries(l[champ] ?? {})) acc[pub] = (acc[pub] ?? 0) + n;
        return acc;
      }, {});

    const appelsPublic = cumulParPublic(tendance.serie, 'appels_par_public');
    const jointsPublic = cumulParPublic(tendance.serie, 'joints_par_public');
    const appelsPublicPrec = cumulParPublic(tendancePrec.serie, 'appels_par_public');

    const cle = (cle: string, libelle: string, valeur: number, precedent: number, monnaie = false): ChiffreCle => ({
      cle,
      libelle,
      valeur,
      precedent,
      // Depuis zéro, aucune variation n'est calculable : on le dit par `null`.
      variation: precedent > 0 ? Math.round(((valeur - precedent) / precedent) * 1000) / 10 : null,
      ...(monnaie ? { monnaie: true } : {}),
    });

    const cles: ChiffreCle[] = [
      cle('entrees', 'Entrées au CRM', a.entrees, b.entrees),
      cle('captures', 'Relevés en caisse', a.captures, b.captures),
      cle('appels', 'Appels passés', a.appels, b.appels),
      cle('joints', 'Clients joints', a.joints, b.joints),
      cle('coupons', 'Coupons envoyés', a.coupons, b.coupons),
      cle('conversions', 'Conversions', a.conversions, b.conversions),
      cle('ca', "Chiffre d'affaires", vue.conversion.ca_periode, vuePrec.conversion.ca_periode, true),
      cle('panier_moyen', 'Panier moyen', vue.conversion.panier_moyen, vuePrec.conversion.panier_moyen, true),
    ];

    return {
      periode: { debut: jour(debut), fin: jour(fin), jours },
      precedente: { debut: jour(debutPrecedent), fin: jour(finPrecedente) },
      cles,
      /** Taux lus sur la période, avec leur équivalent précédent. */
      taux: {
        contact: { valeur: pct(a.joints, a.appels), precedent: pct(b.joints, b.appels) },
        conversion: { valeur: pct(a.conversions, a.entrees), precedent: pct(b.conversions, b.entrees) },
        coupon_utilise: { valeur: pct(a.conversions, a.coupons), precedent: pct(b.conversions, b.coupons) },
      },
      serie: tendance.serie,
      population: vue.population,
      entonnoir: vue.entonnoir,
      /**
       * Une ligne par public : les appels passés, ceux qui ont décroché, les
       * ventes et le taux. Les appels de la période précédente sont donnés à
       * côté, parce que c'est le seul moyen de savoir si l'effort augmente.
       */
      par_public: vue.entonnoirs.map((e) => ({
        segment: e.segment,
        libelle: e.libelle,
        appels: appelsPublic[e.segment] ?? 0,
        appels_precedent: appelsPublicPrec[e.segment] ?? 0,
        joints: jointsPublic[e.segment] ?? 0,
        ventes: e.ventes,
        taux_conversion: e.taux_conversion,
      })),
      entonnoirs: vue.entonnoirs,
      passage_appli: vue.passage_appli,
      conversion: vue.conversion,
      qualite,
      agents,
      raisons,
    };
  }

  /** Le même rapport, en PDF, avec les filtres appliqués. */
  async pdf(q: AnalyticsQueryDto & Perimetre): Promise<FichierExport> {
    const r = await this.rapport(q);
    const contenu = await this.dessiner(r);
    return {
      nom: `rapport-crm-${r.periode.debut}-${r.periode.fin}.pdf`,
      type: 'application/pdf',
      contenu,
    };
  }

  /**
   * Mise en page volontairement sobre et sans graphique : ce document est lu
   * à l'écran, imprimé, et souvent transmis par message. Un tableau de
   * chiffres lisibles vaut mieux qu'une courbe qui ne survit pas à une
   * photocopie.
   */
  private dessiner(r: Awaited<ReturnType<CrmRapportService['rapport']>>): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 48 });
      const morceaux: Buffer[] = [];
      doc.on('data', (m: Buffer) => morceaux.push(m));
      doc.on('end', () => resolve(Buffer.concat(morceaux)));
      doc.on('error', reject);

      const titre = (t: string) =>
        doc.moveDown(0.8).fillColor('#111827').fontSize(12).text(t, { underline: true }).moveDown(0.3).fontSize(10);
      const ligne = (cle: string, valeur: string) =>
        doc.fillColor('#6B7280').text(`${cle} : `, { continued: true }).fillColor('#111827').text(valeur);

      doc.fillColor('#F17922').fontSize(20).text('Chicken Nation');
      doc.fillColor('#111827').fontSize(16).text("Rapport d'activité du CRM");
      doc
        .fillColor('#6B7280')
        .fontSize(9)
        .text(
          `Du ${jj(r.periode.debut)} au ${jj(r.periode.fin)} (${r.periode.jours} jour${r.periode.jours > 1 ? 's' : ''}) · ` +
            `comparé au ${jj(r.precedente.debut)} – ${jj(r.precedente.fin)}`,
        );
      doc.fillColor('#9CA3AF').fontSize(8).text(`Édité le ${jj(new Date().toISOString().slice(0, 10))}`);

      titre('Chiffres clés');
      for (const c of r.cles) {
        ligne(c.libelle, `${f(c.valeur)}${c.monnaie ? ' F' : ''} — ${variation(c)}`);
      }

      titre('Taux');
      ligne('Contact (joints / appels)', `${pourcent(r.taux.contact.valeur)} (avant ${pourcent(r.taux.contact.precedent)})`);
      ligne('Conversion (conversions / entrées)', `${pourcent(r.taux.conversion.valeur)} (avant ${pourcent(r.taux.conversion.precedent)})`);
      ligne('Coupons utilisés', `${pourcent(r.taux.coupon_utilise.valeur)} (avant ${pourcent(r.taux.coupon_utilise.precedent)})`);

      titre('Par public');
      if (r.par_public.length === 0) doc.text('Aucun public sur la période.');
      for (const e of r.par_public) {
        const avant = e.appels_precedent > 0 ? ` (${f(e.appels_precedent)} avant)` : '';
        ligne(
          nomPublic(e.segment),
          `${f(e.appels)} appel(s)${avant}, ${f(e.joints)} joint(s), ${f(e.ventes)} vente(s), conversion ${pourcent(e.taux_conversion ?? 0)}`,
        );
      }

      titre('État du portefeuille');
      ligne('Contacts ouverts', f(r.population.ouverts));
      ligne('Jamais appelés', f(r.population.jamais_appeles));
      ligne('Non assignés', f(r.population.non_assignes));
      ligne('À rappeler', f(r.population.a_rappeler));
      ligne('Intéressés', f(r.population.interesses));
      ligne('Coupon envoyé', f(r.population.coupons));

      titre('Qualité du traitement');
      ligne('Résolus au premier appel', `${f(r.qualite.resolution_premier_appel.resolus)} sur ${f(r.qualite.resolution_premier_appel.traites)} (${pourcent(r.qualite.resolution_premier_appel.taux)})`);
      ligne('Tentatives moyennes', f(r.qualite.traitement.tentatives_moyennes));
      ligne('Appels par contact', f(r.qualite.traitement.appels_par_contact));
      ligne('Délai médian avant commande', `${f(r.conversion.delai_median_j)} jour(s)`);

      titre('Performance par agent');
      const agents = (r.agents as { lignes?: { fullname: string; traites: number; joints: number; coupons: number; conversions: number; ca: number }[] }).lignes ?? [];
      if (agents.length === 0) doc.text('Aucun agent sur la période.');
      for (const a of agents) {
        doc.text(
          `${a.fullname} : ${f(a.traites)} traité(s), ${f(a.joints)} joint(s), ${f(a.coupons)} coupon(s), ${f(a.conversions)} vente(s), ${f(a.ca)} F`,
        );
      }

      titre('Raisons de non-commande');
      const raisons = (r.raisons as { raisons?: { raison: string; nombre: number }[] }).raisons ?? [];
      if (raisons.length === 0) doc.text('Aucune raison saisie sur la période.');
      for (const x of raisons.slice(0, 10)) doc.text(`${x.raison} : ${f(x.nombre)}`);

      doc.end();
    });
  }
}

/** Pourcentage à une décimale ; `0` plutôt qu'une division par zéro. */
function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

/** Nombre à la française ; « 0 » plutôt qu'un vide. */
const f = (n: number | null | undefined) =>
  n == null ? '0' : new Intl.NumberFormat('fr-FR').format(Math.round(n));
const pourcent = (n: number) => `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(n)} %`;
const jj = (v: string) => v.split('-').reverse().join('/');
const nomPublic = (s: string) => LIBELLES_PUBLIC[s as keyof typeof LIBELLES_PUBLIC] ?? s;

/**
 * La variation, écrite comme on la lit à voix haute.
 *
 * `null` veut dire « la période précédente était à zéro » : on écrit
 * « nouveau » plutôt qu'une progression infinie, qui n'apprendrait rien et
 * ferait douter du reste du document.
 */
function variation(c: ChiffreCle): string {
  if (c.variation === null) return c.valeur > 0 ? 'nouveau' : 'aucun, comme avant';
  const signe = c.variation > 0 ? '+' : '';
  return `${signe}${pourcent(c.variation)} (${f(c.precedent)} avant)`;
}
