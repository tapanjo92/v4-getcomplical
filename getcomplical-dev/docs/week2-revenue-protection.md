# Week 2: Revenue Protection Implementation

## Overview

This document details the implementation of revenue protection features for GetComplical, including detailed usage tracking, customer alerts, and billing integration with Stripe and Paddle.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   API Gateway   │────▶│ Authorizer Lambda │────▶│  Usage Metrics  │
│   (Request)     │     │ (Track Usage)     │     │   DynamoDB      │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                                           │
                              ┌────────────────────────────┘
                              ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  EventBridge    │────▶│ Usage Aggregator  │     │ Usage Monitor   │
│  (Daily/Hourly) │     │    Lambda         │     │    Lambda       │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                                           │
                                                           ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ Stripe/Paddle   │────▶│ Webhook Handler   │────▶│   SNS Topics    │
│   Webhooks      │     │    Lambda         │     │ (Alerts/Events) │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

## Phase 1: Usage Tracking (Completed)

### 1.1 Enhanced Authorizer Lambda

**File**: `lambdas/auth/authorizer.ts`

The authorizer now tracks detailed usage metrics in real-time:
- Hourly metrics (7-day TTL) for real-time monitoring
- Daily metrics (90-day TTL) for billing
- Endpoint-level tracking
- Customer ID association

**Usage Metrics Table Schema**:
```typescript
{
  pk: "usage#<apiKey>",
  sk: "YYYY-MM#type#timestamp",
  apiKey: string,
  customerId: string,
  tier: string,
  totalRequests: number,
  endpoints: { [path: string]: number },
  date: string,
  ttl: number
}
```

### 1.2 Usage Aggregation Lambda

**File**: `lambdas/usage/usage-aggregator.ts`

Runs daily at 1 AM UTC to:
- Aggregate hourly data into daily summaries
- Create monthly rollups with statistics
- Calculate peak usage days
- Track endpoint popularity
- Send metrics to CloudWatch

### 1.3 Dashboard API Endpoints

**File**: `lambdas/api/dashboard.ts`

New endpoints added:

#### Monthly Usage Summary
```
GET /dashboard/usage/monthly?month=2025-01
```
Returns aggregated usage for all API keys owned by the user.

#### Daily Usage Details
```
GET /dashboard/usage/daily?apiKey=gc_live_xxx&startDate=2025-01-01&endDate=2025-01-07
```
Returns day-by-day usage breakdown.

#### Real-time Usage (Last 24 Hours)
```
GET /dashboard/usage/realtime?apiKey=gc_live_xxx
```
Returns hourly usage for the last 24 hours.

## Phase 2: Alert System (Completed)

### 2.1 SNS Topics

**Created Topics**:
1. `getcomplical-customer-alerts` - Usage threshold notifications
2. `getcomplical-billing-events` - Internal billing events

### 2.2 Usage Monitor Lambda

**File**: `lambdas/usage/usage-monitor.ts`

Runs hourly to check usage thresholds:
- 80% warning (once per month)
- 95% critical alert (once per month)
- 100% exceeded notification
- Anomaly detection (5x daily average)

**Alert Features**:
- Prevents duplicate alerts
- Tracks last alert level per API key
- Sends formatted email notifications
- Publishes events for further processing

## Phase 3: Billing Integration (Completed)

### 3.1 Webhook Handler

**File**: `lambdas/billing/webhook-handler.ts`

Handles webhooks from payment providers:

**Stripe Events**:
- `checkout.session.completed` - New subscription
- `customer.subscription.updated` - Plan changes
- `customer.subscription.deleted` - Cancellations
- `invoice.payment_succeeded` - Successful payments
- `invoice.payment_failed` - Failed payments

**Paddle Events**:
- `subscription.created`
- `subscription.updated`
- `subscription.cancelled`
- `transaction.completed`

### 3.2 Webhook Security

- Signature verification for both providers
- Secrets stored in AWS Secrets Manager
- Automatic secret caching
- Timing-safe signature comparison

### 3.3 Subscription Management

Updates to API key records:
- Tier changes based on subscription
- Billing status tracking
- Customer ID association
- Subscription end date tracking

## Infrastructure Updates

### New DynamoDB Table
- `getcomplical-usage-metrics` - Detailed usage tracking
  - GSI: `customerId-date-index`
  - GSI: `date-apiKey-index`

### New Lambda Functions
1. `UsageAggregatorFunction` - Daily aggregation
2. `UsageMonitorFunction` - Hourly threshold checks
3. `BillingWebhookFunction` - Payment provider webhooks

### New API Endpoints
- `/dashboard/usage/monthly` - Monthly usage summary
- `/dashboard/usage/daily` - Daily usage details
- `/dashboard/usage/realtime` - Real-time usage
- `/webhooks/stripe` - Stripe webhook receiver
- `/webhooks/paddle` - Paddle webhook receiver
- `/admin/trigger-aggregation` - Manual aggregation
- `/admin/trigger-monitoring` - Manual monitoring

### EventBridge Rules
1. Daily aggregation at 1 AM UTC
2. Hourly usage monitoring

### Secrets Manager Entries
- `getcomplical/stripe-webhook-secret`
- `getcomplical/paddle-webhook-secret`

## Deployment Instructions

1. **Deploy updated stacks**:
```bash
npm run build

# Deploy in order
cdk deploy GetComplicalSecretsStack
cdk deploy GetComplicalStorageStack
cdk deploy GetComplicalApiComputeStack
cdk deploy GetComplicalBillingStack
```

2. **Configure webhook secrets**:
```bash
# Update Stripe webhook secret
aws secretsmanager put-secret-value \
  --secret-id getcomplical/stripe-webhook-secret \
  --secret-string '{"webhookSecret":"whsec_actual_secret_from_stripe"}'

# Update Paddle webhook secret
aws secretsmanager put-secret-value \
  --secret-id getcomplical/paddle-webhook-secret \
  --secret-string '{"webhookSecret":"pdl_actual_secret_from_paddle"}'
```

3. **Configure webhook endpoints in providers**:
- Stripe: `https://[cloudfront-domain]/webhooks/stripe`
- Paddle: `https://[cloudfront-domain]/webhooks/paddle`

4. **Set up email notifications** (optional):
```bash
# Subscribe email to customer alerts
aws sns subscribe \
  --topic-arn [CustomerAlertsTopicArn] \
  --protocol email \
  --notification-endpoint alerts@getcomplical.com
```

## Testing

### Test Usage Tracking
```bash
# Make API calls and check metrics
curl -H "X-Api-Key: gc_live_xxx" https://[domain]/api/v1/tax-dates?country=AU&year=2025

# Query usage
curl -H "Authorization: Bearer [token]" \
  https://[domain]/dashboard/usage/realtime?apiKey=gc_live_xxx
```

### Test Alerts
```bash
# Trigger monitoring manually (requires admin API key)
curl -X POST -H "X-Api-Key: [admin-key]" \
  https://[domain]/admin/trigger-monitoring
```

### Test Webhooks
```bash
# Test Stripe webhook
curl -X POST https://[domain]/webhooks/stripe \
  -H "stripe-signature: test" \
  -d '{
    "type": "checkout.session.completed",
    "data": {
      "object": {
        "customer": "cus_123",
        "subscription": "sub_123",
        "metadata": {
          "api_key": "gc_live_xxx",
          "user_id": "user_123"
        }
      }
    }
  }'
```

## Monitoring

### CloudWatch Metrics
- Namespace: `GetComplical/Usage`
- Metrics:
  - `DailyRequests` - Per API key
  - `AggregationSuccess/Failure`
  - `AlertsSent`

### CloudWatch Logs
- `/aws/lambda/GetComplicalBillingStack-UsageAggregator*`
- `/aws/lambda/GetComplicalBillingStack-UsageMonitor*`
- `/aws/lambda/GetComplicalBillingStack-BillingWebhook*`

## Cost Estimates

### Additional Monthly Costs
- DynamoDB usage metrics table: ~$5-10
- Lambda executions: ~$2-5
- SNS notifications: ~$1
- EventBridge rules: ~$1
- **Total**: ~$10-20/month

## Security Considerations

1. **Webhook Security**:
   - Always verify signatures
   - Use HTTPS only
   - Rotate webhook secrets regularly

2. **Data Privacy**:
   - Usage data contains API keys (partial display only)
   - Customer IDs are encrypted at rest
   - PII is minimized in logs

3. **Access Control**:
   - Admin endpoints require API key
   - Dashboard requires Cognito authentication
   - Webhook endpoints are public but verified

## Next Steps

### Immediate Actions
1. Configure real payment provider accounts
2. Update webhook secrets with production values
3. Set up monitoring dashboards
4. Configure alert email addresses

### Future Enhancements
1. Usage-based billing (pay per request)
2. Detailed analytics dashboard
3. Automated dunning for failed payments
4. Multi-currency support
5. Invoice generation and email
6. Slack/Discord notifications
7. Usage forecasting with ML

## Troubleshooting

### Common Issues

1. **Usage not tracking**:
   - Check authorizer Lambda logs
   - Verify USAGE_METRICS_TABLE env var
   - Check IAM permissions

2. **Alerts not sending**:
   - Verify SNS topic subscriptions
   - Check alertsEnabled flag on API key
   - Review CloudWatch logs

3. **Webhooks failing**:
   - Check signature verification
   - Verify secrets are updated
   - Review webhook handler logs

4. **Aggregation errors**:
   - Check for API keys without usage
   - Verify time zone handling
   - Review TTL settings

## Conclusion

The Week 2 Revenue Protection implementation provides:
- ✅ Detailed usage tracking per customer
- ✅ Proactive usage alerts at 80%, 95%, and 100%
- ✅ Billing webhook integration for Stripe and Paddle
- ✅ Comprehensive usage analytics endpoints
- ✅ Automated subscription management

This foundation enables monetization while protecting revenue through usage limits, proactive notifications, and automated billing integration.