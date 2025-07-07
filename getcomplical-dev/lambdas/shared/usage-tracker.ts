import { FirehoseClient, PutRecordCommand } from '@aws-sdk/client-firehose';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import Redis from 'ioredis';

const firehoseClient = new FirehoseClient({ region: process.env.AWS_REGION });
const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION });
let redis: Redis | null = null;
let valkeyAuthToken: string | null = null;

const FIREHOSE_STREAM_NAME = process.env.FIREHOSE_STREAM_NAME!;
const REDIS_ENDPOINT = process.env.REDIS_ENDPOINT!;
const REDIS_TLS_ENABLED = process.env.REDIS_TLS_ENABLED === 'true';
const VALKEY_AUTH_TOKEN_ARN = process.env.VALKEY_AUTH_TOKEN_ARN!;

// Get Valkey auth token from Secrets Manager
async function getValkeyAuthToken(): Promise<string> {
  if (valkeyAuthToken) return valkeyAuthToken;
  
  try {
    const response = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: VALKEY_AUTH_TOKEN_ARN })
    );
    const secret = JSON.parse(response.SecretString!);
    valkeyAuthToken = secret.authToken;
    return valkeyAuthToken;
  } catch (error) {
    console.error('Failed to retrieve Valkey auth token:', error);
    throw error;
  }
}

// Initialize Redis connection
async function getRedisClient(): Promise<Redis> {
  if (!redis) {
    const config: any = {
      host: REDIS_ENDPOINT,
      port: 6379,
      maxRetriesPerRequest: 2,
      retryStrategy: (times) => Math.min(times * 50, 500),
      enableReadyCheck: true,
      lazyConnect: true,
    };

    // Add TLS and auth if enabled
    if (REDIS_TLS_ENABLED) {
      config.tls = {};
      config.password = await getValkeyAuthToken();
    }

    redis = new Redis(config);
    await redis.connect();
  }
  return redis;
}

export interface UsageEvent {
  apiKey: string;
  customerId: string;
  userId: string;
  tier: string;
  endpoint: string;
  method: string;
  statusCode: number;
  responseTimeMs: number;
  cacheHit?: boolean;
  rateLimitExceeded?: boolean;
  errorMessage?: string;
}

/**
 * Track API usage event and increment rate limit counter ONLY for successful requests
 * This implements the dual tracking pattern:
 * - All events go to Kinesis for analytics
 * - Only 200s count against rate limits
 */
export async function trackApiUsage(event: UsageEvent): Promise<void> {
  const timestamp = new Date().toISOString();
  const requestId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
  
  // 1. Always send to Kinesis for analytics (all status codes)
  const firehoseRecord = {
    timestamp,
    request_id: requestId,
    api_key: event.apiKey,
    customer_id: event.customerId,
    user_id: event.userId,
    tier: event.tier,
    endpoint: event.endpoint,
    method: event.method,
    status_code: event.statusCode,
    response_time_ms: event.responseTimeMs,
    region: process.env.AWS_REGION,
    cache_hit: event.cacheHit || false,
    rate_limit_exceeded: event.rateLimitExceeded || false,
    error_message: event.errorMessage || null,
  };

  try {
    await firehoseClient.send(
      new PutRecordCommand({
        DeliveryStreamName: FIREHOSE_STREAM_NAME,
        Record: {
          Data: Buffer.from(JSON.stringify(firehoseRecord) + '\n'),
        },
      })
    );
  } catch (error) {
    console.error('Failed to send to Kinesis Firehose:', error);
  }

  // 2. Increment rate limit counter ONLY for successful requests (200-299)
  if (event.statusCode >= 200 && event.statusCode < 300) {
    try {
      const redisClient = await getRedisClient();
      const today = new Date().toISOString().split('T')[0];
      const rateLimitKey = `ratelimit:${event.apiKey}:${today}`;
      
      // Atomic increment with expiry
      const pipeline = redisClient.pipeline();
      pipeline.incr(rateLimitKey);
      pipeline.expire(rateLimitKey, 86400); // 24 hours
      await pipeline.exec();
      
      // Also update usage statistics (for dashboard)
      const statsKey = `stats:${event.apiKey}:${today}`;
      const hourlyKey = `stats:${event.apiKey}:${timestamp.substring(0, 13)}`; // Hour precision
      
      const statsPipeline = redisClient.pipeline();
      
      // Daily stats
      statsPipeline.hincrby(statsKey, 'total_requests', 1);
      statsPipeline.hincrby(statsKey, `endpoint:${event.endpoint}`, 1);
      statsPipeline.expire(statsKey, 86400 * 7); // Keep for 7 days
      
      // Hourly stats
      statsPipeline.hincrby(hourlyKey, 'total_requests', 1);
      statsPipeline.expire(hourlyKey, 86400); // Keep for 24 hours
      
      await statsPipeline.exec();
      
    } catch (error) {
      console.error('Failed to update Redis counters:', error);
      // Don't throw - we don't want to fail the request if Redis is down
    }
  } else {
    // For non-200 responses, still track in statistics but not rate limits
    try {
      const redisClient = await getRedisClient();
      const today = new Date().toISOString().split('T')[0];
      const statsKey = `stats:${event.apiKey}:${today}`;
      
      // Track errors separately
      await redisClient.hincrby(statsKey, `errors:${event.statusCode}`, 1);
      
    } catch (error) {
      console.error('Failed to update error stats:', error);
    }
  }
}

/**
 * Get current usage for an API key (successful requests only)
 */
export async function getCurrentUsage(apiKey: string): Promise<number> {
  try {
    const redisClient = await getRedisClient();
    const today = new Date().toISOString().split('T')[0];
    const rateLimitKey = `ratelimit:${apiKey}:${today}`;
    
    const usage = await redisClient.get(rateLimitKey);
    return usage ? parseInt(usage) : 0;
  } catch (error) {
    console.error('Failed to get current usage:', error);
    return 0;
  }
}

/**
 * Get usage statistics for dashboard
 */
export async function getUsageStats(apiKey: string, date?: string): Promise<any> {
  try {
    const redisClient = await getRedisClient();
    const targetDate = date || new Date().toISOString().split('T')[0];
    const statsKey = `stats:${apiKey}:${targetDate}`;
    
    const stats = await redisClient.hgetall(statsKey);
    return stats;
  } catch (error) {
    console.error('Failed to get usage stats:', error);
    return {};
  }
}