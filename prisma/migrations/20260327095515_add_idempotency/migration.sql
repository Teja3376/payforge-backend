/*
  Warnings:

  - A unique constraint covering the columns `[idempotencyKey]` on the table `Transactions` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Transactions" ADD COLUMN     "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Transactions_idempotencyKey_key" ON "Transactions"("idempotencyKey");
