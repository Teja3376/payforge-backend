/*
  Warnings:

  - A unique constraint covering the columns `[gatewayRef]` on the table `Transactions` will be added. If there are existing duplicate values, this will fail.
  - Changed the type of `status` on the `Payments` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `status` on the `Transactions` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'PENDING', 'SUCCESS', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('CREATED', 'PENDING', 'SUCCESS', 'FAILED', 'EXPIRED');

-- AlterTable
ALTER TABLE "Payments" ADD COLUMN     "metadata" JSONB,
DROP COLUMN "status",
ADD COLUMN     "status" "PaymentStatus" NOT NULL;

-- AlterTable
ALTER TABLE "Transactions" DROP COLUMN "status",
ADD COLUMN     "status" "TransactionStatus" NOT NULL;

-- CreateIndex
CREATE INDEX "Payments_merchantId_idx" ON "Payments"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "Transactions_gatewayRef_key" ON "Transactions"("gatewayRef");

-- CreateIndex
CREATE INDEX "Transactions_paymentId_idx" ON "Transactions"("paymentId");
