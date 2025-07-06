import { APIGatewayTokenAuthorizerEvent, APIGatewayAuthorizerResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getTierConfig } from '../shared/tier-config';

declare global {
  var pendingPromises: Promise<any>[] | undefined;
}

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient);

const API_KEYS_TABLE = process.env.API_KEYS_TABLE!;
const USAGE_METRICS_TABLE = process.env.USAGE_METRICS_TABLE!;

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
    
    // Check current usage from API keys table (single source of truth)
    const today = new Date().toISOString().split('T')[0];
    const currentUsage = (Item.lastUsedDate === today) ? (Item.usageToday || 0) : 0;
    const dailyLimit = Item.dailyLimit || tierConfig.dailyLimit;
    
    if (currentUsage >= dailyLimit) {
      // Rate limit exceeded
      const resetTime = new Date();
      resetTime.setUTCHours(24, 0, 0, 0); // Next midnight UTC
      
      const policy = generatePolicy(Item.userId, 'Deny', event.methodArn);
      policy.context = {
        rateLimitExceeded: 'true',
        retryAfter: Math.ceil((resetTime.getTime() - Date.now()) / 1000).toString(),
        currentUsage: currentUsage.toString(),
        limit: dailyLimit.toString(),
        resetTime: resetTime.toISOString(),
      };
      return policy;
    }

    // Track usage event - single write, atomic operation
    try {
      await trackUsageEvent({
        apiKey,
        customerId: Item.customerId || Item.userId || 'unknown',
        userId: Item.userId || 'unknown',
        tier: Item.tier || 'free',
        endpoint: event.methodArn,
        timestamp: new Date().toISOString(),
        dailyLimit: Item.dailyLimit || tierConfig.dailyLimit,
      });
    } catch (error) {
      // Log error but don't fail authorization
      console.error('Failed to track usage event:', error);
    }

    // Generate allow policy with usage context
    const resetTime = new Date();
    resetTime.setUTCHours(24, 0, 0, 0); // Next midnight UTC
    
    const policy = generatePolicy(Item.userId || 'unknown', 'Allow', event.methodArn);
    
    // Include usage in principal ID to bust cache when usage changes
    // This creates a new cache entry every N requests
    const usageBucket = Math.floor(currentUsage / 10) * 10; // Cache per 10 requests
    policy.principalId = `${Item.userId || 'unknown'}#${usageBucket}`;
    
    policy.context = {
      userId: Item.userId || 'unknown',
      customerId: Item.customerId || Item.userId || 'unknown',
      tier: Item.tier || 'free',
      tierName: tierConfig.name,
      apiKey: apiKey,
      currentUsage: (currentUsage + 1).toString(), // Include this request
      dailyLimit: dailyLimit.toString(),
      remainingRequests: Math.max(0, dailyLimit - currentUsage - 1).toString(),
      resetsAt: resetTime.toISOString(),
      rateLimit: (Item.rateLimit || tierConfig.rateLimit).toString(),
    };

    return policy;
  } catch (error) {
    console.error('Authorization failed:', error);
    throw new Error('Unauthorized');
  }
};

async function trackUsageEvent(params: {
  apiKey: string;
  customerId: string;
  userId: string;
  tier: string;
  endpoint: string;
  timestamp: string;
  dailyLimit: number;
}) {
  const now = Date.now();
  const date = new Date(params.timestamp);
  const dateStr = date.toISOString().split('T')[0];
  const hourStr = date.toISOString().substring(0, 13);
  const monthStr = dateStr.substring(0, 7);
  
  // Extract endpoint from ARN
  const arnParts = params.endpoint.split(':');
  const apiPath = arnParts[5]?.split('/').slice(3).join('/') || '/unknown';
  const endpointKey = apiPath.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
  
  // Single atomic write to usage events table
  const eventId = `${params.apiKey}#${now}#${Math.random().toString(36).substring(7)}`;
  
  const eventWrite = docClient.send(
    new UpdateCommand({
      TableName: USAGE_METRICS_TABLE,
      Key: {
        pk: `events#${dateStr}`,
        sk: eventId,
      },
      UpdateExpression: `
        SET #ts = :timestamp,
            #apiKey = :apiKey,
            #customerId = :customerId,
            #userId = :userId,
            #tier = :tier,
            #endpoint = :endpoint,
            #hour = :hour,
            #month = :month,
            #ttl = :ttl
      `,
      ExpressionAttributeNames: {
        '#ts': 'timestamp',
        '#apiKey': 'apiKey',
        '#customerId': 'customerId',
        '#userId': 'userId',
        '#tier': 'tier',
        '#endpoint': 'endpoint',
        '#hour': 'hour',
        '#month': 'month',
        '#ttl': 'ttl',
      },
      ExpressionAttributeValues: {
        ':timestamp': params.timestamp,
        ':apiKey': params.apiKey,
        ':customerId': params.customerId,
        ':userId': params.userId,
        ':tier': params.tier,
        ':endpoint': endpointKey,
        ':hour': hourStr,
        ':month': monthStr,
        ':ttl': Math.floor(now / 1000) + (90 * 24 * 60 * 60), // 90 days
      },
    })
  );
  
  // Update API key counters atomically
  const counterUpdate = docClient.send(
    new UpdateCommand({
      TableName: API_KEYS_TABLE,
      Key: { apiKey: params.apiKey },
      UpdateExpression: `
        SET lastUsedDate = :today
        ADD totalUsage :one,
            usageToday :one
      `,
      ExpressionAttributeValues: {
        ':today': dateStr,
        ':one': 1,
      },
      ConditionExpression: 'attribute_exists(apiKey)',
    })
  ).catch(async (error) => {
    // If it's a new day, reset the daily counter
    if (error.name === 'ValidationException' || error.name === 'ConditionalCheckFailedException') {
      const { Item } = await docClient.send(
        new GetCommand({
          TableName: API_KEYS_TABLE,
          Key: { apiKey: params.apiKey },
          ProjectionExpression: 'lastUsedDate',
        })
      );
      
      if (Item?.lastUsedDate !== dateStr) {
        // Reset daily counter for new day
        await docClient.send(
          new UpdateCommand({
            TableName: API_KEYS_TABLE,
            Key: { apiKey: params.apiKey },
            UpdateExpression: `
              SET lastUsedDate = :today,
                  usageToday = :one
              ADD totalUsage :one
            `,
            ExpressionAttributeValues: {
              ':today': dateStr,
              ':one': 1,
            },
          })
        );
      } else {
        // Same day, just increment
        await docClient.send(
          new UpdateCommand({
            TableName: API_KEYS_TABLE,
            Key: { apiKey: params.apiKey },
            UpdateExpression: `
              ADD totalUsage :one,
                  usageToday :one
            `,
            ExpressionAttributeValues: {
              ':one': 1,
            },
          })
        );
      }
    }
  });
  
  // Execute both writes in parallel
  await Promise.all([eventWrite, counterUpdate]);
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