import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { nanoid } from 'nanoid';

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient);

const API_KEYS_TABLE = process.env.API_KEYS_TABLE!;

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

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          keys: Items.map(item => ({
            apiKey: item.apiKey,
            status: item.status,
            tier: item.tier,
            dailyLimit: item.dailyLimit,
            usageToday: item.usageToday,
            totalUsage: item.totalUsage,
            createdAt: item.createdAt,
            lastUsedDate: item.lastUsedDate,
          })),
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