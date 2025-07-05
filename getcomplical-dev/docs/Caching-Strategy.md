# GetComplical Caching Strategy

## Overview

GetComplical implements a multi-layer caching strategy to optimize performance and reduce costs while maintaining data freshness appropriate for tax compliance data.

## Caching Architecture

```
Client Request
     ↓
CloudFront (Edge Cache)  ← 1st Layer: Geographic Distribution
     ↓ (miss)
API Gateway Cache       ← 2nd Layer: Regional Cache (not enabled)
     ↓ (miss)
Lambda Function        ← Compute Layer
     ↓
DynamoDB              ← Data Layer
```

## Cache Layers

### 1. CloudFront CDN (Primary Cache)

**Configuration:**
- **Popular Queries**: 24-hour TTL (86,400 seconds)
- **Filtered Queries**: 6-hour TTL (21,600 seconds)

**Popular Queries (24h cache):**
- Pattern: `/api/v1/tax-dates?country={country}&year={year}`
- Examples:
  - `?country=AU&year=2024` - All Australian dates
  - `?country=NZ&year=2024` - All New Zealand dates
- Rationale: Base country data changes infrequently (quarterly updates)

**Filtered Queries (6h cache):**
- Pattern: Any query with additional filters
- Examples:
  - `?country=AU&year=2024&type=bas` - BAS dates only
  - `?country=AU&year=2024&state=NSW` - NSW specific dates
  - `?country=AU&year=2024&agency=ATO` - ATO dates only
- Rationale: Filtered data may need more frequent updates

### 2. API Gateway Cache (Currently Disabled)

**Status**: Not implemented in current architecture
**Potential Use**: Could add 5-minute cache for extremely popular endpoints
**Trade-off**: Additional complexity vs marginal performance gain

## Cache Headers

### Response Headers
```http
Cache-Control: public, max-age=86400, s-maxage=86400, stale-while-revalidate=7200
Vary: X-Api-Key, Accept-Encoding
X-Cache-Status: HIT|MISS
X-Cache-Strategy: popular-query|filtered-query
CDN-Cache-Control: max-age=86400
```

### Header Explanations
- **max-age**: Browser cache duration
- **s-maxage**: CDN cache duration  
- **stale-while-revalidate**: Serve stale content while fetching fresh data
- **Vary**: Cache key differentiation factors

## Cache Key Strategy

### CloudFront Cache Keys
Cache keys include:
1. Request URI path
2. Query string parameters (sorted)
3. X-Api-Key header (for user isolation)

Example cache keys:
```
/api/v1/tax-dates?country=AU&year=2024#apikey=abc123
/api/v1/tax-dates?country=AU&year=2024&type=bas#apikey=abc123
```

## Cache Invalidation

### Manual Invalidation
When tax dates change:
```bash
aws cloudfront create-invalidation \
  --distribution-id E1234567890ABC \
  --paths "/api/v1/tax-dates*"
```

**Cost**: $0.005 per path after first 1,000/month

### Automated Invalidation
Future implementation:
1. DynamoDB Stream triggers Lambda
2. Lambda creates targeted CloudFront invalidation
3. Only invalidate affected country/year combinations

## Performance Metrics

### Target Metrics
- **Cache Hit Ratio**: >70% overall
  - Popular queries: >85%
  - Filtered queries: >50%
- **Response Time**:
  - Cache hit: <100ms
  - Cache miss: <500ms

### Current Performance
Based on testing:
- CloudFront edge response: 50-80ms
- Origin response: 200-500ms
- Cache warmup period: 2-4 hours after deployment

## Cost Optimization

### Savings Analysis
Without caching (1M requests/month):
- Lambda invocations: 1,000,000 × $0.0000002 = $200
- DynamoDB reads: 1,000,000 × $0.00000025 = $250
- Total: ~$450/month

With 80% cache hit ratio:
- Lambda invocations: 200,000 × $0.0000002 = $40
- DynamoDB reads: 200,000 × $0.00000025 = $50
- CloudFront requests: 1,000,000 × $0.0000075 = $7.50
- Total: ~$97.50/month (78% savings)

## Cache Strategies by Use Case

### 1. Public Website Integration
- Use case: Displaying tax calendar
- Strategy: Aggressive caching (24h)
- Implementation: Standard API calls

### 2. Accounting Software Integration
- Use case: Real-time compliance checking
- Strategy: Moderate caching (6h)
- Implementation: Use filtered queries

### 3. Enterprise Integration
- Use case: Critical compliance systems
- Strategy: Optional cache bypass
- Implementation: Future `Cache-Control: no-cache` header support

## Data Freshness Considerations

### Acceptable Staleness
- **Tax filing dates**: 24 hours acceptable
- **Payment deadlines**: 24 hours acceptable  
- **Legislative changes**: 6-12 hours acceptable
- **Emergency updates**: Manual invalidation required

### Update Frequency
- Quarterly batch updates for standard dates
- Ad-hoc updates for legislative changes
- Annual review and verification process

## Monitoring and Alerts

### Key Metrics to Monitor
1. **Cache Hit Ratio** drops below 70%
2. **Origin request spike** (>1000 requests/minute)
3. **Response time** exceeds 1 second
4. **Invalidation costs** exceed $50/month

### CloudWatch Alarms
```javascript
// Cache hit ratio alarm
if (cacheHitRatio < 0.70) {
  alert("Low cache hit ratio - investigate query patterns");
}

// Origin load alarm  
if (originRequestsPerMinute > 1000) {
  alert("High origin load - possible cache issue");
}
```

## Future Enhancements

### Phase 2 (Q2 2024)
- Implement cache warming on deployment
- Add cache bypass header for premium tier
- Regional cache policies for multi-region

### Phase 3 (Q3 2024)
- GraphQL with field-level caching
- WebSocket for real-time updates
- Predictive cache warming based on usage patterns

## Best Practices

### Do's
- ✅ Cache stable, infrequently changing data
- ✅ Use appropriate TTLs based on data volatility
- ✅ Monitor cache hit ratios continuously
- ✅ Plan for cache invalidation costs

### Don'ts
- ❌ Cache user-specific data
- ❌ Cache without versioning strategy
- ❌ Ignore cache-related costs
- ❌ Set TTLs without business context

## Troubleshooting

### Low Cache Hit Ratio
1. Check query pattern diversity
2. Verify cache key configuration
3. Analyze user behavior patterns
4. Consider adjusting TTLs

### Stale Data Issues
1. Verify TTL settings
2. Check invalidation process
3. Review update frequency requirements
4. Implement cache versioning

### Performance Issues
1. Check CloudFront distribution health
2. Verify origin performance
3. Analyze cache miss patterns
4. Review geographic distribution

## Conclusion

The caching strategy balances performance, cost, and data freshness appropriate for tax compliance data. The 24-hour cache for popular queries provides excellent performance while maintaining acceptable data freshness for tax deadlines that rarely change.