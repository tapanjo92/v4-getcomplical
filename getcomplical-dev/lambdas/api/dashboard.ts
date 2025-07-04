import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient, GetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { nanoid } from 'nanoid';

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient);
const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });

const API_KEYS_TABLE = process.env.API_KEYS_TABLE!;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Dashboard event:', JSON.stringify(event, null, 2));

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  try {
    const accessToken = event.headers.Authorization?.replace('Bearer ', '');
    
    if (!accessToken) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Unauthorized' }),
      };
    }

    const getUserResponse = await cognitoClient.send(
      new GetUserCommand({
        AccessToken: accessToken,
      })
    );

    const userId = getUserResponse.Username!;
    const email = getUserResponse.UserAttributes?.find(attr => attr.Name === 'email')?.Value;

    if (event.httpMethod === 'POST' && event.path === '/dashboard/generate-key') {
      const apiKey = `txs_live_${nanoid(32)}`;
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