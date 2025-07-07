#!/bin/bash

# Test script for production-grade usage tracking

echo "================================================"
echo "Testing Production-Grade Usage Tracking"
echo "================================================"

API_URL="https://o7p7m3vwcb.execute-api.ap-south-1.amazonaws.com/v1"
TEST_API_KEY="gc_live_TEST_USER_123"

echo -e "\n1. Making successful API calls (should count against rate limit)"
for i in {1..3}; do
    echo -e "\nCall $i (200 expected):"
    curl -s -X GET "$API_URL/api/v1/tax-dates?country=AU&year=2025" \
        -H "X-Api-Key: $TEST_API_KEY" \
        -w "\nStatus: %{http_code}, Time: %{time_total}s\n" \
        -o /dev/null
    sleep 1
done

echo -e "\n2. Making failed API calls (should NOT count against rate limit)"
for i in {1..2}; do
    echo -e "\nFailed call $i (400 expected):"
    curl -s -X GET "$API_URL/api/v1/tax-dates?country=INVALID&year=2025" \
        -H "X-Api-Key: $TEST_API_KEY" \
        -w "\nStatus: %{http_code}, Time: %{time_total}s\n" \
        -o /dev/null
    sleep 1
done

echo -e "\n3. Checking usage in DynamoDB (API Keys table)"
aws dynamodb get-item --table-name getcomplical-api-keys --region ap-south-1 \
    --key '{"apiKey": {"S": "gc_live_TEST_USER_123"}}' \
    --projection-expression "totalUsage, usageToday" \
    --consistent-read | jq '.Item'

echo -e "\n4. Checking events in usage metrics table"
aws dynamodb query --table-name getcomplical-usage-metrics --region ap-south-1 \
    --key-condition-expression "pk = :pk" \
    --expression-attribute-values '{":pk": {"S": "events#2025-07-06"}}' \
    --filter-expression "apiKey = :apiKey" \
    --expression-attribute-values '{":pk": {"S": "events#2025-07-06"}, ":apiKey": {"S": "gc_live_TEST_USER_123"}}' \
    --select COUNT | jq '.Count'

echo -e "\n================================================"
echo "Expected Results:"
echo "- 3 successful calls (200) should increment usage counter"
echo "- 2 failed calls (400) should NOT increment usage counter"
echo "- Total usage should show 3 (not 5)"
echo "- All 5 events should be tracked in metrics table"
echo "================================================"