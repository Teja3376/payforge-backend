#!/usr/bin/env bash
# End-to-end smoke test against a running server and the live database.
set -uo pipefail
B="${BASE_URL:-localhost:3000/v1}"
PASS=0; FAIL=0
# Extract a dotted path, e.g. jqp "merchant.publicId". Prints "" when absent.
jqp() { python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print(''); sys.exit()
for part in sys.argv[1].split('.'):
    if d is None:
        print(''); sys.exit()
    d = d.get(part) if isinstance(d, dict) else None
print('' if d is None else d)
" "$1" 2>/dev/null; }
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
chk() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }

R=$RANDOM
echo "── auth ─────────────────────────────────────────"

ADMIN=$(curl -s -X POST $B/auth/login -H 'content-type: application/json' \
  -d "{\"email\":\"$SUPER_ADMIN_EMAIL\",\"password\":\"$SUPER_ADMIN_PASSWORD\"}")
ATOK=$(echo "$ADMIN" | jqp "accessToken")
[ -n "$ATOK" ] && ok "admin login" || { bad "admin login: $ADMIN"; exit 1; }

PAYER=$(curl -s -X POST $B/auth/register/user -H 'content-type: application/json' \
  -d "{\"email\":\"e2e-payer-$R@example.com\",\"password\":\"correct-horse-battery\",\"countryCode\":\"IN\"}")
PTOK=$(curl -s -X POST $B/auth/login -H 'content-type: application/json' \
  -d "{\"email\":\"e2e-payer-$R@example.com\",\"password\":\"correct-horse-battery\"}" | jqp "accessToken")
chk "payer registered" "$(echo "$PAYER" | jqp "role")" "USER"

MERCH=$(curl -s -X POST $B/auth/register/merchant -H 'content-type: application/json' \
  -d "{\"name\":\"E2E Store $R\",\"email\":\"e2e-merch-$R@example.com\",\"password\":\"correct-horse-battery\",\"countryCode\":\"IN\"}")
MERCH_ID=$(echo "$MERCH" | jqp "merchant.publicId")
MTOK=$(curl -s -X POST $B/auth/login -H 'content-type: application/json' \
  -d "{\"email\":\"e2e-merch-$R@example.com\",\"password\":\"correct-horse-battery\"}" | jqp "accessToken")
chk "new merchant is PENDING_REVIEW" "$(echo "$MERCH" | jqp "merchant.status")" "PENDING_REVIEW"

echo "── merchant approval gate ───────────────────────"
PAY_BEFORE=$(curl -s -X POST $B/payments -H "authorization: Bearer $PTOK" -H 'content-type: application/json' \
  -H "idempotency-key: pre-$R" -d "{\"merchantPublicId\":\"$MERCH_ID\",\"amount\":100,\"currency\":\"INR\"}")
chk "pending merchant cannot receive payments" "$(echo "$PAY_BEFORE" | jqp "code")" "MERCHANT_CANNOT_RECEIVE"

curl -s -X POST $B/admin/merchants/$MERCH_ID/approve -H "authorization: Bearer $ATOK" > /dev/null
chk "merchant approved" "$(curl -s $B/merchants/$MERCH_ID -H "authorization: Bearer $MTOK" | jqp "status")" "ACTIVE"

echo "── validation & error contract ──────────────────"
MISSING=$(curl -s -X POST $B/payments -H "authorization: Bearer $PTOK" -H 'content-type: application/json' \
  -d "{\"merchantPublicId\":\"$MERCH_ID\",\"amount\":10,\"currency\":\"INR\"}")
chk "missing Idempotency-Key -> coded 400" "$(echo "$MISSING" | jqp "code")" "IDEMPOTENCY_KEY_REQUIRED"
RID=$(echo "$MISSING" | jqp "requestId")
case "$RID" in req_*) ok "error carries a requestId";; *) bad "requestId ($RID)";; esac

HUGE=$(curl -s -X POST $B/payments -H "authorization: Bearer $PTOK" -H 'content-type: application/json' \
  -H "idempotency-key: huge-$R" -d "{\"merchantPublicId\":\"$MERCH_ID\",\"amount\":1e308,\"currency\":\"INR\"}")
chk "absurd amount rejected, not a 500" "$(echo "$HUGE" | jqp "statusCode")" "400"

echo "── payments & idempotency ───────────────────────"
P1=$(curl -s -X POST $B/payments -H "authorization: Bearer $PTOK" -H 'content-type: application/json' \
  -H "idempotency-key: order-$R" -d "{\"merchantPublicId\":\"$MERCH_ID\",\"amount\":1580,\"currency\":\"JPY\",\"description\":\"E2E\"}")
PAY_ID=$(echo "$P1" | jqp "publicId")
chk "payment created" "$(echo "$P1" | jqp "status")" "CREATED"
chk "FX quote frozen to INR" "$(echo "$P1" | jqp "settlementCurrency")" "INR"

P2=$(curl -s -X POST $B/payments -H "authorization: Bearer $PTOK" -H 'content-type: application/json' \
  -H "idempotency-key: order-$R" -d "{\"merchantPublicId\":\"$MERCH_ID\",\"amount\":1580,\"currency\":\"JPY\"}")
chk "same key replays the same payment" "$(echo "$P2" | jqp "publicId")" "$PAY_ID"

P3=$(curl -s -X POST $B/payments -H "authorization: Bearer $PTOK" -H 'content-type: application/json' \
  -H "idempotency-key: order-$R" -d "{\"merchantPublicId\":\"$MERCH_ID\",\"amount\":9999,\"currency\":\"JPY\"}")
chk "same key + different payload -> 409" "$(echo "$P3" | jqp "code")" "IDEMPOTENCY_PAYLOAD_MISMATCH"

echo "── transaction ──────────────────────────────────"
T1=$(curl -s -X POST $B/transactions -H "authorization: Bearer $PTOK" -H 'content-type: application/json' \
  -H "idempotency-key: txn-$R" \
  -d "{\"paymentPublicId\":\"$PAY_ID\",\"method\":\"CARD\",\"card\":{\"holderName\":\"Ada Lovelace\",\"cardNumber\":\"5555555555554444\",\"cvv\":\"123\",\"expiryMonth\":12,\"expiryYear\":2032}}")
TRX=$(echo "$T1" | jqp "publicId")
chk "transaction created" "$(echo "$T1" | jqp "status")" "PENDING"
chk "PAN never echoed back" "$(echo "$T1" | grep -c '5555555555554444')" "0"
chk "gatewayRef not exposed to payer" "$(echo "$T1" | jqp "gatewayRef")" ""

DUPE=$(curl -s -X POST $B/transactions -H "authorization: Bearer $PTOK" -H 'content-type: application/json' \
  -H "idempotency-key: txn-$R" \
  -d "{\"paymentPublicId\":\"$PAY_ID\",\"method\":\"CARD\",\"card\":{\"holderName\":\"Ada Lovelace\",\"cardNumber\":\"5555555555554444\",\"cvv\":\"123\",\"expiryMonth\":12,\"expiryYear\":2032}}")
chk "transaction idempotent replay" "$(echo "$DUPE" | jqp "publicId")" "$TRX"

OPEN=$(curl -s -X POST $B/transactions -H "authorization: Bearer $PTOK" -H 'content-type: application/json' \
  -H "idempotency-key: txn2-$R" \
  -d "{\"paymentPublicId\":\"$PAY_ID\",\"method\":\"UPI\",\"upi\":{\"vpa\":\"ada@okaxis\"}}")
chk "second concurrent attempt blocked" "$(echo "$OPEN" | jqp "code")" "PAYMENT_HAS_OPEN_TRANSACTION"

MISMATCH=$(curl -s -X POST $B/transactions -H "authorization: Bearer $PTOK" -H 'content-type: application/json' \
  -H "idempotency-key: txn3-$R" \
  -d "{\"paymentPublicId\":\"$PAY_ID\",\"method\":\"CARD\",\"upi\":{\"vpa\":\"ada@okaxis\"}}")
chk "method/details mismatch rejected" "$(echo "$MISMATCH" | jqp "statusCode")" "400"

echo "── tenant isolation ─────────────────────────────"
LEAK=$(curl -s $B/payments/$PAY_ID -H "authorization: Bearer $MTOK")
chk "merchant can see its own payment" "$(echo "$LEAK" | jqp "publicId")" "$PAY_ID"

OTHER=$(curl -s -X POST $B/auth/register/merchant -H 'content-type: application/json' \
  -d "{\"name\":\"Other $R\",\"email\":\"other-$R@example.com\",\"password\":\"correct-horse-battery\",\"countryCode\":\"IN\"}")
OTOK=$(curl -s -X POST $B/auth/login -H 'content-type: application/json' \
  -d "{\"email\":\"other-$R@example.com\",\"password\":\"correct-horse-battery\"}" | jqp "accessToken")
CROSS=$(curl -s $B/payments/$PAY_ID -H "authorization: Bearer $OTOK")
chk "cross-tenant read -> 404 not 403" "$(echo "$CROSS" | jqp "code")" "PAYMENT_NOT_FOUND"

echo "── API keys & scopes ────────────────────────────"
KEY=$(curl -s -X POST $B/api-keys -H "authorization: Bearer $MTOK" -H 'content-type: application/json' \
  -d '{"name":"e2e read key","scopes":["payments:read"],"mode":"TEST"}')
RAW=$(echo "$KEY" | jqp "key")
chk "API key minted" "$(echo "$RAW" | cut -c1-8)" "pf_test_"
chk "secret returned exactly once" "$(curl -s $B/api-keys -H "authorization: Bearer $MTOK" | grep -c "$RAW")" "0"

READ_OK=$(curl -s $B/payments -H "x-api-key: $RAW")
chk "key can read with payments:read" "$(echo "$READ_OK" | jqp "hasMore")" "False"

# POST /payments is a payer action, so a merchant key is refused on role.
PAYER_ONLY=$(curl -s -X POST $B/payments -H "x-api-key: $RAW" -H 'content-type: application/json' \
  -H "idempotency-key: k-$R" -d "{\"merchantPublicId\":\"$MERCH_ID\",\"amount\":10,\"currency\":\"INR\"}")
chk "merchant key cannot act as a payer" "$(echo "$PAYER_ONLY" | jqp "code")" "FORBIDDEN"

# Scope enforcement, on a merchant-only endpoint.
NOSCOPE=$(curl -s -X POST $B/refunds -H "x-api-key: $RAW" -H 'content-type: application/json' \
  -H "idempotency-key: rf-$R" -d "{\"paymentId\":\"$PAY_ID\",\"amount\":1}")
chk "key missing refunds:write is scope-refused" "$(echo "$NOSCOPE" | jqp "code")" "INSUFFICIENT_SCOPE"

BOTH=$(curl -s -X POST $B/auth/login -H 'content-type: application/json' \
  -d "{\"email\":\"other-$R@example.com\",\"password\":\"correct-horse-battery\"}" | jqp "accessToken")
MIXED=$(curl -s $B/payments -H "x-api-key: $RAW" -H "authorization: Bearer $MTOK")
chk "two credentials on one request rejected" "$(echo "$MIXED" | jqp "code")" "UNAUTHENTICATED"

BADKEY=$(curl -s $B/payments -H "x-api-key: pf_test_aaaaaaaaaaaa_bogus")
chk "bogus API key rejected" "$(echo "$BADKEY" | jqp "code")" "INVALID_API_KEY"

echo "── suspend / audit ──────────────────────────────"
curl -s -X POST $B/admin/merchants/$MERCH_ID/suspend -H "authorization: Bearer $ATOK" > /dev/null
SUSP=$(curl -s $B/merchants/$MERCH_ID -H "authorization: Bearer $MTOK" | jqp "status")
chk "merchant suspendable" "$SUSP" "SUSPENDED"

echo "── rate limiting ────────────────────────────────"
LIMIT=$(curl -s "$B/payments?limit=1000" -H "authorization: Bearer $ATOK" | jqp "code")
chk "oversized page rejected before the limiter" "$LIMIT" "VALIDATION_FAILED"
# The effective limit is configurable so a CI runner or a NAT'd office IP can
# be accommodated; assert against whatever the server was actually started
# with rather than the shipped default.
AUTH_LIMIT=${RATE_LIMIT_AUTH:-10}
RLC=""
for i in $(seq 1 $((AUTH_LIMIT + 5))); do
  RLC=$(curl -s -o /dev/null -w "%{http_code}" -X POST $B/auth/login -H 'content-type: application/json' \
    -d "{\"email\":\"nobody-$i-$R@example.com\",\"password\":\"wrong-password\"}")
  [ "$RLC" = "429" ] && break
done
[ "$RLC" = "429" ] && ok "login rate limited after $AUTH_LIMIT attempts" \
                    || bad "login rate limit (got $RLC within $((AUTH_LIMIT + 5)) attempts)"

echo "── pagination ───────────────────────────────────"
PAGE=$(curl -s "$B/payments?limit=2" -H "authorization: Bearer $ATOK")
chk "list returns an envelope" "$(echo "$PAGE" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"] is not None)')" "True"
chk "limit respected" "$(echo "$PAGE" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['data'])<=2)")" "True"
BADQ=$(curl -s "$B/payments?limit=9999" -H "authorization: Bearer $ATOK")
chk "limit over 100 rejected" "$(echo "$BADQ" | jqp "statusCode")" "400"

echo "── dev endpoint ─────────────────────────────────"
DEV=$(curl -s -X POST $B/dev/bank/settle -H 'content-type: application/json' -d '{}')
chk "dev endpoint not registered by default" "$(echo "$DEV" | jqp "statusCode")" "404"

echo
echo "════════════════════════════════════════════════"
echo "  passed: $PASS    failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1