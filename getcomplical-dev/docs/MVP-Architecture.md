# GetComplical Tax API - MVP Architecture

## Overview

GetComplical is a serverless tax calendar API service for Australia and New Zealand, similar to Calendarific but focused on tax-related dates and deadlines. Built on AWS using CDK v2 for infrastructure as code.

## Architecture Components

### 1. Authentication & User Management
- **AWS Cognito User Pool**: Handles user registration, authentication, and account management
- **Custom Attributes**: tier (free/premium), company name
- **Self-signup enabled** with email verification
- **OAuth 2.0 support** for future integrations

### 2. API Gateway & Compute
- **REST API** with request validation and CORS support
- **Custom Lambda Authorizer** for API key validation
- **Rate Limiting**: 1000 requests/day for free tier
- **Usage Plans**: Extensible for different tiers

### 3. Lambda Functions

#### Authorizer Function
- Validates API keys on every request
- Tracks usage and enforces rate limits
- Updates usage counters in real-time

#### API Handler Function
- Serves tax calendar data for AU/NZ
- Query by country, year, and tax type
- Returns JSON with tax dates and deadlines

#### Dashboard Function
- Generates new API keys for authenticated users
- Lists existing keys with usage statistics
- Manages API key lifecycle

### 4. Data Storage

#### DynamoDB Tables

**ApiKeysTable**
- Primary Key: apiKey
- GSI: userId-index (for user queries)
- Attributes: status, tier, dailyLimit, usageToday, totalUsage

**TaxDataTable**
- Composite Key: pk (country#year), sk (date)
- GSI: type-date-index (for filtering by tax type)
- Stores all tax dates, deadlines, and descriptions

### 5. Content Delivery
- **CloudFront Distribution**: Global edge caching
- **Cache Strategy**: 24-hour TTL for tax data
- **Origin**: API Gateway with path-based routing
- **Compression**: Gzip and Brotli enabled

### 6. Monitoring & Observability
- **CloudWatch Dashboards**: API metrics, Lambda performance
- **X-Ray Tracing**: Distributed tracing enabled
- **Alarms**: 5XX errors, Lambda failures
- **Metrics**: Request count, latency, error rates

## API Endpoints

### Public Endpoints (Require API Key)

```
GET /api/v1/tax-dates?country=AU&year=2024&type=filing
```

**Headers Required:**
- `X-Api-Key: txs_live_xxxxxxxxxx`

**Query Parameters:**
- `country` (required): AU or NZ
- `year` (required): Year in YYYY format
- `type` (optional): Filter by tax type (filing, payment, gst, etc.)

**Response:**
```json
{
  "country": "AU",
  "year": 2024,
  "totalDates": 12,
  "dates": [
    {
      "date": "2024-07-31",
      "name": "Individual Tax Return Deadline",
      "description": "Last day to lodge tax return",
      "type": "filing",
      "isPublicHoliday": false,
      "isBusinessDay": true
    }
  ]
}
```

### Dashboard Endpoints (Require Cognito Auth)

```
POST /dashboard/generate-key
Authorization: Bearer {cognito-access-token}
```

**Response:**
```json
{
  "apiKey": "txs_live_abc123...",
  "createdAt": "2024-01-15T10:00:00Z",
  "tier": "free",
  "dailyLimit": 1000
}
```

```
GET /dashboard/keys
Authorization: Bearer {cognito-access-token}
```

**Response:**
```json
{
  "keys": [
    {
      "apiKey": "txs_live_abc123...",
      "status": "active",
      "tier": "free",
      "dailyLimit": 1000,
      "usageToday": 45,
      "totalUsage": 1234,
      "createdAt": "2024-01-15T10:00:00Z",
      "lastUsedDate": "2024-01-20"
    }
  ]
}
```

## Security Model

### API Key Management
- **Format**: `txs_live_` prefix + 32 character nanoid
- **Storage**: Plain text in DynamoDB (as discussed)
- **Validation**: Lambda authorizer on every request
- **Rate Limiting**: Per-key daily limits enforced

### Authentication Flow
1. User registers/logs in via Cognito
2. Dashboard generates API key
3. API key used for all data requests
4. Usage tracked and limited per key

### Security Best Practices
- No hardcoded secrets
- IAM roles with least privilege
- VPC not required (all managed services)
- API Gateway request validation
- CORS configured for web clients

## Deployment Architecture

### CDK Stack Organization
1. **AuthStack**: Cognito resources
2. **StorageStack**: DynamoDB tables
3. **ApiComputeStack**: Lambda + API Gateway
4. **CdnStack**: CloudFront distribution
5. **MonitoringStack**: CloudWatch resources

### Region Deployment
- Primary Region: `ap-south-1` (Mumbai)
- CloudFront: Global distribution
- Future: Multi-region data replication

## Cost Structure (MVP)

### Estimated Monthly Costs
- **Lambda**: $0 (within free tier)
- **DynamoDB**: ~$2 (on-demand mode)
- **API Gateway**: $3.50 per million requests
- **CloudFront**: $0.085 per GB transfer
- **Cognito**: $0 (under 50K MAU)

**Total**: $5-10/month for low usage

### Cost Optimization
- CloudFront caching reduces Lambda invocations by 80-90%
- DynamoDB on-demand scales to zero
- No idle compute costs

## Scalability Considerations

### Current Limits
- API Gateway: 10K requests/second
- Lambda: 1000 concurrent executions
- DynamoDB: Auto-scaling with on-demand

### Future Scaling
- DynamoDB global tables for multi-region
- Lambda reserved concurrency for consistent performance
- API Gateway caching for popular queries
- ElastiCache for session management

## Development Workflow

### Local Development
```bash
# Install dependencies
npm install

# Run TypeScript compiler
npm run build

# Synthesize CDK
npm run synth
```

### Deployment
```bash
# Deploy all stacks
npm run deploy

# Deploy specific stack
npx cdk deploy GetComplicalApiComputeStack
```

### Testing
- Use Postman or curl for API testing
- CloudWatch Logs for debugging
- X-Ray for performance analysis

## Future Enhancements

### Phase 2 Features
- Premium tiers with higher limits
- Webhook notifications for tax deadlines
- Bulk data export (CSV/JSON)
- Historical tax data

### Phase 3 Features
- GraphQL API option
- Real-time updates via WebSocket
- Mobile SDK (iOS/Android)
- SLA guarantees for enterprise

## Operational Runbook

### Monitoring
- Check CloudWatch dashboard daily
- Review API error rates
- Monitor DynamoDB throttling
- Track CloudFront cache hit ratio

### Common Issues
1. **Rate limit exceeded**: Check user's tier and usage
2. **API key invalid**: Verify key status in DynamoDB
3. **High latency**: Check Lambda cold starts
4. **5XX errors**: Review Lambda logs in CloudWatch

### Backup & Recovery
- DynamoDB point-in-time recovery enabled
- Lambda code versioning enabled
- Infrastructure as code in Git