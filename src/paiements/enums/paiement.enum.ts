export enum PaiementStatus {
  PENDING = 'PENDING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED'
}

export enum PaiementType {
  CASH = 'CASH',
  CREDIT_CARD = 'CREDIT_CARD',
  MOBILE_MONEY = 'MOBILE_MONEY',
  PAYPAL = 'PAYPAL',
  STRIPE = 'STRIPE'
}

export enum MobileMoneyType {
  ORANGE_MONEY = 'ORANGE_MONEY',
  MOOV_MONEY = 'MOOV_MONEY',
  MTN_MONEY = 'MTN_MONEY',
  WAVE = 'WAVE'
}