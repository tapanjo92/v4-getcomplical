# GetComplical Documentation

Welcome to the GetComplical Tax API documentation. GetComplical is a serverless tax calendar API service for Australia and New Zealand, providing businesses with reliable access to tax compliance dates and deadlines.

## 📚 Documentation

### Core Documentation

- **[API-Reference.md](./API-Reference.md)** - API endpoints, authentication, and usage examples
- **[Current-Architecture.md](./Current-Architecture.md)** - Production architecture with Valkey and private API
- **[Deployment-Guide-V2.md](./Deployment-Guide-V2.md)** - Step-by-step deployment instructions for current architecture
- **[production-deployment-test-results.md](./production-deployment-test-results.md)** - Latest deployment test results

### Operational Guides

- **[Data-Loading-Strategy.md](./Data-Loading-Strategy.md)** - Tax data management procedures
- **[Caching-Strategy.md](./Caching-Strategy.md)** - Performance optimization via caching
- **[cloudwatch-metrics-guide.md](./cloudwatch-metrics-guide.md)** - Monitoring and alerts
- **[Usage-Plan-Migration.md](./Usage-Plan-Migration.md)** - Tier migration procedures

### Security & Compliance

- **[Security-Features.md](./Security-Features.md)** - All security & reliability features implemented
- **[waf-deployment-guide.md](./waf-deployment-guide.md)** - WAF configuration and rules

## 🚀 Quick Start

1. **Deploy the Infrastructure**
   ```bash
   npm install
   npm run build
   npm run deploy
   ```

2. **Generate an API Key**
   - Sign up via Cognito
   - Access dashboard to generate API key
   - Use key with `X-Api-Key` header

3. **Make Your First API Call**
   ```bash
   curl -H "X-Api-Key: gc_live_your_key" \
     "https://d2uhe8jerdqq3g.cloudfront.net/api/v1/tax-dates?country=AU&year=2024"
   ```

## 🔑 Key Features

- **🌏 Global CDN** - CloudFront distribution for low latency
- **🔐 Secure API Keys** - Usage tracking and tier-based limits
- **📊 Real-time Monitoring** - CloudWatch dashboards and alerts
- **🚦 Rate Limiting** - Configurable limits per tier (1K/day free, 10K/day pro, 100K/day enterprise)
- **💰 Cost-Optimized** - Serverless architecture scales to zero
- **🛡️ Enterprise Security** - WAF, PITR, automated backups, Secrets Manager

## 📈 Current Implementation Status

### ✅ Production Ready
- Tax calendar API for AU/NZ (2024-2026 data)
- API key authentication with usage tracking
- CloudFront CDN with intelligent caching
- WAF protection with rate limiting and security rules
- DynamoDB with PITR and automated S3 backups
- Health check endpoints with monitoring
- Usage analytics and dashboard API
- Webhook handlers for billing (Stripe/Paddle)

### 🚧 Coming Soon
- Additional countries (UK, US, CA)
- GraphQL API
- SDK libraries (Python, Go, Java)
- Advanced analytics dashboard UI
- Multi-region deployment

## 🏗️ Technology Stack

- **Infrastructure**: AWS CDK v2 (TypeScript)
- **Runtime**: Node.js 20.x on AWS Lambda
- **API**: Private REST API via API Gateway
- **Authentication**: AWS Cognito + Custom Authorizer
- **Database**: DynamoDB with on-demand scaling
- **Rate Limiting**: Valkey (Redis-compatible) on ElastiCache
- **CDN**: CloudFront with intelligent caching + WAF
- **Analytics**: Kinesis Firehose → S3 (Parquet) → Athena
- **Monitoring**: CloudWatch + X-Ray

## 📞 Support

- **Technical Issues**: Create a GitHub issue
- **API Support**: support@getcomplical.com
- **Security**: security@getcomplical.com

## 📄 License

Copyright (c) 2024 GetComplical. All rights reserved.