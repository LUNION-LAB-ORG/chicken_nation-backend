import { PaiementMode, PaiementStatus } from "@prisma/client";

export class KkiapayResponse {
    performed_at: string;
    type: "DEBIT" | "CREDIT";
    status: PaiementStatus;
    source: PaiementMode;
    source_common_name: string;
    amount: number;
    fees: number;
    reason: string;
    failureCode: string;
    failureMessage: string;
    state: string | null;
    partnerId: string;
    feeSupportedBy: string;
    income: number;
    transactionId: string;
    performedAt: string;
    client: {
        fullname: string;
        phone: string;
        email: string;
    }
}

export class KkiaPayWebhookDto {
    transactionId: string;
    isPaymentSucces: boolean;
    account?: string | null;
    failureCode?: string;
    failureMessage?: string;
    label: string;
    method: 'MOBILE_MONEY' | 'WALLET' | 'CARD';
    amount: number;
    fees?: number;
    partnerId: string;
    performedAt: string; // ISO timestamp
    stateData: any;
    event: 'transaction.success' | 'transaction.failed';
}
