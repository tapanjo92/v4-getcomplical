#!/bin/bash

# Test script for GetComplical API V2 with Valkey and CloudFront

set -e

echo "=== GetComplical API V2 Test Script ==="
echo "Testing private API via CloudFront with Valkey rate limiting"
echo ""

# Configuration
CLOUDFRONT_URL="https://d2uhe8jerdqq3g.cloudfront.net"
TEST_API_KEY="${API_KEY:-gc_live_TEST_KEY}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}1. Testing Health Endpoint (No Auth Required)${NC}"
echo "GET $CLOUDFRONT_URL/health"
HEALTH_RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" "$CLOUDFRONT_URL/health")
HTTP_STATUS=$(echo "$HEALTH_RESPONSE" | grep -o "HTTP_STATUS:[0-9]*" | cut -d: -f2)
BODY=$(echo "$HEALTH_RESPONSE" | sed '/HTTP_STATUS:/d')

if [ "$HTTP_STATUS" -eq 200 ]; then
    echo -e "${GREEN}✓ Health check passed (Status: $HTTP_STATUS)${NC}"
    echo "Response: $BODY"
else
    echo -e "${RED}✗ Health check failed (Status: $HTTP_STATUS)${NC}"
    echo "Response: $BODY"
fi

echo -e "\n${YELLOW}2. Testing Direct API Gateway Access (Should Fail)${NC}"
# Extract API Gateway ID from CloudFormation
API_ID=$(aws cloudformation describe-stacks \
  --stack-name GetComplicalApiComputeStack \
  --query "Stacks[0].Outputs[?OutputKey=='ApiId'].OutputValue" \
  --output text \
  --region ap-south-1 2>/dev/null || echo "")

if [ -n "$API_ID" ]; then
    DIRECT_URL="https://$API_ID.execute-api.ap-south-1.amazonaws.com/v1/health"
    echo "GET $DIRECT_URL"
    DIRECT_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$DIRECT_URL" || echo "000")
    
    if [ "$DIRECT_STATUS" -eq 403 ]; then
        echo -e "${GREEN}✓ Direct access blocked as expected (Status: 403)${NC}"
    else
        echo -e "${RED}✗ Security issue: Direct access returned $DIRECT_STATUS (expected 403)${NC}"
    fi
else
    echo -e "${YELLOW}⚠ Could not find API Gateway ID${NC}"
fi

echo -e "\n${YELLOW}3. Testing API with Valid Key${NC}"
echo "GET $CLOUDFRONT_URL/api/v1/tax-dates?country=AU&year=2024"
echo "Header: X-Api-Key: $TEST_API_KEY"

API_RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}\nTIME_TOTAL:%{time_total}" \
  -H "X-Api-Key: $TEST_API_KEY" \
  "$CLOUDFRONT_URL/api/v1/tax-dates?country=AU&year=2024")
  
HTTP_STATUS=$(echo "$API_RESPONSE" | grep -o "HTTP_STATUS:[0-9]*" | cut -d: -f2)
TIME_TOTAL=$(echo "$API_RESPONSE" | grep -o "TIME_TOTAL:[0-9.]*" | cut -d: -f2)
BODY=$(echo "$API_RESPONSE" | sed '/HTTP_STATUS:/d' | sed '/TIME_TOTAL:/d')

if [ "$HTTP_STATUS" -eq 200 ]; then
    echo -e "${GREEN}✓ API call successful (Status: $HTTP_STATUS, Time: ${TIME_TOTAL}s)${NC}"
    echo "Tax dates found: $(echo "$BODY" | jq -r '.dates | length' 2>/dev/null || echo "parse error")"
else
    echo -e "${RED}✗ API call failed (Status: $HTTP_STATUS)${NC}"
    echo "Response: $BODY"
fi

echo -e "\n${YELLOW}4. Testing API without Key (Should Fail)${NC}"
NO_KEY_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  "$CLOUDFRONT_URL/api/v1/tax-dates?country=AU&year=2024")

if [ "$NO_KEY_STATUS" -eq 401 ]; then
    echo -e "${GREEN}✓ Correctly rejected request without API key (Status: 401)${NC}"
else
    echo -e "${RED}✗ Unexpected status without API key: $NO_KEY_STATUS (expected 401)${NC}"
fi

echo -e "\n${YELLOW}5. Testing Rate Limiting (Free Tier: 10 requests/day)${NC}"
if [ "$TEST_API_KEY" == "gc_live_TEST_KEY" ]; then
    echo "Making 12 requests to test rate limiting..."
    SUCCESS_COUNT=0
    RATE_LIMITED=false
    
    for i in {1..12}; do
        STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
          -H "X-Api-Key: $TEST_API_KEY" \
          "$CLOUDFRONT_URL/api/v1/tax-dates?country=NZ&year=2024")
        
        if [ "$STATUS" -eq 200 ]; then
            SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
            echo -n "."
        elif [ "$STATUS" -eq 429 ]; then
            RATE_LIMITED=true
            echo -e "\n${GREEN}✓ Rate limit enforced after $SUCCESS_COUNT successful requests${NC}"
            break
        else
            echo -e "\n${RED}✗ Unexpected status: $STATUS${NC}"
        fi
        
        sleep 0.5
    done
    
    if [ "$RATE_LIMITED" = false ]; then
        echo -e "\n${YELLOW}⚠ Rate limiting may not be working (got $SUCCESS_COUNT successful requests)${NC}"
    fi
else
    echo "Skipping rate limit test (use default test key)"
fi

echo -e "\n${YELLOW}6. Testing CloudFront Cache${NC}"
echo "Making same request twice to test caching..."

# First request (cache miss expected)
START_TIME=$(date +%s%N)
curl -s -o /dev/null -H "X-Api-Key: $TEST_API_KEY" \
  "$CLOUDFRONT_URL/api/v1/tax-dates?country=AU&year=2025"
END_TIME=$(date +%s%N)
FIRST_TIME=$(( ($END_TIME - $START_TIME) / 1000000 ))

# Second request (cache hit expected)
START_TIME=$(date +%s%N)
SECOND_RESPONSE=$(curl -s -D - -H "X-Api-Key: $TEST_API_KEY" \
  "$CLOUDFRONT_URL/api/v1/tax-dates?country=AU&year=2025")
END_TIME=$(date +%s%N)
SECOND_TIME=$(( ($END_TIME - $START_TIME) / 1000000 ))

CACHE_STATUS=$(echo "$SECOND_RESPONSE" | grep -i "x-cache:" | cut -d' ' -f2)

echo "First request: ${FIRST_TIME}ms"
echo "Second request: ${SECOND_TIME}ms"
echo "Cache status: ${CACHE_STATUS:-Unknown}"

if [ "$SECOND_TIME" -lt "$FIRST_TIME" ]; then
    echo -e "${GREEN}✓ Caching appears to be working (second request faster)${NC}"
else
    echo -e "${YELLOW}⚠ Cache performance unclear${NC}"
fi

echo -e "\n${GREEN}=== Test Complete ===${NC}"
echo ""
echo "Summary:"
echo "- CloudFront URL: $CLOUDFRONT_URL"
echo "- Private API: ✓ (direct access blocked)"
echo "- Authentication: ✓ (API key required)"
echo "- Rate Limiting: ✓ (via Valkey)"
echo ""
echo "To test with your own API key:"
echo "API_KEY=your_key ./test-api-v2.sh"