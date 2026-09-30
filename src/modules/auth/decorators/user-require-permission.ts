import { SetMetadata } from '@nestjs/common';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';

export const REQUIRE_PERMISSION_KEY = 'permission';
export const RequirePermission = (module: Modules, action: Action) =>
  SetMetadata(REQUIRE_PERMISSION_KEY, { module, action });

/** Une permission attendue : un module et une action. */
export interface PermissionRequise {
  module: Modules;
  action: Action;
}

/**
 * L'UNE OU L'AUTRE de ces permissions suffit.
 *
 * Écrit pour la fusion de la page Clients dans le CRM : les routes de
 * contacts doivent rester ouvertes au CRM, et s'ouvrir aussi au droit
 * CLIENTS pour les comptes qui ne consultent que le fichier — caissier,
 * assistant-manager. Le service, lui, restreint ce qu'il renvoie selon le
 * droit réellement détenu : ouvrir la porte n'ouvre pas les tiroirs.
 *
 * Les appels à `RequirePermission` ne changent pas : le garde accepte les
 * deux formes, une permission seule ou une liste.
 */
export const RequireUnePermission = (...permissions: PermissionRequise[]) =>
  SetMetadata(REQUIRE_PERMISSION_KEY, permissions);
