# Kinesis Analytics Demo - Proof of Usage Tracking

## System Overview

The GetComplical API implements a **dual tracking pattern**:

1. **Real-time Rate Limiting** - Via Valkey (Redis)
   - Only successful requests (200 status codes) count
   - Instant rate limit enforcement
   - Current usage stored in memory

2. **Comprehensive Analytics** - Via Kinesis Firehose
   - ALL requests tracked (success and failures)
   - Data stored as compressed Parquet files in S3
   - Ready for analysis with AWS Athena

## Live Proof Points

### 1. Real-Time Usage (Valkey/Redis)
```
Current API Key: gc_live_TEST_KEY
Current Usage: 3 requests
Daily Limit: 100 requests
Remaining: 97 requests
Reset Time: 2025-07-08T00:00:00.000Z
```

### 2. Analytics Data Pipeline
```
API Request → Lambda → Kinesis Firehose → S3 (Parquet) → Athena
                ↓
            Valkey (Rate Limiting)
```

### 3. S3 Analytics Storage
- **Bucket**: gc-analytics-prod-v2-809555764832-ap-south-1
- **Format**: Parquet (70-90% compression)
- **Partitioning**: year/month/day for efficient queries
- **Files Created Today**: 2 Parquet files
- **Latest File**: 2.3KB compressed data

### 4. Data Schema
The Parquet files contain:
- `timestamp` - Request timestamp
- `request_id` - Unique request identifier
- `api_key` - API key used
- `customer_id` - Customer identifier
- `user_id` - User identifier
- `tier` - Subscription tier (free/pro/enterprise)
- `endpoint` - API endpoint called
- `method` - HTTP method
- `status_code` - Response status (200, 401, 429, etc.)
- `response_time_ms` - Response latency
- `region` - AWS region
- `cache_hit` - Whether response was cached
- `rate_limit_exceeded` - Rate limit status
- `error_message` - Error details if any

### 5. Analytics Queries (via Athena)

Example query to analyze today's usage:
```sql
SELECT 
    COUNT(*) as total_requests,
    COUNT(DISTINCT api_key) as unique_api_keys,
    AVG(response_time_ms) as avg_response_time_ms,
    COUNT(CASE WHEN status_code = 200 THEN 1 END) as successful_requests,
    COUNT(CASE WHEN cache_hit = true THEN 1 END) as cache_hits
FROM getcomplical_analytics.usage_events
WHERE year = '2025' AND month = '07' AND day = '07'
```

### 6. Benefits of This Architecture

1. **Performance**: Rate limiting doesn't slow down analytics
2. **Reliability**: Analytics continues even if rate limiting fails
3. **Cost-Effective**: Parquet compression saves 70-90% storage
4. **Queryable**: Use standard SQL with Athena
5. **Real-time + Historical**: Best of both worlds

## How to Verify

1. **Make API calls**: 
   ```bash
   curl -H "X-Api-Key: gc_live_TEST_KEY" https://d2uhe8jerdqq3g.cloudfront.net/api/v1/tax-dates?country=AU&year=2024
   ```

2. **Check real-time usage**:
   - Usage counter increments only for 200 responses
   - Rate limit enforced at 100 requests/day

3. **Check analytics** (after 5-10 minutes):
   - New Parquet files appear in S3
   - All requests tracked (including errors)
   - Query with Athena for insights

## Architecture Decisions

- **Valkey instead of Redis**: Open-source, AWS-backed alternative
- **Kinesis Firehose**: Managed service, automatic Parquet conversion
- **Dual Tracking**: Separate concerns for rate limiting vs analytics
- **Parquet Format**: Columnar storage for efficient analytics
- **S3 + Athena**: Serverless analytics, pay per query