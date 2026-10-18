#!/usr/bin/env bash
#
# End-to-end verification of the defects found by API-level persona testing.
#
# Each check asserts a specific fix and prints PASS/FAIL. Run against a live
# stack:  scripts/live-stack.sh start && scripts/verify-fixes.sh
set -uo pipefail

B="http://127.0.0.1:${LIVE_API_PORT:-3100}/v1"
ADMIN_EMAIL="admin@payforge.test"; ADMIN_PASS="payforge-admin-pass-2026"
MER_EMAIL="ops@acme.test";      MER_PASS="acme-merchant-pass-2026"
PASS=0; FAIL=0

jqget() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(eval('j'+process.argv[1]))}catch{console.log('')}})" "$1"; }

check() { # check <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then echo "  PASS  $1"; PASS=$((PASS+1));
  else echo "  FAIL  $1 (expected $2, got $3)"; FAIL=$((FAIL+1)); fi
}

echo "=== seeding ==="
MREG=$(curl -sS -X POST "$B/auth/register/merchant" -H 'content-type: application/json' \
  -d "{\"name\":\"Acme Retail Pvt Ltd\",\"email\":\"$MER_EMAIL\",\"password\":\"$MER_PASS\",\"countryCode\":\"IN\"}")
MER=$(echo "$MREG" | jqget '.merchant.publicId')
echo "  merchant: $MER"

ATOKEN=$(curl -sS -X POST "$B/auth/login" -H 'content-type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}" | jqget '.accessToken')
MTOKEN=$(curl -sS -X POST "$B/auth/login" -H 'content-type: application/json' \
  -d "{\"email\":\"$MER_EMAIL\",\"password\":\"$MER_PASS\"}" | jqget '.accessToken')

# Bring the merchant to ACTIVE before the checks that need a live merchant.
# Everything after this point is about specific defects, not about onboarding
# order — the admin/merchant onboarding gates are verified separately below.
curl -sS -X POST "$B/merchants/me/kyc" -H "authorization: Bearer $MTOKEN" -H 'content-type: application/json' \
  -d '{"legalName":"Acme Retail Pvt Ltd","registrationNumber":"U74999KA2011PTC012345","countryCode":"IN"}' > /dev/null
curl -sS -X POST "$B/admin/merchants/$MER/kyc/review" -H "authorization: Bearer $ATOKEN" -H 'content-type: application/json' \
  -d '{"decision":"APPROVE"}' > /dev/null
curl -sS -X POST "$B/admin/merchants/$MER/risk" -H "authorization: Bearer $ATOKEN" -H 'content-type: application/json' \
  -d '{"sanctionsChecked":true,"pepChecked":true,"riskScore":12}' > /dev/null
curl -sS -X POST "$B/admin/merchants/$MER/provider-account" -H "authorization: Bearer $ATOKEN" -H 'content-type: application/json' \
  -d '{"provider":"stripe","providerAccountId":"acct_t1","onboardingStatus":"ENABLED","chargesEnabled":true,"payoutsEnabled":true}' > /dev/null
curl -sS -X POST "$B/admin/merchants/$MER/approve" -H "authorization: Bearer $ATOKEN" -H 'content-type: application/json' -d '{}' > /dev/null
MTOKEN=$(curl -sS -X POST "$B/auth/login" -H 'content-type: application/json' \
  -d "{\"email\":\"$MER_EMAIL\",\"password\":\"$MER_PASS\"}" | jqget '.accessToken')

echo
echo "=== 1. ValidationPipe active (was 500, must be 400) ==="
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$B/merchants/me/fee-schedule" \
  -H "authorization: Bearer $MTOKEN" -H 'content-type: application/json' -d '{"basisPoints":10000}')
check "100% fee schedule rejected with 400" "400" "$CODE"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$B/merchants/me/fee-schedule" \
  -H "authorization: Bearer $MTOKEN" -H 'content-type: application/json' -d '{"totallyBogus":true}')
check "unknown field rejected (forbidNonWhitelisted)" "400" "$CODE"

echo
echo "=== 2. Provider gate fails CLOSED (was: approved with no provider row) ==="
# A fresh merchant, onboarded but with no provider account recorded.
MER2=$(curl -sS -X POST "$B/auth/register/merchant" -H 'content-type: application/json' \
  -d "{\"name\":\"No Provider Co\",\"email\":\"np$(date +%s)@t.test\",\"password\":\"merchant-pass-2026x\",\"countryCode\":\"IN\"}" | jqget '.merchant.publicId')
M2TOKEN=$(curl -sS -X POST "$B/auth/login" -H 'content-type: application/json' \
  -d "{\"email\":\"np$(date +%s)@t.test\",\"password\":\"merchant-pass-2026x\"}" | jqget '.accessToken')
# The merchant submits its own KYC — must work while PENDING_REVIEW.
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$B/merchants/me/kyc" \
  -H "authorization: Bearer $M2TOKEN" -H 'content-type: application/json' \
  -d '{"legalName":"No Provider Co","countryCode":"IN"}')
check "PENDING_REVIEW merchant can submit its own KYC" "200" "$CODE"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$B/admin/merchants/$MER2/kyc/review" \
  -H "authorization: Bearer $ATOKEN" -H 'content-type: application/json' -d '{"decision":"APPROVE"}')
check "KYC review on a fresh merchant" "200" "$CODE"
curl -sS -X POST "$B/admin/merchants/$MER2/risk" -H "authorization: Bearer $ATOKEN" -H 'content-type: application/json' \
  -d '{"sanctionsChecked":true,"pepChecked":true,"riskScore":5}' > /dev/null
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$B/admin/merchants/$MER2/approve" \
  -H "authorization: Bearer $ATOKEN" -H 'content-type: application/json' -d '{}')
check "approval REFUSED with no provider account (was 200)" "400" "$CODE"
curl -sS -X POST "$B/admin/merchants/$MER2/provider-account" -H "authorization: Bearer $ATOKEN" -H 'content-type: application/json' \
  -d '{"provider":"stripe","onboardingStatus":"ENABLED","chargesEnabled":true,"payoutsEnabled":true}' > /dev/null
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$B/admin/merchants/$MER2/approve" \
  -H "authorization: Bearer $ATOKEN" -H 'content-type: application/json' -d '{}')
check "approval allowed once the provider enables charging" "200" "$CODE"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$B/admin/merchants/$MER2/approve" \
  -H "authorization: Bearer $ATOKEN" -H 'content-type: application/json' -d '{}')
check "re-approving an active merchant is a conflict" "409" "$CODE"

echo
echo "=== 3. JWT session inherits merchant status (was bypassable) ==="
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$B/admin/merchants/$MER/suspend" \
  -H "authorization: Bearer $ATOKEN" -H 'content-type: application/json' -d '{}')
check "suspend" "200" "$CODE"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' "$B/merchants/me" -H "authorization: Bearer $MTOKEN")
check "suspended merchant JWT blocked (was 200)" "403" "$CODE"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$B/payouts/destinations" \
  -H "authorization: Bearer $MTOKEN" -H 'content-type: application/json' \
  -d '{"bankName":"HDFC","accountHolder":"A","accountNumber":"1","routingCode":"2","currency":"INR"}')
check "suspended merchant cannot pre-wire a payout destination" "403" "$CODE"
curl -sS -X POST "$B/admin/merchants/$MER/restore" -H "authorization: Bearer $ATOKEN" -H 'content-type: application/json' -d '{}' > /dev/null

echo
echo "=== 4. Route shadowing fixed ==="
CODE=$(curl -sS -o /dev/null -w '%{http_code}' "$B/payouts/destinations" -H "authorization: Bearer $MTOKEN")
check "GET /payouts/destinations reachable (was 400)" "200" "$CODE"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' "$B/payments/payment-methods" -H "authorization: Bearer $MTOKEN")
check "GET /payments/payment-methods reachable (was 400)" "200" "$CODE"

echo
echo "=== 5. API key can create payments (was 500 FK violation) ==="
CREATED=$(curl -sS -X POST "$B/api-keys" -H "authorization: Bearer $MTOKEN" -H 'content-type: application/json' \
  -d '{"name":"integration","scopes":["payments:read","payments:write","refunds:write","payouts:read","payouts:write","webhooks:manage"]}')
APIKEY=$(echo "$CREATED" | jqget '.key')
echo "  minted key prefix: $(echo "$CREATED" | jqget '.prefix')"
if [[ -z "$APIKEY" ]]; then echo "  FAIL  could not mint an API key"; FAIL=$((FAIL+1)); else
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$B/payments" -H "x-api-key: $APIKEY" \
  -H 'content-type: application/json' -H "Idempotency-Key: verify-$(date +%s)" \
  -d "{\"merchantPublicId\":\"$MER\",\"amount\":100,\"currency\":\"INR\"}")
check "POST /payments with an API key (was 500)" "201" "$CODE"

CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$B/payments/client-session" \
  -H "x-api-key: $APIKEY" -H 'content-type: application/json' -d '{}')
check "POST /payments/client-session with an API key" "201" "$CODE"

DEST=$(curl -sS -X POST "$B/payouts/destinations" -H "x-api-key: $APIKEY" -H 'content-type: application/json' \
  -d '{"bankName":"HDFC Bank","accountHolder":"Acme Retail Pvt Ltd","accountNumber":"50100234567890","routingCode":"HDFC0001234","currency":"INR","isDefault":true}')
DID=$(echo "$DEST" | jqget '.publicId')
# No settled payments yet, so the balance is zero. A 409 INSUFFICIENT_BALANCE
# proves the route reached the payout service rather than dying on a foreign
# key violation — which is what the old 500 was.
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$B/payouts" -H "x-api-key: $APIKEY" \
  -H 'content-type: application/json' -H "Idempotency-Key: po-$(date +%s)" \
  -d "{\"destinationId\":\"$DID\",\"amount\":50,\"currency\":\"INR\"}")
check "POST /payouts reaches the service with an API key (was 500 FK)" "409" "$CODE"
fi

echo
echo "=== 6. Dev settle endpoint requires super-admin (was unauthenticated) ==="
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$B/dev/bank/settle" \
  -H 'content-type: application/json' -d '{"gatewayRef":"whatever","status":"SUCCESS"}')
check "unauthenticated settle refused (was 200)" "401" "$CODE"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$B/dev/bank/settle" \
  -H "authorization: Bearer $MTOKEN" -H 'content-type: application/json' \
  -d '{"gatewayRef":"whatever","status":"SUCCESS"}')
check "merchant-authenticated settle refused (was 200)" "403" "$CODE"

echo
echo "=== 7. Refresh-token reuse revokes the family (was rolled back) ==="
CUST="reuse$(date +%s)@t.test"
curl -sS -X POST "$B/auth/register/user" -H 'content-type: application/json' \
  -d "{\"email\":\"$CUST\",\"password\":\"customer-pass-2026x\",\"countryCode\":\"IN\"}" > /dev/null
S1=$(curl -sS -X POST "$B/auth/login" -H 'content-type: application/json' -d "{\"email\":\"$CUST\",\"password\":\"customer-pass-2026x\"}")
R1=$(echo "$S1" | jqget '.refreshToken')
S2=$(curl -sS -X POST "$B/auth/refresh" -H 'content-type: application/json' -d "{\"refreshToken\":\"$R1\"}")
R2=$(echo "$S2" | jqget '.refreshToken')
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$B/auth/refresh" -H 'content-type: application/json' -d "{\"refreshToken\":\"$R1\"}")
check "replaying a rotated refresh token is refused" "401" "$CODE"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$B/auth/refresh" -H 'content-type: application/json' -d "{\"refreshToken\":\"$R2\"}")
check "the whole family is revoked (was 200)" "401" "$CODE"

echo
echo "=== 8. Webhook signature rejects a missing timestamp (NaN bypass) ==="
# 400 from the validation pipe, which now enforces `@IsInt()` on timestamp.
# Before the pipe existed this reached the verifier, where
# `Math.abs(now - undefined) > 300` evaluated NaN > 300 === false and the
# callback was accepted indefinitely.
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$B/webhooks/bank" \
  -H 'content-type: application/json' -d '{"gatewayRef":"x","status":"SUCCESS","nonce":"n1"}')
check "bank callback without a timestamp refused" "400" "$CODE"

echo
echo "=== 9. requestId is populated (was 'unknown' everywhere) ==="
ERR=$(curl -sS "$B/payments" -H 'x-request-id: my-trace-12345')
echo "  $ERR" | head -c 220; echo

echo
echo "================================"
echo "  passed: $PASS   failed: $FAIL"
echo "================================"
[[ "$FAIL" -eq 0 ]]