import { Injectable } from "@nestjs/common";
import { hotp } from "otplib";
import { PrismaService } from "src/database/services/prisma.service";
import { ConfigService } from '@nestjs/config';

@Injectable()
export class OtpService {
  private readonly secret: string;
  private readonly expiration: number;

  constructor(private readonly configService: ConfigService, private readonly prisma: PrismaService) {

    this.secret = this.configService.get<string>("OTP_SECRET") ?? "";
    
    this.expiration = 5 * 60 * 1000; // 5 minutes en millisecondes

    hotp.options = { digits: 4 };
  }

  async generate(phone: string) {
    
    // Si Non trouvé, on génère un nouveau OTP
    let counter = 1;
    const counterOtp = await this.prisma.counterOtp.findFirst();

    // Création ou mise à jour du counter
    if (counterOtp) {
      counter = counterOtp.counter + 1;

      await this.prisma.counterOtp.update({
        where: { id: counterOtp.id },
        data: { counter },
      });
    } else {
      await this.prisma.counterOtp.create({ data: { counter } });
    }

    // GENERATE OTP TOKEN
    const token = hotp.generate(this.secret, counter);

    // CREATE OTP TOKEN
    // La source de vérité pour la vérification est CETTE ligne (phone + code +
    // expire), lue par AuthService.verifyOtp. NE PAS revérifier le token via un
    // hotp.verify() sur le compteur global : ce compteur est partagé par tous
    // les utilisateurs (et les 2 backends sur la même base), donc il a bougé
    // entre la génération et la saisie → faux « OTP invalide ».
    await this.prisma.otpToken.create({
      data: {
        code: token,
        phone,
        counter,
        expire: new Date(Date.now() + this.expiration),
      },
    });

    return token;
  }

  /**
   * Anti-flood du renvoi d'OTP. Renvoie le nombre de SECONDES à attendre avant
   * de pouvoir redemander un code pour ce numéro, ou 0 si on peut en envoyer un.
   *
   * On déduit l'instant de création du dernier OTP depuis `expire`
   * (created_at = expire − this.expiration), car OtpToken n'a pas de created_at.
   * Empêche : explosion de SMS Twilio + insertions + contention sur le compteur
   * global quand des milliers de clients spamment « renvoyer le code ».
   */
  async getResendCooldownSeconds(phone: string, cooldownMs: number): Promise<number> {
    const last = await this.prisma.otpToken.findFirst({
      where: { phone },
      orderBy: { expire: 'desc' },
    });
    if (!last) return 0;
    const createdAt = last.expire.getTime() - this.expiration;
    const remainingMs = createdAt + cooldownMs - Date.now();
    return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
  }
}