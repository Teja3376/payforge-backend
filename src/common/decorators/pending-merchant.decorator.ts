import { SetMetadata } from '@nestjs/common';

export const PENDING_MERCHANT_KEY = 'payforge:pending-merchant-allowed';

/**
 * Exempt a route from the "merchant must be ACTIVE" check.
 *
 * A merchant session inherits its merchant's status, which is correct — a
 * merchant whose KYC was rejected must not be able to provision a payout
 * destination or a webhook endpoint. But that check cannot be blanket: a
 * PENDING_REVIEW merchant must still be able to read its own profile and submit
 * its KYC, which is how it ever becomes ACTIVE. Blocking those routes strands
 * the merchant with no path to approval.
 *
 * Declared per route rather than inferred, so granting the exemption is a
 * deliberate act rather than a side effect of route ordering.
 */
export const AllowPendingMerchant = () => SetMetadata(PENDING_MERCHANT_KEY, true);