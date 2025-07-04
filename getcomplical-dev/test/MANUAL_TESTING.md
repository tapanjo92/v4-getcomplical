# GetComplical API - Manual Testing Guide

## Prerequisites

1. Deploy all stacks:
```bash
npm run deploy
```

2. Load tax data:
```bash
./scripts/load-tax-data.sh
```

3. Note the CloudFront URL from deployment output

## Test Flow

### 1. User Registration & Login

#### Option A: AWS Console
1. Go to AWS Cognito Console
2. Select `getcomplical-users` pool
3. Create user with email/password
4. Set permanent password

#### Option B: CLI
```bash
# Create user
aws cognito-idp admin-create-user \
  --user-pool-id <USER_POOL_ID> \
  --username test@example.com \
  --user-attributes Name=email,Value=test@example.com \
  --temporary-password TempPass123! \
  --region ap-south-1

# Set permanent password
aws cognito-idp admin-set-user-password \
  --user-pool-id <USER_POOL_ID> \
  --username test@example.com \
  --password YourPass123! \
  --permanent \
  --region ap-south-1
```

### 2. Authenticate & Get Token

```bash
# Get tokens
aws cognito-idp initiate-auth \
  --client-id <CLIENT_ID> \
  --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters USERNAME=test@example.com,PASSWORD=YourPass123! \
  --region ap-south-1
```

Save the `AccessToken` from response.

### 3. Generate API Key

```bash
curl -X POST https://<CLOUDFRONT_URL>/dashboard/generate-key \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -H "Content-Type: application/json"
```

Expected response:
```json
{
  "apiKey": "txs_live_abc123...",
  "createdAt": "2024-01-15T10:00:00Z",
  "tier": "free",
  "dailyLimit": 1000
}
```

### 4. Test API Endpoints

#### Basic Query
```bash
curl -X GET "https://<CLOUDFRONT_URL>/api/v1/tax-dates?country=AU&year=2024" \
  -H "X-Api-Key: <YOUR_API_KEY>"
```

#### Filtered Query
```bash
# By type
curl -X GET "https://<CLOUDFRONT_URL>/api/v1/tax-dates?country=AU&year=2024&type=bas" \
  -H "X-Api-Key: <YOUR_API_KEY>"

# By state
curl -X GET "https://<CLOUDFRONT_URL>/api/v1/tax-dates?country=AU&year=2024&state=NSW" \
  -H "X-Api-Key: <YOUR_API_KEY>"

# Multiple filters
curl -X GET "https://<CLOUDFRONT_URL>/api/v1/tax-dates?country=AU&year=2024&type=payroll&state=VIC" \
  -H "X-Api-Key: <YOUR_API_KEY>"
```

### 5. Test Error Cases

#### Missing API Key
```bash
curl -X GET "https://<CLOUDFRONT_URL>/api/v1/tax-dates?country=AU&year=2024"
# Expected: 401 Unauthorized
```

#### Invalid Country
```bash
curl -X GET "https://<CLOUDFRONT_URL>/api/v1/tax-dates?country=US&year=2024" \
  -H "X-Api-Key: <YOUR_API_KEY>"
# Expected: 400 Bad Request
```

#### Missing Parameters
```bash
curl -X GET "https://<CLOUDFRONT_URL>/api/v1/tax-dates?country=AU" \
  -H "X-Api-Key: <YOUR_API_KEY>"
# Expected: 400 Bad Request
```

### 6. Test Cache Behavior

#### First Request (Cache Miss)
```bash
time curl -X GET "https://<CLOUDFRONT_URL>/api/v1/tax-dates?country=NZ&year=2024" \
  -H "X-Api-Key: <YOUR_API_KEY>" \
  -i | grep -E "(x-cache|cf-cache-status)"
```

#### Second Request (Cache Hit)
```bash
# Wait 5 seconds, then repeat
time curl -X GET "https://<CLOUDFRONT_URL>/api/v1/tax-dates?country=NZ&year=2024" \
  -H "X-Api-Key: <YOUR_API_KEY>" \
  -i | grep -E "(x-cache|cf-cache-status)"
```

Should see faster response time and cache hit indicator.

### 7. Test Rate Limiting

```bash
# Make 1000+ requests to exceed daily limit
for i in {1..1001}; do
  curl -X GET "https://<CLOUDFRONT_URL>/api/v1/tax-dates?country=AU&year=2024" \
    -H "X-Api-Key: <YOUR_API_KEY>" \
    -o /dev/null -s -w "%{http_code}\n"
done
```

After 1000 requests, should get 429 Too Many Requests.

### 8. List API Keys

```bash
curl -X GET https://<CLOUDFRONT_URL>/dashboard/keys \
  -H "Authorization: Bearer <ACCESS_TOKEN>"
```

Should show your key with usage statistics.

## Using Postman

### Setup
1. Create new collection "GetComplical API"
2. Add collection variable: `api_key`
3. Add collection variable: `base_url` = CloudFront URL

### Requests to Create

1. **Generate API Key**
   - POST `{{base_url}}/dashboard/generate-key`
   - Auth: Bearer Token
   - Save response apiKey to collection variable

2. **Get Tax Dates**
   - GET `{{base_url}}/api/v1/tax-dates`
   - Params: country=AU, year=2024
   - Header: X-Api-Key = {{api_key}}

3. **Get Filtered Dates**
   - GET `{{base_url}}/api/v1/tax-dates`
   - Params: country=AU, year=2024, type=bas
   - Header: X-Api-Key = {{api_key}}

## Verification Checklist

- [ ] User can sign up with Cognito
- [ ] User can authenticate and get tokens
- [ ] User can generate API key
- [ ] API key allows access to tax data
- [ ] Filtering works (type, state, agency)
- [ ] Error responses are correct
- [ ] Rate limiting enforces 1000/day limit
- [ ] Cache improves response times
- [ ] CloudFront serves requests globally

## Troubleshooting

### "Unauthorized" Error
- Check API key format (starts with `txs_live_`)
- Verify key is active in DynamoDB
- Check X-Api-Key header spelling

### No Data Returned
- Verify data was loaded with load script
- Check DynamoDB has items for country/year
- Look at CloudWatch logs for errors

### Slow Response Times
- First request to new query is slower (cache miss)
- Check Lambda cold start in X-Ray traces
- Verify CloudFront distribution is enabled

### Rate Limit Issues
- Check usageToday in DynamoDB
- Wait until next day (UTC) for reset
- Consider upgrading tier (future feature)