/**
 * Textes de la notification au client quand un de ses bons sert ou est
 * recrédité. Écrits à part pour être relus et testés : accords, pas de jargon.
 */

const francs = (montant: number): string => Math.round(Number(montant) || 0).toLocaleString('fr-FR');

export function texteMouvementBon(p: {
  sens: 'DEBIT' | 'CREDIT';
  code: string;
  montant: number;
  solde: number;
  reference?: string | null;
  motif?: 'ANNULATION' | 'SUPPRESSION';
  valableJusquau?: Date | null;
}): { titre: string; message: string } {
  if (p.sens === 'DEBIT') {
    const commande = p.reference ? `la commande ${p.reference}` : 'une commande';
    const reste =
      p.solde >= 1
        ? `Solde restant : ${francs(p.solde)} F CFA.`
        : 'Il est désormais entièrement utilisé.';
    return {
      titre: "Bon d'achat utilisé",
      message:
        `Votre bon ${p.code} a servi pour ${commande} : réduction de ${francs(p.montant)} F CFA. ${reste}` +
        " Si vous n'êtes pas à l'origine de cette commande, contactez-nous.",
    };
  }
  const commande = p.reference ? `La commande ${p.reference}` : 'Une commande';
  const evenement = p.motif === 'SUPPRESSION' ? 'supprimée' : 'annulée';
  const echeance = p.valableJusquau
    ? ` Il est valable jusqu'au ${new Date(p.valableJusquau).toLocaleDateString('fr-FR')}.`
    : '';
  return {
    titre: "Bon d'achat recrédité",
    message:
      `${commande} a été ${evenement} : votre bon ${p.code} est recrédité de ${francs(p.montant)} F CFA.` +
      ` Solde disponible : ${francs(p.solde)} F CFA.${echeance}`,
  };
}
