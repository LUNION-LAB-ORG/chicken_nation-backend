import { Module } from "@nestjs/common";
import { TentativesLivreurService } from "src/modules/auth-deliverer/services/tentatives-livreur.service";
import { EnvoisOtpService } from "./envois-otp.service";
import { OtpService } from "./otp.service";
import { redisEnvoisOtpProvider } from "./redis-envois.provider";

/**
 * Codes de connexion, communs aux clients (AuthModule) et aux livreurs
 * (AuthDelivererModule), qui importent tous deux ce module : génération
 * (OtpService), plafonds d'envoi (EnvoisOtpService) et compteur des essais de
 * code (TentativesLivreurService, dont la clé de vérification est commune aux
 * deux parcours puisque la table des codes l'est). Une seule instance de
 * chaque, et aucune dépendance entre AuthModule et AuthDelivererModule.
 */
@Module({
  imports: [],
  providers: [OtpService, EnvoisOtpService, redisEnvoisOtpProvider, TentativesLivreurService],
  exports: [OtpService, EnvoisOtpService, TentativesLivreurService],
})
export class OtpModule { }
