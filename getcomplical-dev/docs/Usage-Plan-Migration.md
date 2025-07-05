# Usage Plan Migration Guide

## Current Implementation (MVP)

We use a hybrid approach that gives us flexibility without complexity:

1. **API Gateway**: Single usage plan for DDoS protection
2. **Custom Rate Limiter**: Tier-based limits with sharding
3. **DynamoDB**: Stores tier information per API key

## Why This Approach?

- ✅ Quick to market
- ✅ Easy tier upgrades
- ✅ No API Gateway/DynamoDB sync issues
- ✅ Supports different tiers TODAY

## Current Tiers

| Tier | Daily Limit | Rate Limit | Price |
|------|-------------|------------|-------|
| Free | 1,000 | 10 RPS | $0 |
| Starter | 10,000 | 50 RPS | $49 |
| Pro | 100,000 | 200 RPS | $199 |
| Enterprise | Unlimited | 1000 RPS | Custom |

## Future Migration to Full API Gateway Usage Plans

When you have 100+ customers and need true API Gateway rate limiting:

### Step 1: Create Multiple Usage Plans
```typescript
// In api-compute-stack.ts
const freePlan = this.api.addUsagePlan('FreePlan', {
  name: 'Free',
  throttle: { rateLimit: 10, burstLimit: 20 },
  quota: { limit: 1000, period: Period.DAY }
});

const proPlan = this.api.addUsagePlan('ProPlan', {
  name: 'Pro',
  throttle: { rateLimit: 200, burstLimit: 400 },
  quota: { limit: 100000, period: Period.DAY }
});
```

### Step 2: Create API Keys in API Gateway
```typescript
// When user generates key
const apiGatewayKey = new apigateway.ApiKey(this, `Key-${userId}`, {
  apiKeyName: apiKey, // gc_live_xxx
  enabled: true,
});

// Link to appropriate plan
const plan = tier === 'pro' ? proPlan : freePlan;
plan.addApiKey(apiGatewayKey);
```

### Step 3: Sync with DynamoDB
```typescript
// Store API Gateway key ID in DynamoDB
{
  apiKey: 'gc_live_xxx',
  apiGatewayKeyId: 'abcd1234', // From API Gateway
  tier: 'pro',
  // ... other fields
}
```

## When to Migrate?

Migrate when you have:
- 100+ paying customers
- Need true per-second rate limiting
- Want AWS to handle all throttling
- Have dedicated DevOps resources

## Current System Benefits

Your current implementation is actually superior for MVP because:

1. **Instant tier changes** - No API Gateway deployment needed
2. **Flexible limits** - Can offer custom limits per customer
3. **Better analytics** - Exact usage tracking
4. **Lower complexity** - No sync issues

## Recommendation

Keep current system until you have product-market fit and 100+ customers. The hybrid approach gives you all the benefits with none of the complexity.