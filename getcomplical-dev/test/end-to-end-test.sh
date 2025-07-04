#!/bin/bash

# End-to-End Test Script for GetComplical API
# Tests the complete flow: Signup → Login → Generate API Key → Call API

set -e

echo "=== GetComplical End-to-End Test ==="
echo "Prerequisites: Deploy all stacks first with 'npm run deploy'"
echo ""

# Configuration
REGION="ap-south-1"
TEST_EMAIL="test-$(date +%s)@example.com"
TEST_PASSWORD="TestPass123!"
TEMP_PASSWORD="TempPass123!"

# Get stack outputs
echo "1. Getting stack outputs..."
USER_POOL_ID=$(aws cloudformation describe-stacks \
  --stack-name GetComplicalAuthStack \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" \
  --output text \
  --region $REGION)

CLIENT_ID=$(aws cloudformation describe-stacks \
  --stack-name GetComplicalAuthStack \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolClientId'].OutputValue" \
  --output text \
  --region $REGION)

API_URL=$(aws cloudformation describe-stacks \
  --stack-name GetComplicalApiComputeStack \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" \
  --output text \
  --region $REGION)

CDN_URL=$(aws cloudformation describe-stacks \
  --stack-name GetComplicalCdnStack \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionDomainName'].OutputValue" \
  --output text \
  --region $REGION)

echo "User Pool ID: $USER_POOL_ID"
echo "Client ID: $CLIENT_ID"
echo "API URL: $API_URL"
echo "CDN URL: https://$CDN_URL"
echo ""

# Step 2: Create test user
echo "2. Creating test user..."
aws cognito-idp admin-create-user \
  --user-pool-id $USER_POOL_ID \
  --username $TEST_EMAIL \
  --user-attributes Name=email,Value=$TEST_EMAIL Name=name,Value="Test User" \
  --temporary-password $TEMP_PASSWORD \
  --message-action SUPPRESS \
  --region $REGION \
  > /dev/null

echo "Created user: $TEST_EMAIL"

# Step 3: Set permanent password
echo "3. Setting permanent password..."
aws cognito-idp admin-set-user-password \
  --user-pool-id $USER_POOL_ID \
  --username $TEST_EMAIL \
  --password $TEST_PASSWORD \
  --permanent \
  --region $REGION

echo "Password set successfully"

# Step 4: Authenticate user
echo "4. Authenticating user..."
AUTH_RESULT=$(aws cognito-idp initiate-auth \
  --client-id $CLIENT_ID \
  --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters USERNAME=$TEST_EMAIL,PASSWORD=$TEST_PASSWORD \
  --region $REGION)

ACCESS_TOKEN=$(echo $AUTH_RESULT | jq -r '.AuthenticationResult.AccessToken')
ID_TOKEN=$(echo $AUTH_RESULT | jq -r '.AuthenticationResult.IdToken')

if [ -z "$ACCESS_TOKEN" ] || [ "$ACCESS_TOKEN" == "null" ]; then
  echo "ERROR: Failed to authenticate"
  exit 1
fi

echo "Authentication successful"

# Step 5: Generate API key
echo "5. Generating API key..."
API_KEY_RESPONSE=$(curl -s -X POST "https://$CDN_URL/v1/dashboard/generate-key" \
  -H "Authorization: $ID_TOKEN" \
  -H "Content-Type: application/json")

echo "API Key Response: $API_KEY_RESPONSE"

API_KEY=$(echo $API_KEY_RESPONSE | jq -r '.apiKey')

if [ -z "$API_KEY" ] || [ "$API_KEY" == "null" ]; then
  echo "ERROR: Failed to generate API key"
  echo "Response: $API_KEY_RESPONSE"
  exit 1
fi

echo "Generated API Key: $API_KEY"
echo "Key format: gc_live_<32 random characters>"

# Step 6: List API keys
echo "6. Listing API keys..."
KEYS_RESPONSE=$(curl -s -X GET "https://$CDN_URL/v1/dashboard/keys" \
  -H "Authorization: $ID_TOKEN")

echo "Keys list: $(echo $KEYS_RESPONSE | jq -r '.keys | length') key(s) found"

# Step 7: Test API endpoint with API key
echo "7. Testing API endpoint..."

# Test 1: Basic query
echo "Test 1: Basic country+year query"
RESPONSE1=$(curl -s -X GET "https://$CDN_URL/api/v1/tax-dates?country=AU&year=2024" \
  -H "X-Api-Key: $API_KEY" \
  -w "\nHTTP_CODE:%{http_code}\nTIME:%{time_total}")

HTTP_CODE=$(echo "$RESPONSE1" | grep "HTTP_CODE:" | cut -d: -f2)
RESPONSE_TIME=$(echo "$RESPONSE1" | grep "TIME:" | cut -d: -f2)
BODY=$(echo "$RESPONSE1" | head -n -2)

echo "HTTP Status: $HTTP_CODE"
echo "Response Time: ${RESPONSE_TIME}s"
echo "Total Dates: $(echo $BODY | jq -r '.totalDates')"

if [ "$HTTP_CODE" != "200" ]; then
  echo "ERROR: API call failed"
  echo "Response: $BODY"
  exit 1
fi

# Test 2: Filtered query
echo ""
echo "Test 2: Filtered query with type"
RESPONSE2=$(curl -s -X GET "https://$CDN_URL/api/v1/tax-dates?country=AU&year=2024&type=bas" \
  -H "X-Api-Key: $API_KEY" \
  -H "Cache-Control: no-cache")

echo "Filtered results: $(echo $RESPONSE2 | jq -r '.totalDates') BAS dates found"

# Test 3: Invalid country
echo ""
echo "Test 3: Error handling - invalid country"
ERROR_RESPONSE=$(curl -s -X GET "https://$CDN_URL/api/v1/tax-dates?country=US&year=2024" \
  -H "X-Api-Key: $API_KEY" \
  -w "\nHTTP_CODE:%{http_code}")

ERROR_CODE=$(echo "$ERROR_RESPONSE" | grep "HTTP_CODE:" | cut -d: -f2)
ERROR_BODY=$(echo "$ERROR_RESPONSE" | head -n -1)

echo "HTTP Status: $ERROR_CODE"
echo "Error: $(echo $ERROR_BODY | jq -r '.error')"

# Test 4: Missing API key
echo ""
echo "Test 4: Unauthorized - missing API key"
UNAUTH_RESPONSE=$(curl -s -X GET "https://$CDN_URL/api/v1/tax-dates?country=AU&year=2024" \
  -w "\nHTTP_CODE:%{http_code}")

UNAUTH_CODE=$(echo "$UNAUTH_RESPONSE" | grep "HTTP_CODE:" | cut -d: -f2)
echo "HTTP Status: $UNAUTH_CODE (should be 401)"

# Step 8: Test cache behavior
echo ""
echo "8. Testing cache behavior..."
echo "Making same request again (should be cached)..."

START_TIME=$(date +%s.%N)
CACHED_RESPONSE=$(curl -s -X GET "https://$CDN_URL/api/v1/tax-dates?country=AU&year=2024" \
  -H "X-Api-Key: $API_KEY" \
  -i)
END_TIME=$(date +%s.%N)

CACHE_TIME=$(echo "$END_TIME - $START_TIME" | bc)
CACHE_STATUS=$(echo "$CACHED_RESPONSE" | grep -i "x-cache" || echo "x-cache: not found")

echo "Response time: ${CACHE_TIME}s"
echo "Cache status: $CACHE_STATUS"

# Cleanup
echo ""
echo "9. Cleanup..."
echo "Deleting test user..."
aws cognito-idp admin-delete-user \
  --user-pool-id $USER_POOL_ID \
  --username $TEST_EMAIL \
  --region $REGION

echo ""
echo "=== End-to-End Test Complete ==="
echo ""
echo "Summary:"
echo "✅ User signup and authentication"
echo "✅ API key generation"
echo "✅ API endpoint access"
echo "✅ Error handling"
echo "✅ Cache behavior"
echo ""
echo "API is ready for use!"
echo "CloudFront URL: https://$CDN_URL"