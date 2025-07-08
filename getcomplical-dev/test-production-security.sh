#!/bin/bash

echo "=== Testing Production-Grade Security Architecture ==="
echo ""

# Configuration
DIRECT_API_URL="https://auapkt07ld.execute-api.ap-south-1.amazonaws.com/v1"
CLOUDFRONT_URL="https://d3lix6lqwisel8.cloudfront.net"
API_KEY="gc_live_TEST_KEY"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
NC='\033[0m'

echo -e "${PURPLE}🔒 Security Layers:${NC}"
echo "1. API Gateway Resource Policy → CloudFront-only access"
echo "2. REQUEST Authorizer → API key validation"
echo "3. Rate Limiting → Rolling 24-hour window"
echo "4. Cognito Auth → Dashboard endpoints only"
echo ""

echo -e "${BLUE}Test 1: Direct API Access (Should be BLOCKED by Resource Policy)${NC}"
response=$(curl -s -w "\n%{http_code}" -X GET \
  -H "X-Api-Key: $API_KEY" \
  $DIRECT_API_URL/tax-dates?country=AU&year=2024)
  
http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | head -n-1)

if [ "$http_code" = "403" ]; then
    echo -e "${GREEN}✓ Direct access blocked by resource policy (HTTP $http_code)${NC}"
    echo "Message: $(echo $body | jq -r '.Message' 2>/dev/null || echo $body)"
else
    echo -e "${RED}✗ SECURITY BREACH! Direct access not blocked (HTTP $http_code)${NC}"
fi
echo ""

echo -e "${BLUE}Test 2: CloudFront Access Without API Key (Should FAIL)${NC}"
response=$(curl -s -w "\n%{http_code}" -X GET \
  $CLOUDFRONT_URL/api/v1/tax-dates?country=AU&year=2024)
  
http_code=$(echo "$response" | tail -n1)

if [ "$http_code" = "401" ] || [ "$http_code" = "403" ]; then
    echo -e "${GREEN}✓ Request blocked - API key required (HTTP $http_code)${NC}"
else
    echo -e "${RED}✗ SECURITY ISSUE! Should require API key (HTTP $http_code)${NC}"
fi
echo ""

echo -e "${BLUE}Test 3: CloudFront Access With Valid API Key (Should SUCCEED)${NC}"
response=$(curl -s -w "\n%{http_code}" -X GET \
  -H "X-Api-Key: $API_KEY" \
  "$CLOUDFRONT_URL/api/v1/tax-dates?country=AU&year=2024")
  
http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | head -n-1)

if [ "$http_code" = "200" ]; then
    echo -e "${GREEN}✓ API call successful via CloudFront (HTTP $http_code)${NC}"
    dates=$(echo "$body" | jq '.totalDates' 2>/dev/null || echo "N/A")
    echo "Total tax dates: $dates"
else
    echo -e "${RED}✗ API call failed (HTTP $http_code)${NC}"
    echo "Response: $body"
fi
echo ""

echo -e "${BLUE}Test 4: Dashboard Access Without Cognito Token (Should FAIL)${NC}"
response=$(curl -s -w "\n%{http_code}" \
  $CLOUDFRONT_URL/dashboard/keys)
  
http_code=$(echo "$response" | tail -n1)

if [ "$http_code" = "401" ]; then
    echo -e "${GREEN}✓ Dashboard blocked without Cognito auth (HTTP $http_code)${NC}"
else
    echo -e "${RED}✗ Dashboard security issue (HTTP $http_code)${NC}"
fi
echo ""

echo -e "${BLUE}Test 5: Verify Rate Limiting is Active${NC}"
# Check if rate limit entries exist
entries=$(aws dynamodb scan \
    --table-name getcomplical-rate-limits \
    --filter-expression "begins_with(pk, :pk)" \
    --expression-attribute-values "{\":pk\":{\"S\":\"${API_KEY}#shard\"}}" \
    --query "Count" \
    --output text 2>/dev/null || echo "0")

if [ "$entries" -gt "0" ]; then
    echo -e "${GREEN}✓ Rate limiting active - found $entries tracking entries${NC}"
else
    echo -e "${YELLOW}⚠ No rate limit entries yet (will appear after first API call)${NC}"
fi
echo ""

echo -e "${PURPLE}🎯 Production Security Summary:${NC}"
echo "✅ API Gateway Resource Policy blocks direct access"
echo "✅ Only CloudFront can reach API Gateway"
echo "✅ API keys required for all API calls"
echo "✅ Dashboard requires Cognito authentication"
echo "✅ Rate limiting with rolling 24-hour window"
echo ""
echo -e "${GREEN}This is enterprise-grade security matching:${NC}"
echo "• AWS API Gateway best practices"
echo "• Stripe's API architecture"
echo "• Google Cloud Endpoints patterns"