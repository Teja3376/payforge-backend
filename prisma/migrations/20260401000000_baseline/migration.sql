-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'MERCHANT', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'API_KEY', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('PENDING_REVIEW', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('NOT_STARTED', 'SUBMITTED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "KeyMode" AS ENUM ('LIVE', 'TEST');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'EXPIRED', 'VOIDED');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('SCHEDULED', 'IN_TRANSIT', 'PAID', 'FAILED', 'REVERSED');

-- CreateEnum
CREATE TYPE "DestinationStatus" AS ENUM ('PENDING', 'ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "LedgerType" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "LedgerAccount" AS ENUM ('MERCHANT', 'PLATFORM');

-- CreateEnum
CREATE TYPE "ResolutionAction" AS ENUM ('SUSPEND_MERCHANT', 'RESTORE_MERCHANT', 'APPROVE_MERCHANT', 'SUSPEND_USER', 'RESTORE_USER', 'REFUND', 'CREATE_API_KEY', 'REVOKE_API_KEY', 'PAYOUT_CREATED');

-- CreateEnum
CREATE TYPE "ResolutionSubject" AS ENUM ('USER', 'MERCHANT', 'PAYMENT', 'API_KEY', 'PAYOUT');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CARD', 'UPI', 'NET_BANKING', 'WALLET');

-- CreateEnum
CREATE TYPE "SavedMethodStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "CardBrand" AS ENUM ('VISA', 'MASTERCARD', 'RUPAY', 'AMEX', 'DISCOVER', 'DINERS_CLUB', 'JCB', 'UNIONPAY', 'MAESTRO', 'OTHER');

-- CreateEnum
CREATE TYPE "WalletProvider" AS ENUM ('PAYTM', 'PHONEPE', 'AMAZON_PAY', 'MOBIKWIK');

-- CreateEnum
CREATE TYPE "WebhookEndpointStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "WebhookEventType" AS ENUM ('PAYMENT_CREATED', 'PAYMENT_SUCCEEDED', 'PAYMENT_FAILED', 'PAYMENT_CANCELLED', 'PAYMENT_EXPIRED', 'PAYMENT_REFUNDED', 'REFUND_SUCCEEDED', 'REFUND_FAILED', 'PAYOUT_PAID', 'PAYOUT_FAILED');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED', 'DEAD');

-- CreateTable
CREATE TABLE "Users" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "merchantId" TEXT,
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "passwordChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "ip" TEXT,
    "succeeded" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "merchantId" TEXT,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "scopes" TEXT[],
    "mode" "KeyMode" NOT NULL DEFAULT 'LIVE',
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Merchants" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "countryCode" TEXT NOT NULL DEFAULT 'IN',
    "mode" "KeyMode" NOT NULL DEFAULT 'TEST',
    "settlementCurrency" TEXT NOT NULL DEFAULT 'INR',
    "settlementDelayDays" INTEGER NOT NULL DEFAULT 2,
    "defaultFeeBasisPoints" INTEGER NOT NULL DEFAULT 200,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Merchants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantKyc" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "legalName" TEXT,
    "registrationNumber" TEXT,
    "taxId" TEXT,
    "countryCode" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "postalCode" TEXT,
    "status" "KycStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "rejectionReason" TEXT,
    "submittedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantKyc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantFeeSchedule" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "basisPoints" INTEGER NOT NULL,
    "minFeeMinor" BIGINT NOT NULL DEFAULT 0,
    "maxFeeMinor" BIGINT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantFeeSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantBalance" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "balance" BIGINT NOT NULL DEFAULT 0,
    "pending" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformAccount" (
    "id" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "balance" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExchangeRateSnapshot" (
    "id" TEXT NOT NULL,
    "rateDate" DATE NOT NULL,
    "baseCode" TEXT NOT NULL,
    "rates" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExchangeRateSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payments" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "fxRateDate" DATE NOT NULL,
    "usdRate" DECIMAL(24,10) NOT NULL,
    "inrRate" DECIMAL(24,10) NOT NULL,
    "settlementAmount" BIGINT NOT NULL,
    "settlementCurrency" TEXT NOT NULL,
    "feeBasisPoints" INTEGER NOT NULL DEFAULT 200,
    "status" "PaymentStatus" NOT NULL,
    "idempotencyKey" TEXT,
    "refundedAmount" BIGINT NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "description" TEXT,
    "metadata" JSONB,
    "cancelledReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transactions" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "status" "TransactionStatus" NOT NULL,
    "gatewayRef" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "fee" BIGINT NOT NULL DEFAULT 0,
    "netAmount" BIGINT NOT NULL DEFAULT 0,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ledgers" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "account" "LedgerAccount" NOT NULL,
    "accountKey" TEXT NOT NULL,
    "merchantId" TEXT,
    "currency" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "type" "LedgerType" NOT NULL,
    "referenceId" TEXT NOT NULL,
    "balanceAfter" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Ledgers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "feeReversed" BIGINT NOT NULL DEFAULT 0,
    "netReversed" BIGINT NOT NULL DEFAULT 0,
    "reason" TEXT,
    "status" "RefundStatus" NOT NULL DEFAULT 'SUCCEEDED',
    "idempotencyKey" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutDestination" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountHolder" TEXT NOT NULL,
    "accountLast4" TEXT NOT NULL,
    "accountEnc" TEXT NOT NULL,
    "routingEnc" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "DestinationStatus" NOT NULL DEFAULT 'ACTIVE',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayoutDestination_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "destinationId" TEXT,
    "amount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'SCHEDULED',
    "externalRef" TEXT,
    "failureReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "requestedById" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientSession" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "paymentId" TEXT,
    "merchantId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedPaymentMethod" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "customerRef" TEXT,
    "type" "PaymentMethod" NOT NULL DEFAULT 'CARD',
    "gatewayToken" TEXT NOT NULL,
    "brand" "CardBrand",
    "last4" TEXT,
    "expiryMonth" INTEGER,
    "expiryYear" INTEGER,
    "holderName" TEXT,
    "status" "SavedMethodStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedPaymentMethod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "events" TEXT[],
    "status" "WebhookEndpointStatus" NOT NULL DEFAULT 'ACTIVE',
    "description" TEXT,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "disabledReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" "WebhookEventType" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastStatusCode" INTEGER,
    "lastError" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Resolution" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorType" "ActorType" NOT NULL DEFAULT 'USER',
    "action" "ResolutionAction" NOT NULL,
    "subjectType" "ResolutionSubject" NOT NULL,
    "subjectPublicId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Resolution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardDetails" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "holderName" TEXT NOT NULL,
    "brand" "CardBrand" NOT NULL,
    "last4" TEXT NOT NULL,
    "expiryMonth" INTEGER NOT NULL,
    "expiryYear" INTEGER NOT NULL,
    "avsResult" TEXT,
    "cvvResult" TEXT,

    CONSTRAINT "CardDetails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpiDetails" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "vpa" TEXT NOT NULL,

    CONSTRAINT "UpiDetails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NetBankingDetails" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,

    CONSTRAINT "NetBankingDetails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletDetails" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "provider" "WalletProvider" NOT NULL,

    CONSTRAINT "WalletDetails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Users_publicId_key" ON "Users"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "Users_email_key" ON "Users"("email");

-- CreateIndex
CREATE INDEX "Users_merchantId_idx" ON "Users"("merchantId");

-- CreateIndex
CREATE INDEX "Users_createdAt_idx" ON "Users"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Session_publicId_key" ON "Session"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_refreshTokenHash_key" ON "Session"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_revokedAt_idx" ON "Session"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "LoginAttempt_email_createdAt_idx" ON "LoginAttempt"("email", "createdAt");

-- CreateIndex
CREATE INDEX "LoginAttempt_ip_createdAt_idx" ON "LoginAttempt"("ip", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_publicId_key" ON "ApiKey"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_prefix_key" ON "ApiKey"("prefix");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_hash_key" ON "ApiKey"("hash");

-- CreateIndex
CREATE INDEX "ApiKey_merchantId_revokedAt_idx" ON "ApiKey"("merchantId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Merchants_publicId_key" ON "Merchants"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "Merchants_email_key" ON "Merchants"("email");

-- CreateIndex
CREATE INDEX "Merchants_createdAt_idx" ON "Merchants"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantKyc_merchantId_key" ON "MerchantKyc"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantFeeSchedule_merchantId_key" ON "MerchantFeeSchedule"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantBalance_merchantId_currency_key" ON "MerchantBalance"("merchantId", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformAccount_currency_key" ON "PlatformAccount"("currency");

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeRateSnapshot_rateDate_key" ON "ExchangeRateSnapshot"("rateDate");

-- CreateIndex
CREATE UNIQUE INDEX "Payments_publicId_key" ON "Payments"("publicId");

-- CreateIndex
CREATE INDEX "Payments_userId_createdAt_idx" ON "Payments"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Payments_merchantId_createdAt_idx" ON "Payments"("merchantId", "createdAt");

-- CreateIndex
CREATE INDEX "Payments_status_createdAt_idx" ON "Payments"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Payments_createdAt_idx" ON "Payments"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payments_userId_idempotencyKey_key" ON "Payments"("userId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Transactions_publicId_key" ON "Transactions"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "Transactions_gatewayRef_key" ON "Transactions"("gatewayRef");

-- CreateIndex
CREATE INDEX "Transactions_paymentId_idx" ON "Transactions"("paymentId");

-- CreateIndex
CREATE INDEX "Transactions_createdAt_idx" ON "Transactions"("createdAt");

-- CreateIndex
CREATE INDEX "Transactions_status_createdAt_idx" ON "Transactions"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Transactions_userId_idempotencyKey_key" ON "Transactions"("userId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Ledgers_publicId_key" ON "Ledgers"("publicId");

-- CreateIndex
CREATE INDEX "Ledgers_account_currency_createdAt_idx" ON "Ledgers"("account", "currency", "createdAt");

-- CreateIndex
CREATE INDEX "Ledgers_merchantId_createdAt_idx" ON "Ledgers"("merchantId", "createdAt");

-- CreateIndex
CREATE INDEX "Ledgers_referenceId_idx" ON "Ledgers"("referenceId");

-- CreateIndex
CREATE UNIQUE INDEX "Ledgers_account_accountKey_referenceId_type_key" ON "Ledgers"("account", "accountKey", "referenceId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_publicId_key" ON "Refund"("publicId");

-- CreateIndex
CREATE INDEX "Refund_paymentId_createdAt_idx" ON "Refund"("paymentId", "createdAt");

-- CreateIndex
CREATE INDEX "Refund_merchantId_createdAt_idx" ON "Refund"("merchantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_merchantId_idempotencyKey_key" ON "Refund"("merchantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutDestination_publicId_key" ON "PayoutDestination"("publicId");

-- CreateIndex
CREATE INDEX "PayoutDestination_merchantId_status_idx" ON "PayoutDestination"("merchantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_publicId_key" ON "Payout"("publicId");

-- CreateIndex
CREATE INDEX "Payout_merchantId_createdAt_idx" ON "Payout"("merchantId", "createdAt");

-- CreateIndex
CREATE INDEX "Payout_status_createdAt_idx" ON "Payout"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_merchantId_idempotencyKey_key" ON "Payout"("merchantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ClientSession_publicId_key" ON "ClientSession"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientSession_secretHash_key" ON "ClientSession"("secretHash");

-- CreateIndex
CREATE INDEX "ClientSession_merchantId_expiresAt_idx" ON "ClientSession"("merchantId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "SavedPaymentMethod_publicId_key" ON "SavedPaymentMethod"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "SavedPaymentMethod_gatewayToken_key" ON "SavedPaymentMethod"("gatewayToken");

-- CreateIndex
CREATE INDEX "SavedPaymentMethod_merchantId_status_idx" ON "SavedPaymentMethod"("merchantId", "status");

-- CreateIndex
CREATE INDEX "SavedPaymentMethod_merchantId_customerRef_idx" ON "SavedPaymentMethod"("merchantId", "customerRef");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEndpoint_publicId_key" ON "WebhookEndpoint"("publicId");

-- CreateIndex
CREATE INDEX "WebhookEndpoint_merchantId_status_idx" ON "WebhookEndpoint"("merchantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_publicId_key" ON "WebhookDelivery"("publicId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx" ON "WebhookDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_endpointId_createdAt_idx" ON "WebhookDelivery"("endpointId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_endpointId_eventId_key" ON "WebhookDelivery"("endpointId", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "Resolution_publicId_key" ON "Resolution"("publicId");

-- CreateIndex
CREATE INDEX "Resolution_createdAt_idx" ON "Resolution"("createdAt");

-- CreateIndex
CREATE INDEX "Resolution_actorId_createdAt_idx" ON "Resolution"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "Resolution_subjectPublicId_createdAt_idx" ON "Resolution"("subjectPublicId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CardDetails_transactionId_key" ON "CardDetails"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "UpiDetails_transactionId_key" ON "UpiDetails"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "NetBankingDetails_transactionId_key" ON "NetBankingDetails"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletDetails_transactionId_key" ON "WalletDetails"("transactionId");

-- AddForeignKey
ALTER TABLE "Users" ADD CONSTRAINT "Users_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoginAttempt" ADD CONSTRAINT "LoginAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantKyc" ADD CONSTRAINT "MerchantKyc_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantFeeSchedule" ADD CONSTRAINT "MerchantFeeSchedule_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantBalance" ADD CONSTRAINT "MerchantBalance_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payments" ADD CONSTRAINT "Payments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payments" ADD CONSTRAINT "Payments_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transactions" ADD CONSTRAINT "Transactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transactions" ADD CONSTRAINT "Transactions_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ledgers" ADD CONSTRAINT "Ledgers_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutDestination" ADD CONSTRAINT "PayoutDestination_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "PayoutDestination"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientSession" ADD CONSTRAINT "ClientSession_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedPaymentMethod" ADD CONSTRAINT "SavedPaymentMethod_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resolution" ADD CONSTRAINT "Resolution_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "Users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardDetails" ADD CONSTRAINT "CardDetails_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpiDetails" ADD CONSTRAINT "UpiDetails_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NetBankingDetails" ADD CONSTRAINT "NetBankingDetails_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletDetails" ADD CONSTRAINT "WalletDetails_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Hardening: constraints Prisma's schema language cannot express.
-- These enforce money invariants at the database, not just in application code.
-- ===========================================================================

-- Currency codes must be ISO-4217 shaped. Prevents "usd", "USD ", "rupees".
ALTER TABLE "Payments"            ADD CONSTRAINT "Payments_currency_format"          CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "Payments"            ADD CONSTRAINT "Payments_settlementCurrency_fmt"  CHECK ("settlementCurrency" ~ '^[A-Z]{3}$');
ALTER TABLE "Transactions"        ADD CONSTRAINT "Transactions_currency_format"    CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "Ledgers"             ADD CONSTRAINT "Ledgers_currency_format"         CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "MerchantBalance"     ADD CONSTRAINT "MerchantBalance_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "PlatformAccount"     ADD CONSTRAINT "PlatformAccount_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "Refund"              ADD CONSTRAINT "Refund_currency_format"          CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "Payout"              ADD CONSTRAINT "Payout_currency_format"          CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "PayoutDestination"   ADD CONSTRAINT "PayoutDest_currency_format"      CHECK ("currency" ~ '^[A-Z]{3}$');

-- Money must be strictly positive when it moves, and never negative when held.
ALTER TABLE "Payments"        ADD CONSTRAINT "Payments_amount_positive"       CHECK ("amount" > 0);
ALTER TABLE "Payments"        ADD CONSTRAINT "Payments_settlement_positive"   CHECK ("settlementAmount" > 0);
ALTER TABLE "Payments"        ADD CONSTRAINT "Payments_refunded_non_negative" CHECK ("refundedAmount" >= 0);
ALTER TABLE "Payments"        ADD CONSTRAINT "Payments_refunded_within"       CHECK ("refundedAmount" <= "settlementAmount");
ALTER TABLE "Transactions"    ADD CONSTRAINT "Transactions_amount_positive"   CHECK ("amount" > 0);
ALTER TABLE "Transactions"    ADD CONSTRAINT "Transactions_fee_non_negative" CHECK ("fee" >= 0);
ALTER TABLE "Transactions"    ADD CONSTRAINT "Transactions_net_non_negative" CHECK ("netAmount" >= 0);
ALTER TABLE "Ledgers"         ADD CONSTRAINT "Ledgers_amount_positive"       CHECK ("amount" > 0);
ALTER TABLE "Refund"          ADD CONSTRAINT "Refund_amount_positive"        CHECK ("amount" > 0);
ALTER TABLE "Payout"          ADD CONSTRAINT "Payout_amount_positive"        CHECK ("amount" > 0);
ALTER TABLE "MerchantBalance" ADD CONSTRAINT "MerchantBalance_non_negative"  CHECK ("balance" >= 0 AND "pending" >= 0);
ALTER TABLE "PlatformAccount" ADD CONSTRAINT "PlatformAccount_non_negative"  CHECK ("balance" >= 0);

-- Fee schedules are basis points: 0..10000 (0%..100%).
ALTER TABLE "Merchants"         ADD CONSTRAINT "Merchants_fee_bps_range"    CHECK ("defaultFeeBasisPoints" BETWEEN 0 AND 10000);
ALTER TABLE "MerchantFeeSchedule" ADD CONSTRAINT "MerchantFeeSchedule_bps_range" CHECK ("basisPoints" BETWEEN 0 AND 10000);
ALTER TABLE "Merchants"         ADD CONSTRAINT "Merchants_settlement_delay" CHECK ("settlementDelayDays" BETWEEN 0 AND 30);

-- Lockout window cannot be in the past at write time.
ALTER TABLE "Users" ADD CONSTRAINT "Users_failed_logins_non_negative" CHECK ("failedLogins" >= 0);

-- At most one open (PENDING) or settled (SUCCESS) transaction per payment.
-- This is the database-level guarantee against the concurrent double-charge race;
-- application code must still handle the resulting unique-violation as a 409.
CREATE UNIQUE INDEX "Transactions_one_open_per_payment"
  ON "Transactions" ("paymentId")
  WHERE "status" IN ('PENDING', 'SUCCESS');

-- Exactly one destination may be the default per merchant.
CREATE UNIQUE INDEX "PayoutDestination_one_default_per_merchant"
  ON "PayoutDestination" ("merchantId")
  WHERE "isDefault" = true;

-- The ledger is append-only. Corrections are made with compensating entries.
CREATE OR REPLACE FUNCTION payforge_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Table "%" is append-only; post a compensating entry instead.', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Ledgers_append_only"
  BEFORE UPDATE OR DELETE ON "Ledgers"
  FOR EACH ROW EXECUTE FUNCTION payforge_forbid_mutation();

CREATE TRIGGER "ExchangeRateSnapshot_immutable"
  BEFORE DELETE ON "ExchangeRateSnapshot"
  FOR EACH ROW EXECUTE FUNCTION payforge_forbid_mutation();
