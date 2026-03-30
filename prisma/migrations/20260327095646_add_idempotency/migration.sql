/*
  Warnings:

  - Made the column `idempotencyKey` on table `Transactions` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "Transactions" ALTER COLUMN "idempotencyKey" SET NOT NULL;
