import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { nanoid } from 'nanoid';
import { RateLimiter } from '../auth/rate-limiter';

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient);

const API_KEYS_TABLE = process.env.API_KEYS_TABLE!;
const RATE_LIMIT_TABLE = process.env.RATE_LIMIT_TABLE!;

const rateLimiter = new RateLimiter(docClient, RATE_LIMIT_TABLE);

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // Security: Never log full event objects that may contain auth tokens

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  try {
    // When using Cognito authorizer with API Gateway REST API, claims are at the root of authorizer object
    const authorizer = event.requestContext.authorizer;
    
    if (!authorizer) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Unauthorized' }),
      };
    }

    // In REST API with Cognito authorizer, claims are nested under 'claims' property
    const claims = authorizer.claims || authorizer;
    const userId = claims.sub || claims['cognito:username'] || claims.principalId;
    const email = claims.email;

    if (event.httpMethod === 'POST' && event.path === '/dashboard/generate-key') {
      const apiKey = `gc_live_${nanoid(32)}`;
      const now = new Date().toISOString();

      await docClient.send(
        new PutCommand({
          TableName: API_KEYS_TABLE,
          Item: {
            apiKey,
            userId,
            email,
            status: 'active',
            tier: 'free',
            dailyLimit: 1000,
            usageToday: 0,
            totalUsage: 0,
            createdAt: now,
            lastUsedDate: null,
          },
        })
      );

      return {
        statusCode: 201,
        headers,
        body: JSON.stringify({
          apiKey,
          createdAt: now,
          tier: 'free',
          dailyLimit: 1000,
        }),
      };
    }

    if (event.httpMethod === 'GET' && event.path === '/dashboard/keys') {
      const { Items = [] } = await docClient.send(
        new QueryCommand({
          TableName: API_KEYS_TABLE,
          IndexName: 'userId-index',
          KeyConditionExpression: 'userId = :userId',
          ExpressionAttributeValues: {
            ':userId': userId,
          },
        })
      );

      // Get real-time usage stats for each key
      const keysWithStats = await Promise.all(
        Items.map(async (item) => {
          const stats = await rateLimiter.getUsageStats(item.apiKey);
          return {
            apiKey: item.apiKey,
            status: item.status,
            tier: item.tier,
            dailyLimit: item.dailyLimit,
            usageToday: stats.last24Hours, // Rolling 24-hour window
            usageLastHour: stats.lastHour,
            totalUsage: item.totalUsage,
            createdAt: item.createdAt,
            lastUsedDate: item.lastUsedDate,
          };
        })
      );

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          keys: keysWithStats,
        }),
      };
    }

    // New endpoint for detailed usage stats
    if (event.httpMethod === 'GET' && event.path.startsWith('/dashboard/keys/') && event.path.endsWith('/usage')) {
      const pathParts = event.path.split('/');
      const apiKey = pathParts[pathParts.length - 2];
      
      // Verify the API key belongs to this user
      const { Item } = await docClient.send(
        new GetCommand({
          TableName: API_KEYS_TABLE,
          Key: { apiKey },
        })
      );

      if (!Item || Item.userId !== userId) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: 'API key not found' }),
        };
      }

      const stats = await rateLimiter.getUsageStats(apiKey);
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          apiKey,
          usage: {
            lastHour: stats.lastHour,
            last24Hours: stats.last24Hours,
            hourlyBreakdown: stats.byHour,
            dailyLimit: Item.dailyLimit,
            tier: Item.tier,
          },
        }),
      };
    }

    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Not found' }),
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};