import { APIGatewayTokenAuthorizerEvent, APIGatewayAuthorizerResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { RateLimiter } from './rate-limiter';

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient);

const API_KEYS_TABLE = process.env.API_KEYS_TABLE!;
const RATE_LIMIT_TABLE = process.env.RATE_LIMIT_TABLE!;

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

    // Check rate limit with new sharded approach
    const rateLimitResult = await rateLimiter.checkAndUpdateLimit(
      apiKey,
      Item.dailyLimit || 1000,
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

    // Generate allow policy with usage context
    const policy = generatePolicy(Item.userId, 'Allow', event.methodArn);
    policy.context = {
      userId: Item.userId,
      tier: Item.tier,
      apiKey: apiKey,
      currentUsage: rateLimitResult.currentUsage.toString(),
      dailyLimit: rateLimitResult.limit.toString(),
      resetsAt: rateLimitResult.resetsAt.toISOString(),
    };

    return policy;
  } catch (error) {
    console.error('Authorization failed:', error);
    throw new Error('Unauthorized');
  }
};

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