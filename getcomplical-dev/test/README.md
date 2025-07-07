# GetComplical Test Scripts

## Current Test Scripts

### test-api-v2.sh
Comprehensive test script for the production architecture:
- Tests health endpoint
- Verifies private API (direct access blocked)
- Tests authentication and rate limiting
- Validates CloudFront caching
- Checks Valkey-based rate limiting

Usage:
```bash
# With default test key
./test-api-v2.sh

# With your API key
API_KEY=gc_live_your_key ./test-api-v2.sh
```

### TESTING-GUIDE.md
Complete manual testing guide with:
- Architecture overview
- Step-by-step testing procedures
- Performance benchmarks
- Troubleshooting tips

## Removed Scripts

The following outdated scripts were removed:
- `end-to-end-test.sh` - Used old API Gateway URLs
- `quick-test.sh` - Referenced old architecture
- `simple-api-test.sh` - Outdated authentication flow
- `test-production-tracking.sh` - Used direct API URLs
- `MANUAL_TESTING.md` - Replaced by TESTING-GUIDE.md

## Data Loading

Use the script in the scripts directory:
```bash
./scripts/load-tax-data.sh
```

This loads tax data for AU and NZ (2024-2025).