# GetComplical Tax API - Current Production Architecture

## Overview

GetComplical is a production-grade serverless tax calendar API service for Australia and New Zealand. Built on AWS using CDK v2, it features a private API Gateway accessible only through CloudFront, Valkey for rate limiting, and comprehensive monitoring.

## Architecture Components

### 1. API Gateway (Private)
- **Private REST API** - Not directly accessible from internet
- **Resource Policy** - Only allows access from CloudFront
- **Request Validation** - Built-in parameter validation
- **API Caching** - 5-minute cache for identical requests

### 2. CloudFront CDN
- **Single Entry Point** - All API traffic must go through CloudFront
- **WAF Protection** - DDoS and security rules in place
- **Edge Caching** - Intelligent caching based on query patterns:
  - Popular queries (country+year): 24-hour TTL
  - Filtered queries (with type): 6-hour TTL
- **Global Distribution** - Low latency worldwide

### 3. Authentication & Authorization

#### AWS Cognito
- User registration and authentication
- OAuth 2.0 support
- Custom attributes: tier, company name

#### Custom Lambda Authorizer
- API key validation (X-Api-Key header)
- Rate limit checking via Valkey
- Usage tracking to Kinesis Firehose
- 5-minute result caching

### 4. Core Lambda Functions

#### API Handler
- Serves tax calendar data for AU/NZ
- Tracks all usage to Kinesis Firehose
- VPC-enabled for Valkey access
- Environment: Node.js 20.x

#### Dashboard Function
- API key management
- Usage statistics retrieval
- Customer tier management

#### Data Loader
- Bulk tax data import
- CSV processing capability
- Admin-only access

### 5. Data Storage

#### DynamoDB Tables
- **ApiKeysTable**: API key management and metadata
- **TaxDataTable**: Tax dates and deadlines (2024-2026)
- **UsageMetricsTable**: Aggregated usage statistics
- **RateLimitTable**: Legacy rate limiting data

#### S3 Buckets
- **Analytics Bucket**: Parquet files from Firehose
- **CDN Logs**: CloudFront access logs
- **WAF Logs**: Security event logs

### 6. Rate Limiting & Usage Tracking

#### Valkey (Redis-compatible)
- Sub-millisecond rate limit checks
- ElastiCache cluster (cache.t3.micro)
- VPC-isolated for security
- Primary counter for rate limiting

#### Kinesis Data Firehose
- Captures ALL API requests
- Converts to Parquet format
- 5-minute buffer (128MB)
- Exactly-once delivery guarantee

#### Dual Tracking Pattern
- Only 200-299 responses count against rate limits
- All requests (including errors) tracked for analytics
- Enables accurate billing and usage insights

### 7. Security Features

#### AWS WAF (Web Application Firewall)
- Rate-based rules (2000 requests/5 minutes)
- Geo-blocking capability
- SQL injection protection
- XSS prevention
- IP reputation lists

#### Infrastructure Security
- Private API Gateway
- VPC isolation for Lambda functions
- Secrets Manager for sensitive data
- IAM roles with least privilege
- Point-in-time recovery for DynamoDB

### 8. Monitoring & Observability

#### CloudWatch Dashboard
- Real-time API metrics
- Cache hit rates
- Lambda performance
- Error tracking

#### Alarms
- High error rates
- Low cache hit ratio
- Lambda throttling
- High latency

#### X-Ray Tracing
- End-to-end request tracing
- Performance bottleneck identification
- Service map visualization

### 9. Backup & Recovery

#### Automated Backups
- Daily DynamoDB exports to S3
- 30-day retention
- Point-in-time recovery enabled
- Cross-region backup capability

#### Disaster Recovery
- Infrastructure as Code (CDK)
- All configurations in Git
- 15-minute RTO
- Zero RPO for DynamoDB

## Data Flow

```
User Request
    ↓
CloudFront (WAF + Cache)
    ↓
API Gateway (Private)
    ↓
Lambda Authorizer → Valkey (Rate Limit Check)
    ↓                    ↓
    ↓                 Kinesis Firehose → S3 (Analytics)
    ↓
Lambda Handler
    ↓
DynamoDB
    ↓
Response → CloudFront → User
```

## Tier Limits

- **Free**: 10 requests/day
- **Hobby**: 100 requests/day
- **Startup**: 1,000 requests/day
- **Growth**: 10,000 requests/day
- **Scale**: 100,000 requests/day
- **Enterprise**: Unlimited

## Deployment Information

- **CloudFront Domain**: d2uhe8jerdqq3g.cloudfront.net
- **API Gateway ID**: taxx7u4lwc (private - not directly accessible)
- **AWS Region**: ap-south-1 (Mumbai)
- **WAF Region**: us-east-1 (Global)

## Cost Optimization

- Serverless architecture scales to zero
- Parquet format reduces storage by 70-90%
- CloudFront caching reduces Lambda invocations
- On-demand DynamoDB pricing
- Reserved capacity for Valkey in production

## Future Enhancements

- Multi-region deployment
- GraphQL API support
- Additional countries (UK, US, CA)
- ML-based anomaly detection
- Real-time streaming analytics