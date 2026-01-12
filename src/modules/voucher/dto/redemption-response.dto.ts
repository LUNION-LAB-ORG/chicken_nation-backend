
import { VoucherResponseDto } from './voucher-response.dto';

export class RedemptionResponseDto {
    redemption: {
        id: string;
        amount: number;
        orderId: string;
        createdAt: Date;
    };
    voucher: VoucherResponseDto;
}