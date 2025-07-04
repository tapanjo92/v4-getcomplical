# GetComplical Tax API - MVP

A serverless tax calendar API for Australia and New Zealand, built with AWS CDK v2.

## Architecture

- **Authentication**: AWS Cognito for user management
- **API Gateway**: REST API with custom authorizer
- **Lambda Functions**: Node.js 20.x runtime
- **Storage**: DynamoDB for tax data and API keys
- **CDN**: CloudFront for global caching
- **Monitoring**: CloudWatch dashboards and X-Ray tracing

## Prerequisites

- AWS CLI configured with credentials
- Node.js 20.x
- AWS CDK CLI: `npm install -g aws-cdk`

## Setup

1. Install dependencies:
```bash
npm install
```

2. Bootstrap CDK (first time only):
```bash
npx cdk bootstrap aws://ACCOUNT-ID/ap-south-1
```

3. Deploy all stacks from the project root (NOT from infrastructure folder):
```bash
npm run deploy
```

## API Endpoints

### Public API (requires API key)
- `GET /api/v1/tax-dates?country=AU&year=2024&type=filing`

### Dashboard (requires Cognito auth)
- `GET /dashboard/keys` - List user's API keys
- `POST /dashboard/generate-key` - Generate new API key

## API Key Format
- Production: `txs_live_[32-char-id]`
- Test: `txs_test_[32-char-id]`

## Usage Example

```bash
curl -X GET "https://YOUR-CLOUDFRONT-URL/api/v1/tax-dates?country=AU&year=2024" \
  -H "X-Api-Key: txs_live_your_api_key_here"
```

## Stack Outputs

After deployment, you'll get:
- CloudFront URL
- API Gateway URL
- Cognito User Pool ID
- DynamoDB table names

## Cleanup

```bash
npm run destroy
```

## Cost Estimates (MVP)

- Lambda: Free tier (1M requests/month)
- DynamoDB: ~$2/month (on-demand)
- API Gateway: ~$3.50/1M requests
- CloudFront: ~$0.085/GB transfer
- Cognito: Free tier (50K MAU)

Total: ~$5-10/month for low usage