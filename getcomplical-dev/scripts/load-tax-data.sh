#!/bin/bash

# Script to load tax data into DynamoDB using the Data Loader Lambda

FUNCTION_NAME=$(aws lambda list-functions \
  --query "Functions[?contains(FunctionName, 'DataLoader')].FunctionName" \
  --output text \
  --region ap-south-1 | head -1)

if [ -z "$FUNCTION_NAME" ]; then
  echo "Error: Could not find Data Loader function name"
  exit 1
fi

echo "Using Lambda function: $FUNCTION_NAME"

# Load Australia 2024 data
echo "Loading Australia 2024 tax data..."
aws lambda invoke \
  --function-name $FUNCTION_NAME \
  --cli-binary-format raw-in-base64-out \
  --payload '{"country": "AU", "year": 2024}' \
  --region ap-south-1 \
  /tmp/au-2024-response.json

cat /tmp/au-2024-response.json | jq '.'

# Load New Zealand 2024 data
echo "Loading New Zealand 2024 tax data..."
aws lambda invoke \
  --function-name $FUNCTION_NAME \
  --cli-binary-format raw-in-base64-out \
  --payload '{"country": "NZ", "year": 2024}' \
  --region ap-south-1 \
  /tmp/nz-2024-response.json

cat /tmp/nz-2024-response.json | jq '.'

# Load all 2025 data
echo "Loading all 2025 tax data..."
aws lambda invoke \
  --function-name $FUNCTION_NAME \
  --cli-binary-format raw-in-base64-out \
  --payload '{"country": "ALL", "year": 2025}' \
  --region ap-south-1 \
  /tmp/all-2025-response.json

cat /tmp/all-2025-response.json | jq '.'

echo "Tax data loading complete!"