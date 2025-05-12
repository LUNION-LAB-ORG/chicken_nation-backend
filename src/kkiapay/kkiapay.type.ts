import { PaiementMode, PaiementStatus } from "@prisma/client";

export interface KkiapayResponse {
    performed_at: string
    type: "DEBIT" | "CREDIT",
    status: PaiementStatus,
    source: PaiementMode,
    source_common_name: string,
    amount: number,
    fees: number,
    reason: string,
    failureCode: string,
    failureMessage: string,
    state: string | null,
    partnerId: string,
    feeSupportedBy: string,
    income: number,
    transactionId: string,
    performedAt: string,
    client: {
        fullname: string,
        phone: string,
        email: string
    }
}