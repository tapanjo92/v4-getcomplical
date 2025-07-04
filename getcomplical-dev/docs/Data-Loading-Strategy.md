# GetComplical Data Loading Strategy

## Overview

GetComplical uses a Lambda-based data loading system to populate tax dates into DynamoDB. This approach provides flexibility, scalability, and easy updates for tax calendar data.

## Data Structure

### DynamoDB Schema

```
Primary Key (PK): COUNTRY#YEAR (e.g., "AU#2024")
Sort Key (SK): DATE#TYPE#IDENTIFIER (e.g., "2024-07-31#filing#ato-individual")
```

### Data Model

```typescript
{
  pk: "AU#2024",
  sk: "2024-07-31#filing#ato-0",
  date: "2024-07-31",
  name: "Individual Tax Return",
  description: "Lodge 2023-24 individual income tax return",
  type: "filing",
  agency: "ATO",
  state: null,
  states: ["ALL"],
  frequency: "annual",
  threshold: null,
  country: "AU",
  year: 2024,
  isPublicHoliday: false,
  isBusinessDay: true
}
```

## Data Loader Lambda

### Function Details
- **Name**: DataLoaderFunction
- **Runtime**: Node.js 20.x
- **Timeout**: 5 minutes
- **Memory**: 512MB
- **Purpose**: Load tax calendar data into DynamoDB

### Invocation Payload

```json
{
  "country": "AU",  // AU, NZ, or ALL
  "year": 2024,     // Tax year
  "mode": "full"    // full or update (future feature)
}
```

### Loading Process

1. **Transform Data**: Convert structured tax data into DynamoDB items
2. **Batch Processing**: Load in batches of 25 items (DynamoDB limit)
3. **Composite Keys**: Generate unique SK to handle multiple deadlines on same date
4. **State Handling**: Federal data gets `states: ["ALL"]`, state data gets specific state

## Data Sources

### Australia (AU)
- **Federal**: ~44 deadlines/year
  - BAS (quarterly/monthly)
  - PAYG Withholding
  - Super Guarantee
  - Income Tax Returns
  - Company Tax
  - FBT
  - TPAR
- **States**: ~66 deadlines/year
  - Payroll Tax (all states)
  - Land Tax (all except NT)
  - Workers Compensation

### New Zealand (NZ)
- **IRD Only**: ~20-50 deadlines/year
  - GST (various frequencies)
  - PAYE
  - Provisional Tax
  - Income Tax Returns
  - FBT
  - KiwiSaver/ESCT

## Cache Strategy

### CloudFront Caching

```
Popular Queries (24h TTL):
- /api/v1/tax-dates?country=AU&year=2024
- /api/v1/tax-dates?country=NZ&year=2024

Filtered Queries (6h TTL):
- /api/v1/tax-dates?country=AU&year=2024&type=bas
- /api/v1/tax-dates?country=AU&year=2024&state=NSW
```

### Cache Warming

The Cache Warmer Lambda pre-populates CloudFront edge caches:

```javascript
// High priority queries - warm daily
country + year only (base queries)

// Medium priority - warm twice daily
type filters (bas, payroll, filing)
state filters (NSW, VIC, QLD)

// Low priority - warm weekly
complex filters (agency, frequency)
```

## Performance Analysis

### Query Performance

```
DynamoDB Query:
- Single partition key lookup
- ~110 items for AU full year
- Query time: <10ms
- Filter processing: <5ms

API Response:
- Cold start: ~300ms
- Warm Lambda: ~50ms
- CloudFront cache: ~20ms
```

### Scalability

```
Current capacity:
- 800 items (5 years data)
- Single DynamoDB partition
- 99% cache hit ratio

10x growth:
- 8,000 items
- Still single partition
- Minimal performance impact
```

## Loading Scripts

### Manual Loading

```bash
# Load specific country/year
./scripts/load-tax-data.sh

# Direct Lambda invocation
aws lambda invoke \
  --function-name GetComplicalApiComputeStack-DataLoaderFunction \
  --payload '{"country": "AU", "year": 2024}' \
  response.json
```

### Automated Loading

Future enhancement: EventBridge rule for annual updates

```yaml
Schedule: rate(1 year)
Target: DataLoaderFunction
Payload:
  country: ALL
  year: current_year + 1
```

## Data Updates

### Adding New Tax Dates

1. Update `/lambdas/data-loader/au-tax-data.ts` or `nz-tax-data.ts`
2. Deploy updated Lambda
3. Run data loader for affected year
4. Invalidate CloudFront cache for affected queries

### Modifying Existing Data

1. Data is idempotent - rerun loader overwrites existing
2. No need to delete first
3. Cache automatically expires based on TTL

## Monitoring

### CloudWatch Metrics

- **Invocation count**: Track data loads
- **Duration**: Monitor loading performance
- **Errors**: Alert on load failures
- **DynamoDB writes**: Track items loaded

### Validation

```bash
# Query DynamoDB directly
aws dynamodb query \
  --table-name getcomplical-tax-data \
  --key-condition-expression "pk = :pk" \
  --expression-attribute-values '{":pk":{"S":"AU#2024"}}' \
  --select COUNT
```

## Cost Optimization

### DynamoDB Costs
- Write capacity: 1 WCU per item
- ~160 items = 160 WCUs per load
- On-demand pricing: $0.00013 per WCU
- **Cost per full load**: ~$0.02

### Lambda Costs
- Execution time: ~2 seconds per load
- Memory: 512MB
- **Cost per load**: ~$0.0001

### Total Loading Cost
- **Per year per country**: ~$0.02
- **Annual update all data**: ~$0.10

## Best Practices

1. **Idempotent Loading**: Can safely rerun without duplicates
2. **Batch Operations**: Use DynamoDB batch writes
3. **Error Handling**: Log failures, continue with rest
4. **Monitoring**: Track successful loads
5. **Cache Invalidation**: Only when necessary

## Future Enhancements

1. **Incremental Updates**: Load only changed data
2. **Version Control**: Track data version history
3. **Automated Updates**: Subscribe to government RSS/APIs
4. **Bulk Export**: Support CSV/JSON export
5. **Multi-region**: Replicate to other AWS regions