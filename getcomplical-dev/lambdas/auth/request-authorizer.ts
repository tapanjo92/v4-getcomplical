import { APIGatewayRequestAuthorizerEvent, APIGatewayAuthorizerResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { FirehoseClient, PutRecordCommand } from '@aws-sdk/client-firehose';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import Redis from 'ioredis';
import { getTierConfig } from '../shared/tier-config';
import { RateLimiter } from './rate-limiter';

// Initialize clients
const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient);
const firehoseClient = new FirehoseClient({ region: process.env.AWS_REGION });
const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION });

// Initialize rate limiter - lazy initialization to avoid startup errors
let rateLimiter: RateLimiter | null = null;

// Redis client - lazy initialization
let redis: Redis | null = null;
let valkeyAuthToken: string | null = null;
let cloudfrontSecret: string | null = null;

const API_KEYS_TABLE = process.env.API_KEYS_TABLE!;
const FIREHOSE_STREAM_NAME = process.env.FIREHOSE_STREAM_NAME!;
const RATE_LIMIT_TABLE = process.env.RATE_LIMIT_TABLE!;
const REDIS_ENDPOINT = process.env.REDIS_ENDPOINT!;
const REDIS_TLS_ENABLED = process.env.REDIS_TLS_ENABLED === 'true';
const VALKEY_AUTH_TOKEN_ARN = process.env.VALKEY_AUTH_TOKEN_ARN!;
const CLOUDFRONT_SECRET_ARN = process.env.CLOUDFRONT_SECRET_ARN!;
const CACHE_TTL = 300; // 5 minutes cache for API key details

// Get CloudFront secret from Secrets Manager
async function getCloudfrontSecret(): Promise<string> {
  if (cloudfrontSecret) return cloudfrontSecret;
  
  const response = await secretsClient.send(
    new GetSecretValueCommand({
      SecretId: CLOUDFRONT_SECRET_ARN,
    })
  );
  
  cloudfrontSecret = response.SecretString!;
  return cloudfrontSecret;
}

// Get Valkey auth token from Secrets Manager
async function getValkeyAuthToken(): Promise<string> {
  if (valkeyAuthToken) return valkeyAuthToken;
  
  const response = await secretsClient.send(
    new GetSecretValueCommand({
      SecretId: VALKEY_AUTH_TOKEN_ARN,
    })
  );
  
  valkeyAuthToken = response.SecretString!;
  return valkeyAuthToken;
}

// Initialize Redis client with auth
async function getRedisClient(): Promise<Redis> {
  if (!redis) {
    const authToken = await getValkeyAuthToken();
    const [host, port] = REDIS_ENDPOINT.split(':');
    
    const config: any = {
      host,
      port: parseInt(port || '6379'),
      password: authToken,
      lazyConnect: true,
      tls: REDIS_TLS_ENABLED ? {} : undefined,
    };
    
    redis = new Redis(config);
    await redis.connect();
  }
  return redis;
}

// Track usage event asynchronously
async function trackEvent(event: any): Promise<void> {
  const record = {
    ...event,
    timestamp: new Date().toISOString(),
  };

  await firehoseClient.send(
    new PutRecordCommand({
      DeliveryStreamName: FIREHOSE_STREAM_NAME,
      Record: {
        Data: Buffer.from(JSON.stringify(record) + '\n'),
      },
    })
  );
}

function trackEventAsync(event: any): void {
  trackEvent(event).catch(console.error);
}

// Extract endpoint and method from the event
function extractEndpoint(arn: string): string {
  const parts = arn.split(':');
  const pathParts = parts[parts.length - 1].split('/');
  return `/${pathParts.slice(3).join('/')}`;
}

function extractMethod(arn: string): string {
  const parts = arn.split(':');
  const pathParts = parts[parts.length - 1].split('/');
  return pathParts[2];
}

// Generate the policy
function generatePolicy(principalId: string, effect: string, resource: string): APIGatewayAuthorizerResult {
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

export const handler = async (event: APIGatewayRequestAuthorizerEvent): Promise<APIGatewayAuthorizerResult> => {
  const startTime = Date.now();
  
  // Note: CloudFront-only access is enforced by API Gateway Resource Policy
  // This authorizer focuses on API key validation and rate limiting
  
  // Validate API Key
  const apiKey = event.headers?.['X-Api-Key'] || event.headers?.['x-api-key'];
  
  if (!apiKey || (!apiKey.startsWith('gc_live_') && !apiKey.startsWith('gc_test_'))) {
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
    
    // Initialize rate limiter if not already done
    if (!rateLimiter) {
      rateLimiter = new RateLimiter(docClient, RATE_LIMIT_TABLE);
    }
    
    // Advanced rate limiting using sharded DynamoDB with rolling window
    const rateLimitResult = await rateLimiter.checkAndUpdateLimit(
      apiKey,
      dailyLimit,
      keyDetails.tier
    );
    
    if (!rateLimitResult.allowed) {
      // Rate limit exceeded
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
      });
      
      const policy = generatePolicy(keyDetails.userId, 'Deny', event.methodArn);
      policy.context = {
        rateLimitExceeded: 'true',
        retryAfter: rateLimitResult.retryAfter?.toString() || '3600',
        currentUsage: rateLimitResult.currentUsage.toString(),
        limit: rateLimitResult.limit.toString(),
        resetTime: rateLimitResult.resetsAt.toISOString(),
      };
      return policy;
    }

    // Rate limit has already been incremented by checkAndUpdateLimit
    // Track the successful authorization
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
    });

    // Generate allow policy with context
    const policy = generatePolicy(keyDetails.userId, 'Allow', event.methodArn);
    
    // Pass context to the Lambda function
    policy.context = {
      apiKey,
      userId: keyDetails.userId,
      customerId: keyDetails.customerId || keyDetails.userId,
      tier: keyDetails.tier || 'free',
      dailyLimit: dailyLimit.toString(),
      currentUsage: rateLimitResult.currentUsage.toString(),
      requestsRemaining: (dailyLimit - rateLimitResult.currentUsage).toString(),
    };

    return policy;
  } catch (error) {
    console.error('Authorization error:', error);
    trackEventAsync({
      apiKey: apiKey || 'unknown',
      endpoint: extractEndpoint(event.methodArn),
      method: extractMethod(event.methodArn),
      statusCode: 403,
      error: error instanceof Error ? error.message : 'Unknown error',
      responseTimeMs: Date.now() - startTime,
      eventType: 'auth_error',
    });
    throw new Error('Unauthorized');
  }
};