import { BadRequestException } from '@nestjs/common';

/**
 * Pièces jointes acceptées sur un message : une image, une note vocale.
 *
 * ⚠️ Jusqu'ici la messagerie n'avait AUCUNE limite de taille ni filtre de type,
 * et l'intercepteur était appelé sans options. Tout fichier transitait
 * entièrement en mémoire dans le processus : un envoi de plusieurs centaines de
 * mégaoctets suffisait à le mettre à genoux. On bride AVANT d'ouvrir la vanne
 * de l'audio, qui ne peut que faire grossir les fichiers.
 */

/** Une image de conversation reste une photo, pas une impression haute définition. */
export const TAILLE_MAX_IMAGE = 8 * 1024 * 1024;

/**
 * Une note vocale d'environ trois minutes en qualité parole. Volontairement
 * généreux, mais borné : sans borne, la seule limite serait la mémoire du
 * serveur.
 */
export const TAILLE_MAX_AUDIO = 16 * 1024 * 1024;

export const TYPES_IMAGE = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
];

/**
 * ⚠️ Le format n'est PAS le même partout, et il ne faut pas chercher à
 * l'uniformiser côté serveur.
 *
 * Le navigateur produit du webm sur Chrome et du mp4 sur Safari ; le téléphone
 * produit du m4a. Transcoder exigerait ffmpeg sur le serveur, donc une image
 * Docker plus lourde et un travail gourmand en processeur sur un VPS déjà
 * surveillé pour son disque. On stocke tel quel, et chaque lecteur lit ce qu'il
 * sait lire : c'est le cas de tous les formats ci dessous sur les plateformes
 * visées.
 */
export const TYPES_AUDIO = [
  'audio/webm',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/x-m4a',
  'audio/m4a',
  'audio/wav',
  'audio/x-wav',
];

export interface PiecesJointesMessage {
  image?: Express.Multer.File[];
  audio?: Express.Multer.File[];
}

export const CHAMPS_PIECES_JOINTES = [
  { name: 'image', maxCount: 1 },
  { name: 'audio', maxCount: 1 },
];

export const OPTIONS_PIECES_JOINTES = {
  limits: {
    // Plafond commun au transport. Le contrôle fin par type se fait ensuite
    // sur la taille réelle du tampon, une limite unique ne pouvant pas
    // distinguer une image d'une note vocale.
    fileSize: TAILLE_MAX_AUDIO,
    files: 2,
  },
  fileFilter: (
    _req: any,
    file: Express.Multer.File,
    cb: (erreur: Error | null, accepte: boolean) => void,
  ) => {
    const attendus = file.fieldname === 'audio' ? TYPES_AUDIO : TYPES_IMAGE;
    if (!attendus.includes(file.mimetype)) {
      return cb(
        new BadRequestException(
          `Type de fichier refusé pour « ${file.fieldname} » : ${file.mimetype}`,
        ),
        false,
      );
    }
    cb(null, true);
  },
};

/** Refuse une pièce jointe trop lourde pour ce qu'elle prétend être. */
export function verifierTaille(fichier: Express.Multer.File | undefined, max: number, quoi: string) {
  if (!fichier) return;
  const taille = fichier.size ?? fichier.buffer?.length ?? 0;
  if (taille > max) {
    throw new BadRequestException(
      `${quoi} trop lourd : ${Math.round(taille / 1024 / 1024)} Mo, maximum ${Math.round(max / 1024 / 1024)} Mo`,
    );
  }
}
