# GetComplical Deployment Guide

## Prerequisites

### Required Tools
- **Node.js**: Version 20.x or higher
- **AWS CLI**: Configured with appropriate credentials
- **AWS CDK**: Version 2.x (`npm install -g aws-cdk`)
- **Docker**: For Lambda function bundling

### AWS Account Setup
- AWS account with appropriate permissions
- IAM user/role with permissions to create:
  - Lambda functions
  - API Gateway
  - DynamoDB tables
  - CloudFront distributions
  - Cognito user pools
  - CloudWatch resources
  - IAM roles and policies

### AWS Credentials
Configure AWS credentials using one of these methods:

```bash
# Option 1: AWS CLI
aws configure

# Option 2: Environment variables
export AWS_ACCESS_KEY_ID=your_access_key
export AWS_SECRET_ACCESS_KEY=your_secret_key
export AWS_DEFAULT_REGION=ap-south-1

# Option 3: AWS profiles
export AWS_PROFILE=your_profile_name
```

## Initial Setup

### 1. Clone and Install

```bash
# Clone the repository
git clone https://github.com/your-org/getcomplical-dev.git
cd getcomplical-dev

# Install dependencies
npm install

# Install Lambda dependencies
cd lambdas/auth && npm install && cd ../..
cd lambdas/api && npm install && cd ../..
```

### 2. CDK Bootstrap

First-time CDK deployment requires bootstrapping:

```bash
# Get your AWS account ID
aws sts get-caller-identity --query Account --output text

# Bootstrap CDK (replace 123456789012 with your account ID)
npx cdk bootstrap aws://123456789012/ap-south-1
```

## Deployment Steps

### 1. Full Deployment

Deploy all stacks in the correct order:

```bash
# From project root directory (important!)
npm run deploy
```

This will deploy:
1. GetComplicalAuthStack (Cognito)
2. GetComplicalStorageStack (DynamoDB)
3. GetComplicalApiComputeStack (Lambda + API Gateway)
4. GetComplicalCdnStack (CloudFront)
5. GetComplicalMonitoringStack (CloudWatch)

### 2. Individual Stack Deployment

Deploy specific stacks:

```bash
# Deploy only the storage stack
npx cdk deploy GetComplicalStorageStack

# Deploy multiple specific stacks
npx cdk deploy GetComplicalAuthStack GetComplicalStorageStack
```

### 3. Update Existing Deployment

```bash
# See what changes will be made
npx cdk diff

# Deploy updates
npm run deploy
```

## Post-Deployment Configuration

### 1. Retrieve Stack Outputs

After deployment, note the important outputs:

```bash
# List all stack outputs
aws cloudformation describe-stacks --region ap-south-1 \
  --query "Stacks[?contains(StackName, 'GetComplical')].Outputs" \
  --output table
```

Key outputs to note:
- **CloudFront URL**: Your API endpoint
- **User Pool ID**: For Cognito authentication
- **API Gateway URL**: Direct API access (bypassing CDN)
- **DynamoDB Table Names**: For data management

### 2. Create Initial Admin User

```bash
# Create admin user in Cognito
aws cognito-idp admin-create-user \
  --user-pool-id YOUR_USER_POOL_ID \
  --username admin@example.com \
  --user-attributes Name=email,Value=admin@example.com \
  --temporary-password TempPass123! \
  --region ap-south-1
```

### 3. Load Initial Tax Data

Create a script to load tax data into DynamoDB:

```javascript
// load-tax-data.js
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({ region: 'ap-south-1' });
const docClient = DynamoDBDocumentClient.from(client);

const taxData = [
  {
    pk: 'AU#2024',
    sk: '2024-07-31',
    date: '2024-07-31',
    name: 'Individual Tax Return Deadline',
    description: 'Last day to lodge 2023-24 individual tax return',
    type: 'filing',
    country: 'AU',
    year: 2024
  },
  // Add more tax dates...
];

async function loadData() {
  for (const item of taxData) {
    await docClient.send(new PutCommand({
      TableName: 'getcomplical-tax-data',
      Item: item
    }));
    console.log(`Loaded: ${item.name}`);
  }
}

loadData().catch(console.error);
```

### 4. Test the API

```bash
# 1. Get an access token (replace with your Cognito app client details)
ACCESS_TOKEN=$(aws cognito-idp initiate-auth \
  --client-id YOUR_CLIENT_ID \
  --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters USERNAME=admin@example.com,PASSWORD=YourPassword \
  --query 'AuthenticationResult.AccessToken' \
  --output text)

# 2. Generate an API key
API_KEY=$(curl -X POST https://YOUR_CLOUDFRONT_URL/dashboard/generate-key \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  | jq -r '.apiKey')

# 3. Test the API
curl -X GET "https://YOUR_CLOUDFRONT_URL/api/v1/tax-dates?country=AU&year=2024" \
  -H "X-Api-Key: $API_KEY"
```

## Environment-Specific Deployments

### Development Environment

```bash
# Deploy with dev suffix
CDK_DEPLOY_ENV=dev npm run deploy
```

### Production Environment

```bash
# Deploy with prod suffix and manual approval
CDK_DEPLOY_ENV=prod npx cdk deploy --all --require-approval broadening
```

## Monitoring Deployment

### Check Stack Status

```bash
# Watch stack creation progress
watch -n 5 'aws cloudformation describe-stacks \
  --region ap-south-1 \
  --query "Stacks[?contains(StackName, '"'GetComplical'"')].{Stack:StackName,Status:StackStatus}" \
  --output table'
```

### View CloudFormation Events

```bash
# See deployment events for debugging
aws cloudformation describe-stack-events \
  --stack-name GetComplicalApiComputeStack \
  --region ap-south-1 \
  --output table
```

## Rollback Procedures

### Automatic Rollback

CDK automatically rolls back on failure. To disable:

```bash
npx cdk deploy --no-rollback
```

### Manual Rollback

```bash
# Rollback to previous version
aws cloudformation cancel-update-stack \
  --stack-name GetComplicalApiComputeStack \
  --region ap-south-1
```

### Complete Removal

```bash
# Destroy all stacks (WARNING: This deletes everything)
npm run destroy

# Or destroy specific stack
npx cdk destroy GetComplicalApiComputeStack
```

## Troubleshooting

### Common Issues

#### 1. Docker Not Running
```
Error: Cannot connect to the Docker daemon
```
**Solution**: Start Docker Desktop or Docker daemon

#### 2. Insufficient IAM Permissions
```
Error: User is not authorized to perform: cloudformation:CreateStack
```
**Solution**: Ensure your AWS credentials have AdministratorAccess or appropriate permissions

#### 3. CDK Version Mismatch
```
Error: This app was built with an outdated version of CDK
```
**Solution**: Update CDK globally and locally:
```bash
npm install -g aws-cdk@latest
npm update aws-cdk-lib
```

#### 4. Lambda Bundling Fails
```
Error: Failed to bundle asset
```
**Solution**: Clear Docker cache and retry:
```bash
docker system prune -f
npm run deploy
```

### Debug Mode

Enable verbose logging:

```bash
# CDK debug mode
export CDK_DEBUG=true
npx cdk deploy --verbose

# CloudFormation detailed events
aws cloudformation describe-stack-events \
  --stack-name GetComplicalApiComputeStack \
  --query 'StackEvents[?ResourceStatus==`CREATE_FAILED`]'
```

## Cost Optimization

### Review Deployed Resources

```bash
# List all resources created
aws resourcegroupstaggingapi get-resources \
  --tag-filters Key=aws:cloudformation:stack-name,Values=GetComplical* \
  --region ap-south-1
```

### Enable Cost Allocation Tags

```typescript
// In your CDK stacks
cdk.Tags.of(this).add('Project', 'GetComplical');
cdk.Tags.of(this).add('Environment', 'Production');
cdk.Tags.of(this).add('CostCenter', 'Engineering');
```

## Security Checklist

- [ ] Enable MFA on AWS root account
- [ ] Use IAM roles instead of access keys where possible
- [ ] Enable CloudTrail for audit logging
- [ ] Review and restrict S3 bucket policies
- [ ] Enable GuardDuty for threat detection
- [ ] Set up billing alerts
- [ ] Review Lambda function permissions
- [ ] Enable API Gateway logging
- [ ] Configure WAF rules for CloudFront

## Next Steps

1. Set up CI/CD pipeline
2. Configure custom domain
3. Enable API Gateway caching
4. Set up backup procedures
5. Configure monitoring alerts
6. Load production tax data
7. Create API documentation site