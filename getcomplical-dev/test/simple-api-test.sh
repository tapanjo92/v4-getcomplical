#!/bin/bash

# Simple test script to debug API authentication

echo "=== Simple API Test ==="

# Get user credentials
USER_EMAIL=${1:-"test-$(date +%s)@example.com"}
PASSWORD="TestPass123!"

# Get stack outputs
USER_POOL_ID=$(aws cloudformation describe-stacks \
  --stack-name GetComplicalAuthStack \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" \
  --output text \
  --region ap-south-1)

CLIENT_ID=$(aws cloudformation describe-stacks \
  --stack-name GetComplicalAuthStack \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolClientId'].OutputValue" \
  --output text \
  --region ap-south-1)

API_URL=$(aws cloudformation describe-stacks \
  --stack-name GetComplicalApiComputeStack \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" \
  --output text \
  --region ap-south-1)

echo "User Pool: $USER_POOL_ID"
echo "Client ID: $CLIENT_ID"
echo "API URL: $API_URL"
echo ""

# Create user if needed
echo "1. Creating user: $USER_EMAIL"
aws cognito-idp admin-create-user \
  --user-pool-id $USER_POOL_ID \
  --username $USER_EMAIL \
  --user-attributes Name=email,Value=$USER_EMAIL \
  --temporary-password TempPass123! \
  --message-action SUPPRESS \
  --region ap-south-1 2>/dev/null || echo "User may already exist"

# Set permanent password
aws cognito-idp admin-set-user-password \
  --user-pool-id $USER_POOL_ID \
  --username $USER_EMAIL \
  --password $PASSWORD \
  --permanent \
  --region ap-south-1

echo "2. Authenticating..."
AUTH_RESULT=$(aws cognito-idp initiate-auth \
  --client-id $CLIENT_ID \
  --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters USERNAME=$USER_EMAIL,PASSWORD=$PASSWORD \
  --region ap-south-1)

ID_TOKEN=$(echo $AUTH_RESULT | jq -r '.AuthenticationResult.IdToken')
ACCESS_TOKEN=$(echo $AUTH_RESULT | jq -r '.AuthenticationResult.AccessToken')

echo "Got tokens (showing first 50 chars):"
echo "ID Token: ${ID_TOKEN:0:50}..."
echo "Access Token: ${ACCESS_TOKEN:0:50}..."
echo ""

# Test with ID token (which is what Cognito authorizer expects)
echo "3. Testing API with ID token..."
curl -X POST "${API_URL}dashboard/generate-key" \
  -H "Authorization: $ID_TOKEN" \
  -H "Content-Type: application/json" \
  -w "\nStatus: %{http_code}\n" \
  -v 2>&1 | grep -E "< HTTP|Status:|{"

echo ""
echo "4. Testing API with Access token..."
curl -X POST "${API_URL}dashboard/generate-key" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -w "\nStatus: %{http_code}\n" \
  -v 2>&1 | grep -E "< HTTP|Status:|{"

echo ""
echo "Done!"