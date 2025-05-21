import { Injectable } from "@nestjs/common";
import { hotp } from "otplib";
import { PrismaService } from "src/database/services/prisma.service";
import { ConfigService } from '@nestjs/config';

@Injectable()
export class OtpService {
  private readonly secret: string;

  constructor(private readonly configService: ConfigService, private readonly prisma: PrismaService) {

    this.secret = this.configService.get<string>("OTP_SECRET") ?? "";
    hotp.options = { digits: 4 };
  }

  async generate(phone: string) {

    // Récupérer le OTP s'il n'a pas encore expiré
    const otpToken = await this.prisma.otpToken.findFirst({
      where: {
        phone,
        expire: {
          gte: new Date(),
        },
      },
    });

    if (otpToken) {
      return otpToken.code;
    }

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
    await this.prisma.otpToken.create({
      data: {
        code: token,
        phone,
        counter,
        expire: new Date(Date.now() + 5 * 60 * 1000),
      },
    });

    return token;
  }

  async verify(token: string) {
    const counter = await this.prisma.counterOtp.findFirst();
    return hotp.verify({ token, counter: counter?.counter ?? 1, secret: this.secret });
  }
}
