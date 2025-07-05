# CloudWatch Dashboard Monitoring Guide

## Key Metrics to Watch

### 1. API Performance Metrics
- **Request Volume**: Total API calls per hour/day
  - Look for: Sudden spikes or drops
  - Normal: Steady growth pattern
  
- **Error Rates**: 4XX and 5XX errors
  - Healthy: <1% 5XX errors, <5% 4XX errors
  - Alert threshold: >10 5XX errors in 5 minutes

- **API Latency**: Average response time
  - Target: <100ms for cached, <500ms for uncached
  - Alert threshold: >1000ms average

### 2. Cache Performance
- **Cache Hit Ratio**: Should be >70%
  - Popular queries (AU/NZ base): Expect 80-90%
  - Filtered queries: Expect 40-60%
  
- **CloudFront Metrics**:
  - Origin requests vs Edge requests
  - Data transfer out (bandwidth costs)

### 3. Lambda Function Health
- **Invocations**: Match API request volume
- **Errors**: Should be near zero
- **Duration**: 
  - Authorizer: <50ms
  - API Handler: <200ms
  - Dashboard: <100ms
- **Concurrent Executions**: Monitor for throttling
- **Throttles**: Should be zero

### 4. Query Pattern Analysis (Log Insights)
- **Top 10 Query Patterns**: Which filters are most popular
- **Slowest Queries**: Identify performance bottlenecks
- **Geographic Distribution**: Where are requests coming from

### 5. Business Metrics
- **Query Type Distribution**:
  - AU vs NZ queries
  - Base vs filtered queries
  - Most common filter combinations
  
- **API Key Usage**:
  - Active keys per day
  - Usage per tier (when you add paid tiers)

## Red Flags to Watch For
1. Cache hit ratio drops below 70%
2. Lambda cold starts >10% of requests
3. 5XX errors spike
4. Response time >1 second
5. Throttling on any Lambda function
6. DynamoDB throttling (though unlikely with on-demand)

## Cost Optimization Indicators
1. High CloudFront cache hit ratio = lower Lambda costs
2. Efficient query patterns = lower DynamoDB costs
3. Appropriate Lambda memory sizing (not over-provisioned)