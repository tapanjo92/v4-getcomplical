#!/bin/bash

# Quick test script - assumes you already have an API key

if [ -z "$1" ]; then
  echo "Usage: ./quick-test.sh <API_KEY> [CLOUDFRONT_URL]"
  echo "Example: ./quick-test.sh txs_live_abc123 d123456.cloudfront.net"
  exit 1
fi

API_KEY=$1
CDN_URL=${2:-$(aws cloudformation describe-stacks \
  --stack-name GetComplicalCdnStack \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionDomainName'].OutputValue" \
  --output text \
  --region ap-south-1)}

if [ -z "$CDN_URL" ]; then
  echo "Error: Could not determine CloudFront URL"
  exit 1
fi

echo "Testing GetComplical API"
echo "CloudFront URL: https://$CDN_URL"
echo "API Key: ${API_KEY:0:15}..."
echo ""

# Test 1: Basic AU query
echo "1. Testing AU 2024 data..."
curl -s -X GET "https://$CDN_URL/api/v1/tax-dates?country=AU&year=2024" \
  -H "X-Api-Key: $API_KEY" | jq '{country, year, totalDates, sample: .dates[0]}'

echo ""

# Test 2: NZ query
echo "2. Testing NZ 2024 data..."
curl -s -X GET "https://$CDN_URL/api/v1/tax-dates?country=NZ&year=2024" \
  -H "X-Api-Key: $API_KEY" | jq '{country, year, totalDates}'

echo ""

# Test 3: Filtered query
echo "3. Testing filtered query (BAS only)..."
curl -s -X GET "https://$CDN_URL/api/v1/tax-dates?country=AU&year=2024&type=bas" \
  -H "X-Api-Key: $API_KEY" | jq '{totalDates, type: .filters.type, dates: [.dates[].name]}'

echo ""

# Test 4: State filter
echo "4. Testing state filter (NSW)..."
curl -s -X GET "https://$CDN_URL/api/v1/tax-dates?country=AU&year=2024&state=NSW" \
  -H "X-Api-Key: $API_KEY" | jq '{totalDates, state: .filters.state}'

echo ""

# Test 5: Cache test
echo "5. Testing cache performance..."
echo "First request (potential cache miss):"
time curl -s -X GET "https://$CDN_URL/api/v1/tax-dates?country=AU&year=2025" \
  -H "X-Api-Key: $API_KEY" \
  -o /dev/null -w "Status: %{http_code}, Time: %{time_total}s\n"

echo "Second request (should be cached):"
time curl -s -X GET "https://$CDN_URL/api/v1/tax-dates?country=AU&year=2025" \
  -H "X-Api-Key: $API_KEY" \
  -o /dev/null -w "Status: %{http_code}, Time: %{time_total}s\n"

echo ""
echo "Quick test complete!"