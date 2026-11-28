/**
 * REPÈRES DU JOURNAL D'AUDIT : lecture en base (28/11).
 *
 * Relit ce qu'une ligne désigne (commande, client, livreur…) pour en garder
 * la référence, le nom et le numéro. Règles : `audit-reperes.rules.ts`.
 *
 * Toujours APRÈS la réponse, hors de la requête : une lecture par cible, l'une
 * après l'autre, arrêtée dès que la référence, le nom et le numéro sont connus.
 * Une lecture qui échoue ne retire que ses repères.
 */
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { Cible, Fiche } from './audit-reperes.rules';

const CLIENT = { first_name: true, last_name: true, phone: true, email: true } satisfies Prisma.CustomerSelect;

const COMMANDE = {
  reference: true,
  fullname: true,
  phone: true,
  email: true,
  customer: { select: CLIENT },
} satisfies Prisma.OrderSelect;

const LIVREUR = {
  reference: true,
  first_name: true,
  last_name: true,
  phone: true,
  email: true,
} satisfies Prisma.DelivererSelect;

type ClientLu = Prisma.CustomerGetPayload<{ select: typeof CLIENT }>;
type CommandeLue = Prisma.OrderGetPayload<{ select: typeof COMMANDE }>;
type LivreurLu = Prisma.DelivererGetPayload<{ select: typeof LIVREUR }>;

const nomComplet = (p?: { first_name?: string | null; last_name?: string | null } | null) =>
  [p?.first_name, p?.last_name].map((v) => (v ?? '').trim()).filter(Boolean).join(' ') || null;

const ficheClient = (c?: ClientLu | null): Fiche | null =>
  c ? { nom: nomComplet(c), telephone: c.phone, autres: [c.email] } : null;

/**
 * Le nom et le numéro affichés sont ceux du compte client ; ceux inscrits sur
 * la commande, s'ils diffèrent, restent cherchables.
 */
const ficheCommande = (o?: CommandeLue | null, refEnPlus?: string | null): Fiche | null =>
  o
    ? {
        ref: o.reference,
        nom: nomComplet(o.customer) ?? o.fullname,
        telephone: o.customer?.phone ?? o.phone,
        autres: [refEnPlus, o.fullname, o.phone, o.customer?.email, o.email],
      }
    : null;

const ficheLivreur = (l?: LivreurLu | null, refEnPlus?: string | null): Fiche | null =>
  l ? { ref: l.reference, nom: nomComplet(l), telephone: l.phone, autres: [refEnPlus, l.email] } : null;

async function lireCible(prisma: PrismaService, cible: Cible): Promise<Fiche | null> {
  const id = cible.id;
  switch (cible.type) {
    case 'order': {
      if (!id && !cible.reference) return null;
      const o = await prisma.order.findUnique({
        where: id ? { id } : { reference: cible.reference as string },
        select: COMMANDE,
      });
      return ficheCommande(o);
    }
    case 'delivery': {
      if (!id) return null;
      const d = await prisma.delivery.findUnique({ where: { id }, select: { order: { select: COMMANDE } } });
      return ficheCommande(d?.order);
    }
    case 'paiement': {
      if (!id) return null;
      const p = await prisma.paiement.findUnique({
        where: { id },
        select: { reference: true, order: { select: COMMANDE } },
      });
      if (!p) return null;
      return ficheCommande(p.order, p.reference) ?? { ref: p.reference };
    }
    case 'incident': {
      if (!id) return null;
      const i = await prisma.incident.findUnique({
        where: { id },
        select: { code: true, order: { select: COMMANDE }, customer: { select: CLIENT } },
      });
      if (!i) return null;
      const commande = ficheCommande(i.order);
      const client = ficheClient(i.customer);
      return {
        ref: i.code,
        nom: client?.nom ?? commande?.nom,
        telephone: client?.telephone ?? commande?.telephone,
        autres: [commande?.ref, ...(commande?.autres ?? []), ...(client?.autres ?? [])],
      };
    }
    case 'customer': {
      if (!id) return null;
      return ficheClient(await prisma.customer.findUnique({ where: { id }, select: CLIENT }));
    }
    case 'crmContact': {
      if (!id) return null;
      const k = await prisma.crmContact.findUnique({
        where: { id },
        select: { name: true, phone: true, customer: { select: CLIENT } },
      });
      if (!k) return null;
      const client = ficheClient(k.customer);
      return {
        nom: client?.nom ?? k.name,
        telephone: client?.telephone ?? k.phone,
        autres: [k.name, k.phone, ...(client?.autres ?? [])],
      };
    }
    case 'deliverer': {
      if (!id) return null;
      return ficheLivreur(await prisma.deliverer.findUnique({ where: { id }, select: LIVREUR }));
    }
    case 'course': {
      if (!id) return null;
      const r = await prisma.course.findUnique({
        where: { id },
        select: { reference: true, deliverer: { select: LIVREUR } },
      });
      if (!r) return null;
      const livreur = ficheLivreur(r.deliverer);
      return { ref: r.reference, nom: livreur?.nom, telephone: livreur?.telephone, autres: [livreur?.ref] };
    }
    case 'user': {
      if (!id) return null;
      const u = await prisma.user.findUnique({ where: { id }, select: { fullname: true, phone: true, email: true } });
      return u ? { nom: u.fullname, telephone: u.phone, autres: [u.email] } : null;
    }
    default:
      return null;
  }
}

const connu = (fiches: Fiche[], champ: 'ref' | 'nom' | 'telephone') => fiches.some((f) => !!f[champ]);

/**
 * Fiches des cibles, dans l'ordre. `onEchec` reçoit chaque lecture ratée (la
 * ligne du journal s'écrit quand même).
 */
export async function lireFiches(
  prisma: PrismaService,
  cibles: Cible[],
  onEchec?: (cible: Cible, erreur: unknown) => void,
): Promise<Fiche[]> {
  const fiches: Fiche[] = [];
  for (const cible of cibles) {
    try {
      const fiche = await lireCible(prisma, cible);
      if (fiche) fiches.push(fiche);
    } catch (erreur) {
      onEchec?.(cible, erreur);
    }
    if (connu(fiches, 'ref') && connu(fiches, 'nom') && connu(fiches, 'telephone')) break;
  }
  return fiches;
}
