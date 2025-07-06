#!/bin/bash

# This script tests the dashboard endpoints with a mock Cognito token
# In a real scenario, you would authenticate with Cognito to get a valid token

API_URL="https://o7p7m3vwcb.execute-api.ap-south-1.amazonaws.com/v1"

# For testing purposes, we'll use a mock token
# In production, this would be obtained from Cognito authentication
MOCK_TOKEN="Bearer mock-token-for-testing"

echo "Testing Dashboard Endpoints..."
echo "=============================="

# Test 1: Get API Keys
echo -e "\n1. Testing GET /dashboard/keys"
curl -X GET "$API_URL/dashboard/keys" \
  -H "Authorization: $MOCK_TOKEN" \
  -H "Content-Type: application/json" \
  -w "\nHTTP Status: %{http_code}\n"

# Test 2: Get Tiers
echo -e "\n\n2. Testing GET /dashboard/tiers"
curl -X GET "$API_URL/dashboard/tiers" \
  -H "Authorization: $MOCK_TOKEN" \
  -H "Content-Type: application/json" \
  -w "\nHTTP Status: %{http_code}\n"

# Test 3: Get Monthly Usage
echo -e "\n\n3. Testing GET /dashboard/usage/monthly"
curl -X GET "$API_URL/dashboard/usage/monthly?month=2025-07" \
  -H "Authorization: $MOCK_TOKEN" \
  -H "Content-Type: application/json" \
  -w "\nHTTP Status: %{http_code}\n"

# Test 4: Get Daily Usage for specific API key
echo -e "\n\n4. Testing GET /dashboard/usage/daily"
curl -X GET "$API_URL/dashboard/usage/daily?apiKey=gc_live_zK0TxKukbjOwy06Xnw6HeJFls5_89t5L" \
  -H "Authorization: $MOCK_TOKEN" \
  -H "Content-Type: application/json" \
  -w "\nHTTP Status: %{http_code}\n"

# Test 5: Get Real-time Usage
echo -e "\n\n5. Testing GET /dashboard/usage/realtime"
curl -X GET "$API_URL/dashboard/usage/realtime?apiKey=gc_live_zK0TxKukbjOwy06Xnw6HeJFls5_89t5L" \
  -H "Authorization: $MOCK_TOKEN" \
  -H "Content-Type: application/json" \
  -w "\nHTTP Status: %{http_code}\n"

echo -e "\n\nDashboard endpoint testing complete!"