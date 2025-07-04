import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import https from 'https';

const cloudFrontClient = new CloudFrontClient({ region: process.env.AWS_REGION });

const DISTRIBUTION_ID = process.env.CLOUDFRONT_DISTRIBUTION_ID!;
const API_DOMAIN = process.env.API_DOMAIN!;
const API_KEY = process.env.CACHE_WARMER_API_KEY!;

interface WarmupQuery {
  path: string;
  priority: 'high' | 'medium' | 'low';
}

// Define popular queries to warm up
const warmupQueries: WarmupQuery[] = [
  // High priority - Most common queries (24h cache)
  { path: '/api/v1/tax-dates?country=AU&year=2024', priority: 'high' },
  { path: '/api/v1/tax-dates?country=AU&year=2025', priority: 'high' },
  { path: '/api/v1/tax-dates?country=NZ&year=2024', priority: 'high' },
  { path: '/api/v1/tax-dates?country=NZ&year=2025', priority: 'high' },
  
  // Medium priority - Common filtered queries (6h cache)
  { path: '/api/v1/tax-dates?country=AU&year=2024&type=bas', priority: 'medium' },
  { path: '/api/v1/tax-dates?country=AU&year=2024&type=payroll', priority: 'medium' },
  { path: '/api/v1/tax-dates?country=AU&year=2024&type=filing', priority: 'medium' },
  { path: '/api/v1/tax-dates?country=AU&year=2024&type=super', priority: 'medium' },
  { path: '/api/v1/tax-dates?country=AU&year=2024&state=NSW', priority: 'medium' },
  { path: '/api/v1/tax-dates?country=AU&year=2024&state=VIC', priority: 'medium' },
  { path: '/api/v1/tax-dates?country=NZ&year=2024&type=gst', priority: 'medium' },
  { path: '/api/v1/tax-dates?country=NZ&year=2024&type=paye', priority: 'medium' },
  
  // Low priority - Less common queries
  { path: '/api/v1/tax-dates?country=AU&year=2024&type=fbt', priority: 'low' },
  { path: '/api/v1/tax-dates?country=AU&year=2024&agency=ATO', priority: 'low' },
  { path: '/api/v1/tax-dates?country=AU&year=2024&frequency=quarterly', priority: 'low' },
];

export const handler = async (event: any) => {
  console.log('Starting cache warming:', JSON.stringify(event, null, 2));
  
  const { invalidateFirst = false, priority = 'all' } = event;
  
  try {
    // Optionally invalidate cache first
    if (invalidateFirst) {
      await invalidateCache();
    }
    
    // Filter queries by priority
    const queriesToWarm = priority === 'all' 
      ? warmupQueries 
      : warmupQueries.filter(q => q.priority === priority);
    
    console.log(`Warming ${queriesToWarm.length} queries`);
    
    // Warm cache with batched requests
    const results = await warmCache(queriesToWarm);
    
    // Summary
    const successful = results.filter(r => r.status === 'success').length;
    const failed = results.filter(r => r.status === 'error').length;
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Cache warming completed',
        total: results.length,
        successful,
        failed,
        results,
      }),
    };
  } catch (error) {
    console.error('Cache warming failed:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Cache warming failed',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};

async function invalidateCache(): Promise<void> {
  console.log('Invalidating CloudFront cache...');
  
  const command = new CreateInvalidationCommand({
    DistributionId: DISTRIBUTION_ID,
    InvalidationBatch: {
      CallerReference: `cache-warmer-${Date.now()}`,
      Paths: {
        Quantity: 1,
        Items: ['/api/v1/tax-dates*'],
      },
    },
  });
  
  await cloudFrontClient.send(command);
  
  // Wait for invalidation to propagate
  await new Promise(resolve => setTimeout(resolve, 5000));
}

async function warmCache(queries: WarmupQuery[]): Promise<any[]> {
  const results = [];
  
  // Process in batches to avoid overwhelming the API
  const batchSize = 5;
  for (let i = 0; i < queries.length; i += batchSize) {
    const batch = queries.slice(i, i + batchSize);
    
    const batchPromises = batch.map(query => 
      makeRequest(query.path)
        .then(response => ({
          path: query.path,
          status: 'success',
          statusCode: response.statusCode,
          cacheStatus: response.headers['x-cache'] || 'unknown',
          responseTime: response.responseTime,
        }))
        .catch(error => ({
          path: query.path,
          status: 'error',
          error: error.message,
        }))
    );
    
    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
    
    // Small delay between batches
    if (i + batchSize < queries.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  return results;
}

function makeRequest(path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    
    const options = {
      hostname: API_DOMAIN,
      path,
      method: 'GET',
      headers: {
        'X-Api-Key': API_KEY,
        'User-Agent': 'GetComplical-Cache-Warmer/1.0',
      },
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        const responseTime = Date.now() - startTime;
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          responseTime,
          data,
        });
      });
    });
    
    req.on('error', (error) => {
      reject(error);
    });
    
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    
    req.end();
  });
}