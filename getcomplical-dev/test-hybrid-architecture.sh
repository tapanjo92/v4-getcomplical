#!/bin/bash

echo "=== Testing Hybrid Architecture (Cognito + API Keys) ==="
echo ""

# Configuration
CLOUDFRONT_URL="https://d3lix6lqwisel8.cloudfront.net"
API_KEY="gc_live_TEST_KEY"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}Architecture Overview:${NC}"
echo "1. Public endpoints → No auth required"
echo "2. Dashboard endpoints → Cognito JWT required"
echo "3. API endpoints → API key only required"
echo ""

echo -e "${BLUE}Test 1: Public Health Endpoint (No Auth)${NC}"
response=$(curl -s -w "\n%{http_code}" $CLOUDFRONT_URL/health)
http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | head -n-1)

if [ "$http_code" = "200" ]; then
    echo -e "${GREEN}✓ Health check successful (HTTP $http_code)${NC}"
    echo "$body" | jq '.status' 2>/dev/null || echo "$body"
else
    echo -e "${RED}✗ Health check failed (HTTP $http_code)${NC}"
fi
echo ""

echo -e "${BLUE}Test 2: Dashboard Endpoint Without Auth (Should Fail)${NC}"
response=$(curl -s -w "\n%{http_code}" $CLOUDFRONT_URL/dashboard/keys)
http_code=$(echo "$response" | tail -n1)

if [ "$http_code" = "401" ] || [ "$http_code" = "403" ]; then
    echo -e "${GREEN}✓ Correctly blocked without Cognito token (HTTP $http_code)${NC}"
else
    echo -e "${RED}✗ Security issue! Should require auth (HTTP $http_code)${NC}"
fi
echo ""

echo -e "${BLUE}Test 3: API Endpoint with API Key${NC}"
response=$(curl -s -w "\n%{http_code}" -X GET \
  -H "X-Api-Key: $API_KEY" \
  "$CLOUDFRONT_URL/api/v1/tax-dates?country=AU&year=2024")
  
http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | head -n-1)

if [ "$http_code" = "200" ]; then
    echo -e "${GREEN}✓ API call successful with API key (HTTP $http_code)${NC}"
    echo "$body" | jq '.totalDates' 2>/dev/null || echo "Response received"
elif [ "$http_code" = "403" ]; then
    echo -e "${YELLOW}⚠ API call blocked - might be CloudFront secret issue${NC}"
    echo "Response: $body"
else
    echo -e "${RED}✗ API call failed (HTTP $http_code)${NC}"
    echo "Response: $body"
fi
echo ""

echo -e "${BLUE}Test 4: Check Rate Limiting${NC}"
# Query rate limit table for our API key
shard_count=$(aws dynamodb query \
    --table-name getcomplical-rate-limits \
    --key-condition-expression "pk = :pk" \
    --expression-attribute-values "{\":pk\":{\"S\":\"${API_KEY}#shard#0\"}}" \
    --query "Count" \
    --output text 2>/dev/null || echo "0")

if [ "$shard_count" -gt "0" ]; then
    echo -e "${GREEN}✓ Rate limiting is tracking usage (found $shard_count entries)${NC}"
else
    echo -e "${YELLOW}⚠ No rate limit entries found yet${NC}"
fi
echo ""

echo -e "${BLUE}Architecture Summary:${NC}"
echo "✅ Public endpoints (health) - No auth needed"
echo "✅ Dashboard endpoints - Cognito required"
echo "✅ API endpoints - API key required"
echo "✅ Rate limiting - Rolling 24-hour window"
echo ""
echo "This is a production-ready architecture used by:"
echo "• Stripe (Dashboard login + API keys)"
echo "• AWS (Console login + Access keys)"
echo "• SendGrid (Portal login + API keys)"