import { BadRequestException, Injectable } from '@nestjs/common';
import { kkiapay } from "@kkiapay-org/nodejs-sdk"
import { ConfigService } from "@nestjs/config";
import { KkiapayResponse } from './kkiapay.type';


@Injectable()
export class KkiapayService {

    private readonly kkiapay: {
        verify: (transactionId: string) => Promise<any>;
        refund: (transactionId: string) => Promise<any>;
    };

    constructor(private readonly config: ConfigService) {
        this.kkiapay = kkiapay({
            privatekey: this.config.get<string>('KKIA_PAY_PRIVATE_KEY') ?? "",
            publickey: this.config.get<string>('KKIA_PAY_PUBLIC_KEY') ?? "",
            secretkey: this.config.get<string>('KKIA_PAY_SECRET_KEY') ?? "",
            sandbox: this.config.get<string>('KKIA_PAY_SANDBOX') === "true"
        })
    }

    // Verification de la transaction
    async verifyTransaction(transactionId: string): Promise<KkiapayResponse> {
        if (!transactionId) {
            throw new BadRequestException("Transaction non trouvée");
        }
        return this.kkiapay.verify(transactionId).
            then((response) => {
                return response as KkiapayResponse;
            }).
            catch((error) => {
                throw new BadRequestException("Transaction non trouvée");
            })
    }

    // Remboursement de la transaction
    async refundTransaction(transactionId: string): Promise<KkiapayResponse> {
        if (!transactionId) {
            throw new BadRequestException("Transaction non trouvée");
        }
        return this.kkiapay.refund(transactionId).
            then((response) => {
                return response as KkiapayResponse;
            }).
            catch((error) => {
                throw new BadRequestException("Transaction non trouvée");
            })
    }
}
