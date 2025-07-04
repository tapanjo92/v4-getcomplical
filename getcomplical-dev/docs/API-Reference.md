# GetComplical API Reference

## Base URL

```
https://your-cloudfront-distribution.cloudfront.net
```

## Authentication

GetComplical uses API key authentication for public endpoints and AWS Cognito for dashboard access.

### API Key Authentication

Include your API key in the request header:

```
X-Api-Key: txs_live_your_api_key_here
```

### Cognito Authentication

For dashboard endpoints, include the Cognito access token:

```
Authorization: Bearer {access_token}
```

## Rate Limits

- **Free Tier**: 1,000 requests per day
- **Rate Limit Headers**: Returned with each response
  - `X-RateLimit-Limit`: Daily limit
  - `X-RateLimit-Remaining`: Requests remaining today
  - `X-RateLimit-Reset`: Unix timestamp when limit resets

## Endpoints

### Get Tax Dates

Retrieve tax-related dates for Australia or New Zealand.

```http
GET /api/v1/tax-dates
```

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| country | string | Yes | Country code (AU or NZ) |
| year | integer | Yes | Year in YYYY format |
| type | string | No | Filter by tax type |

#### Tax Types

- `filing` - Tax return filing deadlines
- `payment` - Tax payment due dates
- `gst` - GST/VAT related dates
- `bas` - Business Activity Statement dates
- `payroll` - Payroll tax deadlines
- `company` - Company tax dates

#### Example Request

```bash
curl -X GET "https://api.getcomplical.com/api/v1/tax-dates?country=AU&year=2024&type=filing" \
  -H "X-Api-Key: txs_live_abc123xyz"
```

#### Example Response

```json
{
  "country": "AU",
  "year": 2024,
  "totalDates": 4,
  "dates": [
    {
      "date": "2024-07-31",
      "name": "Individual Tax Return Deadline",
      "description": "Last day to lodge 2023-24 individual tax return",
      "type": "filing",
      "isPublicHoliday": false,
      "isBusinessDay": true
    },
    {
      "date": "2024-10-31",
      "name": "Tax Return Deadline (Tax Agent)",
      "description": "Extended deadline for returns lodged through tax agent",
      "type": "filing",
      "isPublicHoliday": false,
      "isBusinessDay": true
    }
  ]
}
```

### Generate API Key

Generate a new API key for your account.

```http
POST /dashboard/generate-key
```

#### Headers

```
Authorization: Bearer {cognito_access_token}
Content-Type: application/json
```

#### Example Response

```json
{
  "apiKey": "txs_live_k3y9x8w7v6u5t4s3r2q1p0o9",
  "createdAt": "2024-01-15T10:30:00Z",
  "tier": "free",
  "dailyLimit": 1000
}
```

### List API Keys

Retrieve all API keys associated with your account.

```http
GET /dashboard/keys
```

#### Headers

```
Authorization: Bearer {cognito_access_token}
```

#### Example Response

```json
{
  "keys": [
    {
      "apiKey": "txs_live_k3y9x8w7v6u5t4s3r2q1p0o9",
      "status": "active",
      "tier": "free",
      "dailyLimit": 1000,
      "usageToday": 127,
      "totalUsage": 5432,
      "createdAt": "2024-01-15T10:30:00Z",
      "lastUsedDate": "2024-01-20"
    },
    {
      "apiKey": "txs_live_a1b2c3d4e5f6g7h8i9j0k1l2",
      "status": "inactive",
      "tier": "free",
      "dailyLimit": 1000,
      "usageToday": 0,
      "totalUsage": 10000,
      "createdAt": "2023-12-01T08:00:00Z",
      "lastUsedDate": "2024-01-10"
    }
  ]
}
```

## Error Responses

### Error Format

All errors follow a consistent format:

```json
{
  "error": "Error message describing what went wrong"
}
```

### HTTP Status Codes

| Status Code | Description |
|-------------|-------------|
| 200 | Success |
| 201 | Created (new API key) |
| 400 | Bad Request - Invalid parameters |
| 401 | Unauthorized - Invalid or missing authentication |
| 403 | Forbidden - Valid auth but insufficient permissions |
| 429 | Too Many Requests - Rate limit exceeded |
| 500 | Internal Server Error |

### Common Errors

#### Invalid Country Code
```json
{
  "error": "Country must be AU or NZ"
}
```

#### Missing Required Parameters
```json
{
  "error": "Missing required parameters: country and year"
}
```

#### Rate Limit Exceeded
```json
{
  "error": "Rate limit exceeded"
}
```

#### Invalid API Key
```json
{
  "error": "Unauthorized"
}
```

## Data Formats

### Date Format
All dates are returned in ISO 8601 format: `YYYY-MM-DD`

### Timezone
All dates are in the local timezone of the specified country:
- Australia (AU): Various timezones, dates are nationwide
- New Zealand (NZ): NZDT/NZST

### Business Days
The `isBusinessDay` field indicates whether the date falls on a regular business day (Monday-Friday, excluding public holidays).

## Caching

Responses include cache headers:

```
Cache-Control: public, max-age=3600
```

Tax date data is cached for 1 hour at the API level and 24 hours at the CDN level.

## CORS

CORS is enabled for all origins. The following headers are allowed:
- `Content-Type`
- `X-Api-Key`
- `Authorization`

## SDK Examples

### JavaScript/Node.js

```javascript
const axios = require('axios');

const API_KEY = 'txs_live_your_api_key';
const BASE_URL = 'https://api.getcomplical.com';

async function getTaxDates(country, year, type = null) {
  try {
    const params = { country, year };
    if (type) params.type = type;
    
    const response = await axios.get(`${BASE_URL}/api/v1/tax-dates`, {
      params,
      headers: {
        'X-Api-Key': API_KEY
      }
    });
    
    return response.data;
  } catch (error) {
    console.error('Error fetching tax dates:', error.response?.data || error.message);
    throw error;
  }
}

// Usage
getTaxDates('AU', 2024, 'filing')
  .then(data => console.log(data))
  .catch(err => console.error(err));
```

### Python

```python
import requests

API_KEY = 'txs_live_your_api_key'
BASE_URL = 'https://api.getcomplical.com'

def get_tax_dates(country, year, tax_type=None):
    params = {'country': country, 'year': year}
    if tax_type:
        params['type'] = tax_type
    
    headers = {'X-Api-Key': API_KEY}
    
    response = requests.get(
        f'{BASE_URL}/api/v1/tax-dates',
        params=params,
        headers=headers
    )
    
    response.raise_for_status()
    return response.json()

# Usage
try:
    data = get_tax_dates('NZ', 2024, 'gst')
    print(data)
except requests.exceptions.RequestException as e:
    print(f"Error: {e}")
```

### cURL

```bash
# Get all tax dates for Australia 2024
curl -X GET "https://api.getcomplical.com/api/v1/tax-dates?country=AU&year=2024" \
  -H "X-Api-Key: txs_live_your_api_key"

# Get only filing deadlines
curl -X GET "https://api.getcomplical.com/api/v1/tax-dates?country=AU&year=2024&type=filing" \
  -H "X-Api-Key: txs_live_your_api_key"

# Generate new API key (requires Cognito auth)
curl -X POST "https://api.getcomplical.com/dashboard/generate-key" \
  -H "Authorization: Bearer YOUR_COGNITO_TOKEN" \
  -H "Content-Type: application/json"
```

## Webhooks (Coming Soon)

Future versions will support webhooks for:
- Upcoming tax deadline notifications
- API key usage alerts
- New tax date additions

## Support

For API support, feature requests, or bug reports:
- Email: support@getcomplical.com
- GitHub: https://github.com/getcomplical/api-issues