#!/bin/bash

# Test script for the new rolling window rate limiter

set -e

echo "=== Testing Advanced Rate Limiter (Rolling 24-Hour Window) ==="
echo ""

# Configuration
API_URL="https://d3lix6lqwisel8.cloudfront.net/api/v1"
API_KEY="gc_live_TEST_KEY"  # Free tier: 100 requests/day

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test 1: Make a successful request
echo -e "${BLUE}Test 1: Making a valid API request${NC}"
response=$(curl -s -w "\n%{http_code}" -X POST \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"income": 50000, "filing_status": "single", "state": "CA"}' \
  $API_URL/calculate)

http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | head -n-1)

if [ "$http_code" = "200" ]; then
    echo -e "${GREEN}✓ Request successful (HTTP $http_code)${NC}"
    echo "Response: $body" | jq '.' 2>/dev/null || echo "$body"
else
    echo -e "${RED}✗ Request failed (HTTP $http_code)${NC}"
    echo "Response: $body"
fi

echo ""

# Test 2: Check rate limit info from authorizer context
echo -e "${BLUE}Test 2: Checking rate limit information${NC}"
echo "Note: Rate limit info would be in Lambda authorizer context"
echo "Current implementation tracks usage across 10 shards in DynamoDB"
echo ""

# Test 3: Query the rate limit table to see our usage
echo -e "${BLUE}Test 3: Checking rate limit entries in DynamoDB${NC}"
# The rate limiter uses sharded counters, so we'll check multiple shards
for shard in {0..2}; do
    echo -e "${YELLOW}Checking shard $shard...${NC}"
    aws dynamodb query \
        --table-name getcomplical-rate-limits \
        --key-condition-expression "pk = :pk" \
        --expression-attribute-values "{\":pk\":{\"S\":\"${API_KEY}#shard#${shard}\"}}" \
        --query "Items[*].{Shard:pk.S,Timestamp:timestamp.S,Count:count.N}" \
        --output table 2>/dev/null || echo "No entries in shard $shard"
done

echo ""

# Test 4: Make multiple requests to see the counter increment
echo -e "${BLUE}Test 4: Making 5 rapid requests to test rate limiting${NC}"
for i in {1..5}; do
    echo -n "Request $i: "
    http_code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
        -H "x-api-key: $API_KEY" \
        -H "Content-Type: application/json" \
        -d '{"income": 50000, "filing_status": "single", "state": "CA"}' \
        $API_URL/calculate)
    
    if [ "$http_code" = "200" ]; then
        echo -e "${GREEN}✓ Success${NC}"
    elif [ "$http_code" = "429" ]; then
        echo -e "${RED}✗ Rate limited!${NC}"
    else
        echo -e "${YELLOW}HTTP $http_code${NC}"
    fi
    sleep 0.5
done

echo ""
echo -e "${BLUE}Summary:${NC}"
echo "- The new rate limiter uses a rolling 24-hour window"
echo "- Each request is tracked with its exact timestamp"
echo "- Requests expire exactly 24 hours after they're made"
echo "- Usage is distributed across 10 shards for high performance"
echo ""
echo "Unlike the old system where limits reset at midnight,"
echo "this provides a more fair and accurate rate limiting experience!"