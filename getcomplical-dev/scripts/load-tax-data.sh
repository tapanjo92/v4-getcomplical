#!/bin/bash

# Script to load tax data into DynamoDB using the Data Loader Lambda

FUNCTION_NAME=$(aws cloudformation describe-stacks \
  --stack-name GetComplicalApiComputeStack \
  --query "Stacks[0].Outputs[?OutputKey=='DataLoaderFunctionName'].OutputValue" \
  --output text \
  --region ap-south-1)

if [ -z "$FUNCTION_NAME" ]; then
  echo "Error: Could not find Data Loader function name"
  exit 1
fi

echo "Using Lambda function: $FUNCTION_NAME"

# Load Australia 2024 data
echo "Loading Australia 2024 tax data..."
aws lambda invoke \
  --function-name $FUNCTION_NAME \
  --payload '{"country": "AU", "year": 2024}' \
  --region ap-south-1 \
  /tmp/au-2024-response.json

cat /tmp/au-2024-response.json | jq '.'

# Load New Zealand 2024 data
echo "Loading New Zealand 2024 tax data..."
aws lambda invoke \
  --function-name $FUNCTION_NAME \
  --payload '{"country": "NZ", "year": 2024}' \
  --region ap-south-1 \
  /tmp/nz-2024-response.json

cat /tmp/nz-2024-response.json | jq '.'

# Load all 2025 data
echo "Loading all 2025 tax data..."
aws lambda invoke \
  --function-name $FUNCTION_NAME \
  --payload '{"country": "ALL", "year": 2025}' \
  --region ap-south-1 \
  /tmp/all-2025-response.json

cat /tmp/all-2025-response.json | jq '.'

echo "Tax data loading complete!"