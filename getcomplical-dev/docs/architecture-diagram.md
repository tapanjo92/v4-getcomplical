# GetComplical Architecture Diagram

```
┌─────────────────┐         ┌─────────────────┐
│   Web/Mobile    │         │  Business Apps  │
│   Dashboard     │         │  (API Clients)  │
└────────┬────────┘         └────────┬────────┘
         │                           │
         │ HTTPS                     │ HTTPS
         │ JWT Token                 │ API Key
         │                           │
         ▼                           ▼
┌─────────────────────────────────────────────┐
│             CloudFront CDN                  │
│  • Global Edge Locations                   │
│  • Cache: 24h (popular) / 6h (filtered)    │
└────────┬────────────────────┬──────────────┘
         │                    │
         ▼                    ▼
┌─────────────────┐  ┌───────────────────────┐
│   API Gateway   │  │   API Gateway         │
│   /dashboard/*  │  │   /api/v1/*           │
└────────┬────────┘  └───────┬───────────────┘
         │                    │
         │                    ▼
         │           ┌───────────────────────┐
         │           │  Lambda Authorizer    │
         │           │  • Validate API Key   │
         │           │  • Check Rate Limits  │
         │           └───────┬───────────────┘
         │                    │
         ▼                    ▼
┌─────────────────┐  ┌───────────────────────┐
│     Cognito     │  │   Lambda Functions    │
│  User Pool      │  │  • API Handler        │
│  • Email/Pass   │  │  • Dashboard Handler  │
│  • MFA Ready    │  │  • Data Loader       │
└─────────────────┘  └───────┬───────────────┘
                              │
                              ▼
                    ┌─────────────────────────┐
                    │      DynamoDB           │
                    │  • getcomplical-api-keys│
                    │  • getcomplical-tax-data│
                    └─────────────────────────┘
                              │
                              ▼
                    ┌─────────────────────────┐
                    │   CloudWatch            │
                    │  • Dashboards           │
                    │  • Metrics & Alarms     │
                    │  • Logs & X-Ray        │
                    └─────────────────────────┘
```

## Request Flow

### User Registration & API Key Generation
1. User signs up via Cognito
2. Receives JWT token (1 hour expiry)
3. Calls /dashboard/generate-key with JWT
4. Receives API key (gc_live_xxxxx)

### API Request Flow
1. Client sends request with X-Api-Key header
2. CloudFront checks cache
   - HIT: Return cached response
   - MISS: Forward to API Gateway
3. API Gateway triggers Lambda Authorizer
4. Authorizer validates key & updates usage
5. API Handler queries DynamoDB
6. Response cached based on query type

### Data Loading (Admin)
1. Admin triggers Lambda function
2. Loads tax data from au-tax-data.ts / nz-tax-data.ts
3. Batch writes to DynamoDB
4. Data immediately available via API