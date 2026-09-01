import { Global, Module } from '@nestjs/common';
import { S3Service } from './s3.service';

/**
 * ⚠️ Ce module n'expose PLUS de contrôleur.
 *
 * `POST /s3/upload` existait sans la moindre garde : n'importe qui sur Internet
 * pouvait déposer un fichier de n'importe quel type et de n'importe quelle
 * taille dans le stockage, ensuite servi depuis le domaine de la marque. Vérifié
 * en production, la route répondait 400 et non 401, donc bien joignable sans
 * jeton, et aucune des trois façades ne l'appelait. Du code mort doublé d'une
 * porte ouverte : elle est retirée plutôt que gardée.
 *
 * Les envois de fichiers légitimes passent par les modules concernés (menus,
 * messagerie, adhésion), qui portent leurs propres gardes et leurs propres
 * chemins de stockage.
 */
@Global()
@Module({
  providers: [S3Service],
  exports: [S3Service],
})
export class S3Module { }