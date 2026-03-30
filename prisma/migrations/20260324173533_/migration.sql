-- DropIndex
DROP INDEX "Transactions_paymentId_idx";

-- CreateIndex
CREATE INDEX "Transactions_paymentId_status_idx" ON "Transactions"("paymentId", "status");
