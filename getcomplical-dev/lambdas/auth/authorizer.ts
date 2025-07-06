import { APIGatewayTokenAuthorizerEvent, APIGatewayAuthorizerResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { RateLimiter } from './rate-limiter';
import { getTierConfig } from '../shared/tier-config';

declare global {
  var pendingPromises: Promise<any>[] | undefined;
}

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient);

const API_KEYS_TABLE = process.env.API_KEYS_TABLE!;
const RATE_LIMIT_TABLE = process.env.RATE_LIMIT_TABLE!;
const USAGE_METRICS_TABLE = process.env.USAGE_METRICS_TABLE!;

const rateLimiter = new RateLimiter(docClient, RATE_LIMIT_TABLE);

export const handler = async (event: APIGatewayTokenAuthorizerEvent): Promise<APIGatewayAuthorizerResult> => {
  // Security: Never log authorization tokens or API keys
  const apiKey = event.authorizationToken?.replace('Bearer ', '');

  if (!apiKey || !apiKey.startsWith('gc_live_')) {
    throw new Error('Unauthorized');
  }

  try {
    // Get API key details
    const { Item } = await docClient.send(
      new GetCommand({
        TableName: API_KEYS_TABLE,
        Key: { apiKey },
      })
    );

    if (!Item || Item.status !== 'active') {
      throw new Error('Unauthorized');
    }

    // Get tier configuration for defaults
    const tierConfig = getTierConfig(Item.tier);
    
    // Check rate limit with new sharded approach
    const rateLimitResult = await rateLimiter.checkAndUpdateLimit(
      apiKey,
      Item.dailyLimit || tierConfig.dailyLimit,
      Item.tier || 'free'
    );

    if (!rateLimitResult.allowed) {
      // Include rate limit headers in the context for the response
      const policy = generatePolicy(Item.userId, 'Deny', event.methodArn);
      policy.context = {
        ...policy.context,
        rateLimitExceeded: 'true',
        retryAfter: rateLimitResult.retryAfter?.toString() || '3600',
        currentUsage: rateLimitResult.currentUsage.toString(),
        limit: rateLimitResult.limit.toString(),
      };
      return policy;
    }

    // Track detailed usage metrics
    try {
      await trackUsageMetrics({
        apiKey,
        customerId: Item.customerId || Item.userId,
        userId: Item.userId,
        tier: Item.tier || 'free',
        endpoint: event.methodArn,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      // Log error but don't fail authorization
      console.error('Failed to track usage metrics:', error);
    }

    // Generate allow policy with usage context
    const policy = generatePolicy(Item.userId, 'Allow', event.methodArn);
    policy.context = {
      userId: Item.userId,
      customerId: Item.customerId || Item.userId,
      tier: Item.tier || 'free',
      tierName: tierConfig.name,
      apiKey: apiKey,
      currentUsage: rateLimitResult.currentUsage.toString(),
      dailyLimit: rateLimitResult.limit.toString(),
      remainingRequests: (rateLimitResult.limit - rateLimitResult.currentUsage).toString(),
      resetsAt: rateLimitResult.resetsAt.toISOString(),
      rateLimit: (Item.rateLimit || tierConfig.rateLimit).toString(),
    };

    return policy;
  } catch (error) {
    console.error('Authorization failed:', error);
    throw new Error('Unauthorized');
  }
};

async function trackUsageMetrics(params: {
  apiKey: string;
  customerId: string;
  userId: string;
  tier: string;
  endpoint: string;
  timestamp: string;
}) {
  const date = new Date(params.timestamp);
  const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
  const monthStr = dateStr.substring(0, 7); // YYYY-MM
  const hourStr = date.toISOString().substring(0, 13); // YYYY-MM-DDTHH
  
  // Extract endpoint details from ARN
  const arnParts = params.endpoint.split(':');
  const apiPath = arnParts[5]?.split('/').slice(3).join('/') || '/unknown';
  
  // Update hourly metrics (for real-time monitoring)
  const hourlyUpdate = docClient.send(
    new UpdateCommand({
      TableName: USAGE_METRICS_TABLE,
      Key: {
        pk: `usage#${params.apiKey}`,
        sk: `${monthStr}#hourly#${hourStr}`,
      },
      UpdateExpression: `
        SET #date = :date,
            #hour = :hour,
            #apiKey = :apiKey,
            #customerId = :customerId,
            #tier = :tier,
            #ttl = :ttl
        ADD #totalRequests :inc,
            #endpoints.#endpoint :inc
      `,
      ExpressionAttributeNames: {
        '#date': 'date',
        '#hour': 'hour',
        '#apiKey': 'apiKey',
        '#customerId': 'customerId',
        '#tier': 'tier',
        '#totalRequests': 'totalRequests',
        '#endpoints': 'endpoints',
        '#endpoint': apiPath.replace(/[^a-zA-Z0-9]/g, '_'),
        '#ttl': 'ttl',
      },
      ExpressionAttributeValues: {
        ':date': dateStr,
        ':hour': hourStr,
        ':apiKey': params.apiKey,
        ':customerId': params.customerId,
        ':tier': params.tier,
        ':inc': 1,
        ':ttl': Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60), // 7 days TTL
      },
    })
  );
  
  // Update daily metrics (for billing)
  const dailyUpdate = docClient.send(
    new UpdateCommand({
      TableName: USAGE_METRICS_TABLE,
      Key: {
        pk: `usage#${params.apiKey}`,
        sk: `${monthStr}#daily#${dateStr}`,
      },
      UpdateExpression: `
        SET #date = :date,
            #apiKey = :apiKey,
            #customerId = :customerId,
            #tier = :tier,
            #ttl = :ttl
        ADD #totalRequests :inc,
            #endpoints.#endpoint :inc
      `,
      ExpressionAttributeNames: {
        '#date': 'date',
        '#apiKey': 'apiKey',
        '#customerId': 'customerId',
        '#tier': 'tier',
        '#totalRequests': 'totalRequests',
        '#endpoints': 'endpoints',
        '#endpoint': apiPath.replace(/[^a-zA-Z0-9]/g, '_'),
        '#ttl': 'ttl',
      },
      ExpressionAttributeValues: {
        ':date': dateStr,
        ':apiKey': params.apiKey,
        ':customerId': params.customerId,
        ':tier': params.tier,
        ':inc': 1,
        ':ttl': Math.floor(Date.now() / 1000) + (90 * 24 * 60 * 60), // 90 days TTL
      },
    })
  );
  
  // Run both updates in parallel
  await Promise.all([hourlyUpdate, dailyUpdate]);
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