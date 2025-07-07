# GetComplical API V2 - Testing Guide

## Quick Start

Use the automated test script:
```bash
./test-api-v2.sh
```

Or test with your own API key:
```bash
API_KEY=your_key ./test-api-v2.sh
```

## Architecture Overview

```
User → CloudFront → Private API Gateway → Lambda → DynamoDB
           ↓                    ↓
         WAF              Valkey (Rate Limiting)
                               ↓
                        Kinesis Firehose → S3
```

## Manual Testing Steps

### 1. Health Check (No Auth Required)
```bash
curl https://d2uhe8jerdqq3g.cloudfront.net/health
```

Expected: 200 OK with health status

### 2. Test Private API (Should Fail)
```bash
# Get API ID
API_ID=$(aws cloudformation describe-stacks \
  --stack-name GetComplicalApiComputeStack \
  --query "Stacks[0].Outputs[?OutputKey=='ApiId'].OutputValue" \
  --output text)

# Try direct access (should fail)
curl https://$API_ID.execute-api.ap-south-1.amazonaws.com/v1/health
```

Expected: 403 Forbidden

### 3. Create User and API Key

#### Via Cognito Console:
1. Go to AWS Cognito Console
2. Select user pool from GetComplicalAuthStack
3. Create user with email/password
4. Note the user ID

#### Generate API Key:
```bash
# First, get auth token via Cognito
# Then call dashboard API
curl -X POST https://d2uhe8jerdqq3g.cloudfront.net/v1/dashboard/keys \
  -H "Authorization: Bearer YOUR_COGNITO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Test Key", "tier": "free"}'
```

### 4. Test API Endpoints

#### Get Tax Dates
```bash
curl -H "X-Api-Key: YOUR_API_KEY" \
  "https://d2uhe8jerdqq3g.cloudfront.net/api/v1/tax-dates?country=AU&year=2024"
```

#### With Filters
```bash
curl -H "X-Api-Key: YOUR_API_KEY" \
  "https://d2uhe8jerdqq3g.cloudfront.net/api/v1/tax-dates?country=AU&year=2024&type=return"
```

### 5. Test Rate Limiting

Free tier is limited to 10 requests/day:
```bash
# Make 12 requests
for i in {1..12}; do
  curl -s -o /dev/null -w "Request $i: %{http_code}\n" \
    -H "X-Api-Key: YOUR_API_KEY" \
    "https://d2uhe8jerdqq3g.cloudfront.net/api/v1/tax-dates?country=AU&year=2024"
  sleep 1
done
```

Expected: First 10 return 200, then 429 (Too Many Requests)

### 6. Test Caching

Make the same request twice:
```bash
# First request (miss)
time curl -H "X-Api-Key: YOUR_API_KEY" \
  "https://d2uhe8jerdqq3g.cloudfront.net/api/v1/tax-dates?country=NZ&year=2025"

# Second request (hit - should be faster)
time curl -H "X-Api-Key: YOUR_API_KEY" \
  "https://d2uhe8jerdqq3g.cloudfront.net/api/v1/tax-dates?country=NZ&year=2025"
```

### 7. Check Usage Tracking

View CloudWatch Dashboard:
```bash
aws cloudformation describe-stacks \
  --stack-name GetComplicalMonitoringStack \
  --query "Stacks[0].Outputs[?OutputKey=='DashboardURL'].OutputValue" \
  --output text
```

### 8. Verify Analytics

Check if events are being written to S3:
```bash
BUCKET=$(aws cloudformation describe-stacks \
  --stack-name GetComplicalStreamingStackV2 \
  --query "Stacks[0].Outputs[?OutputKey=='AnalyticsBucketName'].OutputValue" \
  --output text)

aws s3 ls s3://$BUCKET/year=$(date +%Y)/ --recursive
```

## Common Issues

### API Returns 403
- Ensure you're using CloudFront URL, not direct API Gateway URL
- Check API key is valid and starts with `gc_live_`

### Rate Limit Not Working
- Valkey cluster must be available
- Lambda functions must be in VPC
- Check security groups allow Redis port (6379)

### No Analytics Data
- Wait 5 minutes for Firehose buffer
- Check Glue permissions
- Verify Firehose is active

## Load Test Data

To load/reload tax data:
```bash
# Get data loader function
FUNCTION=$(aws lambda list-functions \
  --query "Functions[?contains(FunctionName, 'DataLoader')].FunctionName" \
  --output text)

# Load data
aws lambda invoke \
  --function-name $FUNCTION \
  --cli-binary-format raw-in-base64-out \
  --payload '{"country": "AU", "year": 2024}' \
  /tmp/response.json
```

## Performance Benchmarks

Expected response times:
- Health check: <50ms
- Cached requests: <100ms  
- Uncached requests: <300ms
- First request (cold start): <1000ms

## Security Verification

1. **WAF is Active**: Check CloudFront has WAF attached
2. **API is Private**: Direct API Gateway access returns 403
3. **Rate Limiting**: Valkey enforces daily limits
4. **API Key Required**: Requests without key return 401