# GetComplical - AWS Architecture Review Guide

## Executive Summary (2 minutes)
"GetComplical is a tax calendar API service for Australia and New Zealand, similar to Calendarific but focused on tax compliance dates. It provides RESTful APIs for businesses to integrate tax deadlines into their applications."

### Business Value
- Helps businesses avoid tax penalties by tracking 66+ compliance dates
- SaaS model with API key-based billing
- Targets accounting software, payroll systems, and business apps

## Architecture Overview (5 minutes)

### Design Principles
1. **Serverless-First**: Zero infrastructure management
2. **API-First**: Everything is an API (including admin functions)
3. **Security by Design**: Multiple auth layers, principle of least privilege
4. **Cost-Optimized**: Pay-per-use, aggressive caching
5. **Multi-Region Ready**: CloudFront global distribution

### Tech Stack
- **IaC**: AWS CDK v2 (TypeScript)
- **Compute**: Lambda (Node.js 20.x)
- **API**: API Gateway REST API
- **Auth**: Cognito (users) + Lambda Authorizer (API keys)
- **Storage**: DynamoDB (on-demand)
- **CDN**: CloudFront with custom cache policies
- **Monitoring**: CloudWatch Dashboard + X-Ray

## Key Architectural Decisions (10 minutes)

### 1. Authentication Strategy
```
Users → Cognito → JWT → Dashboard → Generate API Key → Use API
```
- **Why Cognito + API Keys**: 
  - Cognito for user management (sign up, password reset)
  - API keys for usage tracking and billing
  - Similar to Stripe, Twilio pattern

### 2. DynamoDB Design
```
Table: getcomplical-api-keys
PK: apiKey
GSI: userId-index (for dashboard queries)

Table: getcomplical-tax-data  
PK: COUNTRY#YEAR (e.g., AU#2024)
SK: DATE#TYPE (e.g., 2024-07-31#income-tax)
```
- **Single Table Design**: Considered but separated for access patterns
- **On-Demand Billing**: Predictable costs, no capacity planning

### 3. Caching Strategy
```
Popular queries (AU/NZ + year): 24 hours
Filtered queries (with type/state): 6 hours
```
- **Why Different TTLs**: Balance freshness vs cost
- **CloudFront**: Reduces Lambda invocations by 70-90%

### 4. API Design
```
GET /api/v1/tax-dates?country=AU&year=2024&type=bas
```
- **Server-Side Filtering**: DynamoDB FilterExpression
- **Why Not GraphQL**: Simple queries, REST is sufficient

## Security Review (5 minutes)

### 1. Authentication & Authorization
- **Cognito User Pool**: Email/password with MFA ready
- **API Keys**: 32-char random, gc_live_ prefix
- **Lambda Authorizer**: Validates keys, enforces rate limits

### 2. Network Security
- **All HTTPS**: API Gateway + CloudFront
- **CORS**: Configured for browser-based access
- **No VPC**: Reduces complexity, cold starts

### 3. Data Security
- **Encryption at Rest**: DynamoDB AWS-managed keys
- **Encryption in Transit**: TLS 1.2+
- **No PII**: Only email stored, no sensitive tax data

### 4. IAM Principles
- **Least Privilege**: Each Lambda has minimal permissions
- **No Hardcoded Credentials**: All via IAM roles
- **Resource-Based Policies**: DynamoDB table access

## Scalability & Performance (5 minutes)

### 1. Current Limits
- API Gateway: 10,000 RPS (soft limit)
- Lambda Concurrent: 1,000 (soft limit)
- DynamoDB: On-demand scales automatically

### 2. Performance Optimizations
- **Lambda**: Bundled, minified, tree-shaken
- **Cold Starts**: ~200ms, mitigated by CloudFront
- **Database**: Single query for all operations

### 3. Scaling Strategy
- **Horizontal**: More Lambda concurrent executions
- **Caching**: CloudFront handles read scaling
- **Database**: DynamoDB auto-scales, GSI for query patterns

## Cost Analysis (3 minutes)

### Monthly Estimates (1M requests)
- Lambda: $20 (with free tier)
- API Gateway: $3.50
- DynamoDB: $5 (mostly storage)
- CloudFront: $10 (bandwidth)
- **Total**: ~$40/month for 1M API calls

### Cost Optimizations
1. CloudFront caching reduces Lambda by 80%
2. DynamoDB on-demand (no over-provisioning)
3. Lambda ARM architecture (not implemented yet)

## Operational Excellence (5 minutes)

### 1. Monitoring
- **CloudWatch Dashboard**: Real-time metrics
- **Alarms**: Errors, latency, cache ratio
- **X-Ray**: Distributed tracing enabled

### 2. Deployment
- **CI/CD Ready**: CDK deploy commands
- **Blue/Green**: API Gateway stage deployments
- **Rollback**: CloudFormation stack updates

### 3. Disaster Recovery
- **RTO**: 5 minutes (redeploy)
- **RPO**: 0 (DynamoDB point-in-time recovery)
- **Backups**: DynamoDB PITR enabled

## Areas for Enhancement (3 minutes)

### 1. Immediate Improvements
- Add WAF for DDoS protection
- Implement request throttling per API key
- Add CloudWatch Logs Insights queries

### 2. Future Roadmap
- Multi-region deployment (US, EU)
- GraphQL API option
- Webhook notifications for tax date changes
- Mobile SDKs

### 3. Enterprise Features
- SSO integration (SAML)
- Private API Gateway endpoints
- Custom domain with Route 53
- AWS Organizations integration

## Demo Flow (5 minutes)
1. Show CDK code structure
2. Create user → Generate API key → Make API call
3. Show CloudWatch dashboard
4. Demonstrate caching (make same request twice)
5. Show error handling

## Questions to Prepare For

### Architecture
- "Why serverless over containers?"
- "How do you handle timezone differences?"
- "What's your multi-region strategy?"

### Security
- "How do you rotate API keys?"
- "What's your incident response plan?"
- "How do you prevent API abuse?"

### Cost
- "What's your break-even point?"
- "How do you handle free tier abuse?"
- "Cost per transaction?"

### Technical
- "Why REST over GraphQL?"
- "Database migration strategy?"
- "How do you update tax data?"

## Key Metrics to Show
- Current: 66 tax dates (42 AU + 24 NZ)
- Latency: <100ms cached, <500ms uncached  
- Availability: 99.9% (API Gateway SLA)
- Cost per 1000 API calls: $0.04