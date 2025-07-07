# GetComplical Deployment Guide V2

## Prerequisites

### Required Tools
- **Node.js**: Version 20.x or higher
- **AWS CLI**: Version 2.x configured with credentials
- **AWS CDK**: Version 2.x (`npm install -g aws-cdk`)
- **Docker**: For Lambda function bundling

### AWS Account Requirements
- Administrator access or IAM role with permissions for:
  - Lambda, API Gateway, DynamoDB
  - CloudFront, CloudWatch, X-Ray
  - VPC, ElastiCache (Valkey)
  - Kinesis Firehose, S3, Glue
  - WAF (in us-east-1 region)
  - Secrets Manager, IAM

## Deployment Steps

### 1. Initial Setup

```bash
# Clone repository
git clone https://github.com/your-org/getcomplical-dev.git
cd getcomplical-dev

# Install dependencies
npm install

# Install Lambda layer dependencies
cd layers/redis && npm install && cd ../..

# Bootstrap CDK (first time only)
cdk bootstrap aws://ACCOUNT-ID/ap-south-1
cdk bootstrap aws://ACCOUNT-ID/us-east-1  # For WAF
```

### 2. Deploy Infrastructure Stacks

Deploy stacks in this specific order:

```bash
# 1. Secrets Stack - API keys and configurations
cdk deploy GetComplicalSecretsStack

# 2. Auth Stack - Cognito user pool
cdk deploy GetComplicalAuthStack

# 3. Storage Stack - DynamoDB tables
cdk deploy GetComplicalStorageStack

# 4. Streaming Stack - Valkey & Kinesis Firehose
cdk deploy GetComplicalStreamingStackV2

# 5. Billing Stack - Usage monitoring functions
cdk deploy GetComplicalBillingStack

# 6. WAF Stack - Deploy to us-east-1
cdk deploy GetComplicalWafStack --region us-east-1

# 7. API Stack - Private API Gateway
cdk deploy GetComplicalApiComputeStack

# 8. CDN Stack - CloudFront distribution
cdk deploy GetComplicalCdnStack

# 9. Monitoring Stack - CloudWatch dashboards
cdk deploy GetComplicalMonitoringStack

# 10. Backup Stack - Automated backups
cdk deploy GetComplicalBackupStack

# 11. Analytics Stack - Data processing
cdk deploy GetComplicalAnalyticsStack
```

Or deploy all at once:
```bash
cdk deploy --all --require-approval never
```

### 3. Load Tax Data

```bash
# Load Australian tax data
npm run load-data -- --country AU --year 2024 --file data/au-tax-dates-2024.csv
npm run load-data -- --country AU --year 2025 --file data/au-tax-dates-2025.csv

# Load New Zealand tax data  
npm run load-data -- --country NZ --year 2024 --file data/nz-tax-dates-2024.csv
npm run load-data -- --country NZ --year 2025 --file data/nz-tax-dates-2025.csv
```

### 4. Create Test User and API Key

```bash
# Create Cognito user
aws cognito-idp admin-create-user \
  --user-pool-id YOUR_USER_POOL_ID \
  --username test@example.com \
  --user-attributes Name=email,Value=test@example.com \
  --temporary-password TempPass123!

# Generate API key via dashboard
curl -X POST https://YOUR_CLOUDFRONT_DOMAIN/v1/dashboard/keys \
  -H "Authorization: Bearer YOUR_COGNITO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Test Key", "tier": "free"}'
```

### 5. Verify Deployment

```bash
# Test health endpoint (no auth required)
curl https://YOUR_CLOUDFRONT_DOMAIN/health

# Test API with key
curl -H "X-Api-Key: YOUR_API_KEY" \
  "https://YOUR_CLOUDFRONT_DOMAIN/api/v1/tax-dates?country=AU&year=2024"

# Verify private API (should fail)
curl https://YOUR_API_GATEWAY_ID.execute-api.ap-south-1.amazonaws.com/v1/health
# Expected: 403 Forbidden
```

## Stack Outputs

After deployment, note these important values:

- **CloudFront Domain**: `d2uhe8jerdqq3g.cloudfront.net` (example)
- **User Pool ID**: Found in GetComplicalAuthStack outputs
- **Monitoring Dashboard**: CloudWatch dashboard URL
- **Valkey Endpoint**: For debugging (VPC access only)

## Common Issues

### 1. Stack Creation Failed
- Check CloudFormation events for specific errors
- Ensure IAM permissions are sufficient
- Verify no resource naming conflicts

### 2. API Returns 403 Forbidden
- Ensure you're using CloudFront URL, not API Gateway URL
- Check API key is valid and active
- Verify rate limits haven't been exceeded

### 3. Valkey Connection Issues
- Lambda functions must be in VPC
- Security groups must allow Redis port (6379)
- Valkey cluster must be available

### 4. Deployment Timeouts
- CloudFront distribution can take 15-20 minutes
- Use `--require-approval never` to avoid prompts
- Check AWS service limits in your region

## Cleanup

To remove all resources:

```bash
# Delete in reverse order
cdk destroy GetComplicalAnalyticsStack
cdk destroy GetComplicalBackupStack
cdk destroy GetComplicalMonitoringStack
cdk destroy GetComplicalCdnStack
cdk destroy GetComplicalApiComputeStack
cdk destroy GetComplicalWafStack --region us-east-1
cdk destroy GetComplicalBillingStack
cdk destroy GetComplicalStreamingStackV2
cdk destroy GetComplicalStorageStack
cdk destroy GetComplicalAuthStack
cdk destroy GetComplicalSecretsStack

# Or destroy all
cdk destroy --all
```

## Cost Estimates

Monthly costs (approximate):
- **Development**: ~$45-60
  - Valkey: $12 (t3.micro)
  - NAT Gateway: $32
  - Other services: $10-15

- **Production**: ~$200-300
  - Valkey: $104 (r7g.large)
  - CloudFront: $50-100
  - Lambda/API Gateway: Variable
  - Data storage: $10-20

## Next Steps

1. Configure CloudWatch alarms
2. Set up billing alerts
3. Implement backup testing
4. Configure custom domain
5. Enable AWS GuardDuty
6. Set up AWS Config rules