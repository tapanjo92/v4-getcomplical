# WAF Deployment Guide for GetComplical API

## Overview

This guide documents the AWS WAF protection deployed for the GetComplical Tax API. 

### Currently Implemented Features:
- ✅ DDoS protection with IP-based rate limiting
- ✅ Geographic restrictions (whitelist approach)
- ✅ SQL injection and malicious input protection
- ✅ Request size restrictions
- ✅ Real-time threat monitoring via Kinesis Firehose
- ✅ AWS Managed Rule Sets (Core & Known Bad Inputs)

### Features Not Yet Implemented:
- ❌ API key format validation at WAF level
- ❌ Query parameter validation (year/country)
- ❌ Custom rate limiting per API key

## Architecture

```
Internet → CloudFront (with WAF) → API Gateway → Lambda Functions
               ↓
         Kinesis Firehose
               ↓
           S3 (WAF Logs)
```

## Prerequisites

1. AWS CDK v2 installed
2. AWS credentials configured
3. Existing GetComplical infrastructure deployed

## Deployment Steps

### 1. Build the Project

```bash
cd /home/ubuntu/v4-getcomplical/getcomplical-dev
npm run build
```

### 2. Deploy WAF Stack

Since WAF for CloudFront must be in us-east-1, the stack will be deployed there automatically:

```bash
# Deploy only the WAF stack first
cdk deploy GetComplicalWafStack --require-approval never
```

### 3. Update CDN Stack with WAF

```bash
# Deploy the updated CDN stack to attach WAF
cdk deploy GetComplicalCdnStack --require-approval never
```

### 4. Update Monitoring Dashboard

```bash
# Deploy monitoring stack for WAF metrics
cdk deploy GetComplicalMonitoringStack --require-approval never
```

### 5. Verify Deployment

Actual deployment outputs:
- Web ACL ID: `6f9a63bf-5f6e-4ee9-8335-8b3e78048d94`
- WAF Logs S3 Bucket: `getcomplical-waf-logs-809555764832-us-east-1`
- CloudFront Domain: `https://d231sj4cuysrup.cloudfront.net`
- CloudWatch Alarm: `GetComplicalWafStack-WAFBlockedRequestsAlarm74585045-DDXz0DMnjPE2`

## WAF Rules Configuration (As Implemented)

### ✅ Rule 1: IP Rate Limiting (IPRateLimit)
- **Limit**: 2000 requests per 5 minutes per IP
- **Action**: Block with 403 response
- **Status**: Active and working
- **Purpose**: Prevent DDoS attacks

### ✅ Rule 2: AWS Managed Core Rule Set (CoreRuleSet)
- **Protection**: OWASP Top 10 vulnerabilities
- **Exclusions**: SizeRestrictions_BODY, GenericRFI_BODY
- **Action**: Block malicious patterns
- **Status**: Active and working

### ✅ Rule 3: Known Bad Inputs (KnownBadInputs)
- **AWS Managed Rules**: Known malicious patterns
- **Action**: Block with 403 response
- **Status**: Active and working

### ✅ Rule 4: SQL Injection Protection (SQLiProtection)
- **Scope**: Query strings only
- **Action**: Block with 403 response
- **Status**: Active and tested
- **Purpose**: Prevent SQL injection attacks

### ✅ Rule 5: Size Restrictions (SizeRestrictions)
- **Query String**: Max 2048 bytes
- **Body**: Max 10KB
- **Action**: Block with 403 response
- **Status**: Active and tested

### ✅ Rule 6: Geographic Blocking (GeoBlocking)
- **Allowed Countries**: AU, NZ, US, GB, CA, IE, SG, MY, IN, TH, JP, HK, ID
- **Action**: Block all others with 403
- **Status**: Active and working
- **Purpose**: Reduce attack surface

## Rules Not Implemented (Future Enhancements)

### ❌ API Key Format Validation
- **Reason**: Regex pattern set issues in CloudFormation
- **Workaround**: Validation happens at Lambda authorizer level
- **Impact**: Minor - authentication still enforced

### ❌ Query Parameter Validation
- **Reason**: Complex conditional logic for optional parameters
- **Workaround**: Validation in API Gateway and Lambda
- **Impact**: Minor - parameters validated at application layer

### ❌ Advanced Rate Limiting (IP + API Key)
- **Reason**: Custom keys not supported in CloudFormation
- **Current**: IP-based rate limiting only
- **Impact**: Less granular but still effective

## Monitoring and Alerts

### CloudWatch Dashboard
The monitoring stack includes WAF-specific widgets:
- WAF Blocked Requests by Rule
- WAF Request Analysis (Allowed vs Blocked)
- WAF Block Rate Percentage
- Total Blocked Requests (24h)
- Active Rate Limits
- Geographic Blocks

### CloudWatch Alarms
- **WAF Blocked Requests**: Triggers when >100 blocks in 10 minutes
- **Alarm Name**: GetComplicalWafStack-WAFBlockedRequestsAlarm74585045-DDXz0DMnjPE2

### WAF Logs
- **Location**: getcomplical-waf-logs-809555764832-us-east-1
- **Format**: JSON, GZIP compressed
- **Partitioning**: year/month/day (via Kinesis Firehose)
- **Retention**: 90 days (then auto-deleted)
- **Lifecycle**: 30 days → Infrequent Access tier
- **Delivery**: Real-time via Kinesis Firehose

## Testing WAF Rules

### 1. Test Rate Limiting
```bash
# Send rapid requests to trigger rate limit
for i in {1..100}; do
  curl -H "X-Api-Key: gc_live_[your-key]" \
    "https://[cloudfront-domain]/api/v1/tax-dates?country=AU&year=2024" &
done
```

### 2. Test Geographic Blocking
```bash
# Use VPN from blocked country or modify request headers
curl -H "CloudFront-Viewer-Country: CN" \
  -H "X-Api-Key: gc_live_[your-key]" \
  "https://[cloudfront-domain]/api/v1/tax-dates?country=AU&year=2024"
```

### 3. Test SQL Injection Protection
```bash
# Attempt SQL injection in query parameter
curl -H "X-Api-Key: gc_live_[your-key]" \
  "https://[cloudfront-domain]/api/v1/tax-dates?country=AU' OR '1'='1&year=2024"
```

### 4. Test Invalid Parameters
```bash
# Invalid year
curl -H "X-Api-Key: gc_live_[your-key]" \
  "https://[cloudfront-domain]/api/v1/tax-dates?country=AU&year=2031"

# Invalid country
curl -H "X-Api-Key: gc_live_[your-key]" \
  "https://[cloudfront-domain]/api/v1/tax-dates?country=US&year=2024"
```

## Cost Estimation

### Actual Monthly Costs (based on implementation)
- **WAF Web ACL**: $5.00 (fixed)
- **WAF Requests**: $0.60 per million requests
- **Kinesis Firehose**: ~$1-2 (depends on attack volume)
- **S3 Storage**: <$1 (90-day retention, compressed)
- **CloudWatch Metrics**: ~$2 (6 rules + dashboard)

**Actual Estimated Total**: $10-15/month for typical usage
**Under attack**: May increase to $20-30/month due to increased logs

## Rollback Procedure

If issues arise, you can disable WAF without affecting the API:

```bash
# Remove WAF from CloudFront
cdk deploy GetComplicalCdnStack --parameters WebAclArn=""

# Or destroy WAF stack entirely
cdk destroy GetComplicalWafStack
```

## Best Practices

1. **Start in COUNT mode**: Monitor false positives before blocking
2. **Review logs regularly**: Check S3 bucket for attack patterns
3. **Adjust thresholds**: Fine-tune rate limits based on usage
4. **Update geo-blocking**: Add/remove countries as needed
5. **Custom rules**: Add specific rules for your API patterns

## Troubleshooting

### Common Issues

1. **Legitimate requests blocked**
   - Check WAF logs in S3
   - Review CloudWatch metrics by rule
   - Adjust rule thresholds or add exceptions

2. **High false positive rate**
   - Review managed rule exclusions
   - Consider custom rules for API patterns
   - Implement IP allowlisting for partners

3. **Performance impact**
   - WAF adds <1ms latency at CloudFront edge
   - Monitor CloudFront cache hit ratio
   - Ensure caching headers are preserved

## Verified Test Results

### End-to-End Test Summary (Last Run: 2025-07-06)
- ✅ SQL Injection blocked: `country=AU' OR '1'='1` → HTTP 403
- ✅ Oversized query blocked: 3KB query string → HTTP 403  
- ✅ XSS attempt blocked: `<script>` tags → HTTP 403
- ✅ Normal requests pass: Valid API calls → HTTP 200
- ✅ Authentication enforced: No API key → HTTP 401

### Performance Impact
- Direct API Gateway: ~100-300ms
- CloudFront + WAF: ~400-500ms (includes WAF inspection)
- Cached responses: <100ms from edge locations

## Implementation Files

### Stack Locations
- WAF Stack: `/infrastructure/lib/waf-stack-simple.ts`
- CDN Integration: `/infrastructure/lib/cdn-stack.ts`
- Monitoring: `/infrastructure/lib/monitoring-stack.ts`
- Main App: `/infrastructure/bin/getcomplical-dev.ts`

### Test Scripts
- End-to-End Test: `/test/end-to-end-test.sh`
- Quick Test: `/test/quick-test.sh`

## Support

For issues or questions:
- Check CloudWatch dashboard: [GetComplical-Tax-API](https://ap-south-1.console.aws.amazon.com/cloudwatch/home?region=ap-south-1#dashboards:name=GetComplical-Tax-API)
- Review WAF logs in S3: `getcomplical-waf-logs-809555764832-us-east-1`
- Monitor CloudWatch alarms for attack patterns
- WAF Console: [View in us-east-1](https://console.aws.amazon.com/wafv2/homev2/web-acls/GetComplicalAPIProtection/overview?region=us-east-1)