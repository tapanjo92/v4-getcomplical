import { APIGatewayTokenAuthorizerEvent, APIGatewayAuthorizerResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient);

const API_KEYS_TABLE = process.env.API_KEYS_TABLE!;

export const handler = async (event: APIGatewayTokenAuthorizerEvent): Promise<APIGatewayAuthorizerResult> => {
  console.log('Authorizer event:', JSON.stringify(event, null, 2));

  const apiKey = event.authorizationToken?.replace('Bearer ', '');

  if (!apiKey || !apiKey.startsWith('gc_live_')) {
    throw new Error('Unauthorized');
  }

  try {
    const { Item } = await docClient.send(
      new GetCommand({
        TableName: API_KEYS_TABLE,
        Key: { apiKey },
      })
    );

    if (!Item || Item.status !== 'active') {
      throw new Error('Unauthorized');
    }

    const today = new Date().toISOString().split('T')[0];
    if (Item.lastUsedDate !== today) {
      await docClient.send(
        new UpdateCommand({
          TableName: API_KEYS_TABLE,
          Key: { apiKey },
          UpdateExpression: 'SET lastUsedDate = :today, usageToday = :one, totalUsage = totalUsage + :one',
          ExpressionAttributeValues: {
            ':today': today,
            ':one': 1,
          },
        })
      );
    } else {
      if (Item.usageToday >= Item.dailyLimit) {
        throw new Error('Rate limit exceeded');
      }

      await docClient.send(
        new UpdateCommand({
          TableName: API_KEYS_TABLE,
          Key: { apiKey },
          UpdateExpression: 'SET usageToday = usageToday + :one, totalUsage = totalUsage + :one',
          ExpressionAttributeValues: {
            ':one': 1,
          },
        })
      );
    }

    return {
      principalId: Item.userId,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Action: 'execute-api:Invoke',
            Effect: 'Allow',
            Resource: event.methodArn,
          },
        ],
      },
      context: {
        userId: Item.userId,
        tier: Item.tier,
        apiKey: apiKey,
      },
    };
  } catch (error) {
    console.error('Authorization failed:', error);
    throw new Error('Unauthorized');
  }
};