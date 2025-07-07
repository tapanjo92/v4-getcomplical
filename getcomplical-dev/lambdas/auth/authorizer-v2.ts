import { APIGatewayTokenAuthorizerEvent, APIGatewayAuthorizerResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { FirehoseClient, PutRecordCommand } from '@aws-sdk/client-firehose';
import Redis from 'ioredis';
import { getTierConfig } from '../shared/tier-config';

// Initialize clients
const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient);
const firehoseClient = new FirehoseClient({ region: process.env.AWS_REGION });

// Redis client - lazy initialization
let redis: Redis | null = null;

const API_KEYS_TABLE = process.env.API_KEYS_TABLE!;
const FIREHOSE_STREAM_NAME = process.env.FIREHOSE_STREAM_NAME!;
const REDIS_ENDPOINT = process.env.REDIS_ENDPOINT!;
const CACHE_TTL = 300; // 5 minutes cache for API key details

// Initialize Redis connection
async function getRedisClient(): Promise<Redis> {
  if (!redis) {
    redis = new Redis({
      host: REDIS_ENDPOINT,
      port: 6379,
      maxRetriesPerRequest: 2,
      retryStrategy: (times) => Math.min(times * 50, 500),
      enableReadyCheck: true,
      lazyConnect: true,
    });
    
    await redis.connect();
  }
  return redis;
}

export const handler = async (event: APIGatewayTokenAuthorizerEvent): Promise<APIGatewayAuthorizerResult> => {
  const startTime = Date.now();
  const apiKey = event.authorizationToken?.replace('Bearer ', '');

  if (!apiKey || !apiKey.startsWith('gc_live_')) {
    throw new Error('Unauthorized');
  }

  try {
    // Get Redis client
    const redisClient = await getRedisClient();
    
    // Check cached API key details first
    const cacheKey = `apikey:${apiKey}`;
    let apiKeyData = await redisClient.get(cacheKey);
    let keyDetails: any;

    if (apiKeyData) {
      // Cache hit - parse the data
      keyDetails = JSON.parse(apiKeyData);
    } else {
      // Cache miss - fetch from DynamoDB
      const { Item } = await docClient.send(
        new GetCommand({
          TableName: API_KEYS_TABLE,
          Key: { apiKey },
        })
      );

      if (!Item || Item.status !== 'active') {
        throw new Error('Unauthorized');
      }

      keyDetails = Item;
      
      // Cache the API key details
      await redisClient.setex(cacheKey, CACHE_TTL, JSON.stringify(keyDetails));
    }

    // Get tier configuration
    const tierConfig = getTierConfig(keyDetails.tier);
    const dailyLimit = keyDetails.dailyLimit || tierConfig.dailyLimit;
    
    // Rate limiting using Redis token bucket algorithm
    const today = new Date().toISOString().split('T')[0];
    const rateLimitKey = `ratelimit:${apiKey}:${today}`;
    
    // Get current usage without incrementing yet
    const currentUsageStr = await redisClient.get(rateLimitKey);
    const currentUsage = currentUsageStr ? parseInt(currentUsageStr) : 0;
    
    if (currentUsage >= dailyLimit) {
      // Rate limit exceeded
      const resetTime = new Date();
      resetTime.setUTCHours(24, 0, 0, 0);
      
      // Track rate limit exceeded event asynchronously
      trackEventAsync({
        apiKey,
        customerId: keyDetails.customerId || keyDetails.userId,
        userId: keyDetails.userId,
        tier: keyDetails.tier,
        endpoint: extractEndpoint(event.methodArn),
        method: extractMethod(event.methodArn),
        statusCode: 429,
        responseTimeMs: Date.now() - startTime,
        rateLimitExceeded: true,
      }).catch(console.error);
      
      const policy = generatePolicy(keyDetails.userId, 'Deny', event.methodArn);
      policy.context = {
        rateLimitExceeded: 'true',
        retryAfter: Math.ceil((resetTime.getTime() - Date.now()) / 1000).toString(),
        currentUsage: currentUsage.toString(),
        limit: dailyLimit.toString(),
        resetTime: resetTime.toISOString(),
      };
      return policy;
    }

    // Important: We'll track the event but NOT increment the rate limit counter yet
    // The API handler will call back to increment only on successful responses
    
    // Track authorization attempt (not the final status)
    trackEventAsync({
      apiKey,
      customerId: keyDetails.customerId || keyDetails.userId,
      userId: keyDetails.userId,
      tier: keyDetails.tier,
      endpoint: extractEndpoint(event.methodArn),
      method: extractMethod(event.methodArn),
      statusCode: 0, // Will be updated by API handler
      responseTimeMs: Date.now() - startTime,
      cacheHit: !!apiKeyData,
      eventType: 'auth_attempt',
    }).catch(console.error);

    // Generate allow policy with usage context
    const resetTime = new Date();
    resetTime.setUTCHours(24, 0, 0, 0);
    
    // Use usage buckets for API Gateway caching
    const usageBucket = Math.floor(currentUsage / 50) * 50; // Cache per 50 requests
    const policy = generatePolicy(`${keyDetails.userId}#${usageBucket}`, 'Allow', event.methodArn);
    
    policy.context = {
      userId: keyDetails.userId || 'unknown',
      customerId: keyDetails.customerId || keyDetails.userId || 'unknown',
      tier: keyDetails.tier || 'free',
      tierName: tierConfig.name,
      apiKey: apiKey,
      currentUsage: currentUsage.toString(),
      dailyLimit: dailyLimit.toString(),
      remainingRequests: Math.max(0, dailyLimit - currentUsage).toString(),
      resetsAt: resetTime.toISOString(),
      rateLimit: (keyDetails.rateLimit || tierConfig.rateLimit).toString(),
    };

    return policy;
  } catch (error) {
    console.error('Authorization failed:', error);
    
    // Track error event
    trackEventAsync({
      apiKey,
      endpoint: extractEndpoint(event.methodArn),
      method: extractMethod(event.methodArn),
      statusCode: 401,
      responseTimeMs: Date.now() - startTime,
      error: error.message,
    }).catch(console.error);
    
    throw new Error('Unauthorized');
  }
};

// Async function to track events to Kinesis Firehose
async function trackEventAsync(eventData: any): Promise<void> {
  const record = {
    timestamp: new Date().toISOString(),
    request_id: Math.random().toString(36).substring(7),
    region: process.env.AWS_REGION,
    ...eventData,
  };

  try {
    await firehoseClient.send(
      new PutRecordCommand({
        DeliveryStreamName: FIREHOSE_STREAM_NAME,
        Record: {
          Data: Buffer.from(JSON.stringify(record) + '\n'),
        },
      })
    );
  } catch (error) {
    // Log but don't fail the request
    console.error('Failed to track event to Firehose:', error);
  }
}

// Helper functions
function extractEndpoint(methodArn: string): string {
  const arnParts = methodArn.split(':');
  const apiPath = arnParts[5]?.split('/').slice(3).join('/') || '/unknown';
  return apiPath;
}

function extractMethod(methodArn: string): string {
  const arnParts = methodArn.split(':');
  const pathParts = arnParts[5]?.split('/') || [];
  return pathParts[2] || 'GET';
}

function generatePolicy(
  principalId: string,
  effect: 'Allow' | 'Deny',
  resource: string
): APIGatewayAuthorizerResult {
  return {
    principalId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Action: 'execute-api:Invoke',
          Effect: effect,
          Resource: resource,
        },
      ],
    },
    context: {},
  };
}