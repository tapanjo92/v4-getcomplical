import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { nanoid } from 'nanoid';
import { RateLimiter } from '../auth/rate-limiter';
import { getTierConfig, TIER_CONFIGS } from '../shared/tier-config';

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient);

const API_KEYS_TABLE = process.env.API_KEYS_TABLE!;
const RATE_LIMIT_TABLE = process.env.RATE_LIMIT_TABLE!;
const USAGE_METRICS_TABLE = process.env.USAGE_METRICS_TABLE!;

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
      const body = event.body ? JSON.parse(event.body) : {};
      const requestedTier = body.tier || 'free';
      
      // Validate tier exists
      if (!TIER_CONFIGS[requestedTier]) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Invalid tier specified' }),
        };
      }
      
      const tierConfig = getTierConfig(requestedTier);
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
            tier: requestedTier,
            dailyLimit: tierConfig.dailyLimit,
            rateLimit: tierConfig.rateLimit,
            burstLimit: tierConfig.burstLimit,
            usageToday: 0,
            totalUsage: 0,
            createdAt: now,
            lastUsedDate: null,
            description: body.description || `${tierConfig.name} API Key`,
          },
        })
      );

      return {
        statusCode: 201,
        headers,
        body: JSON.stringify({
          apiKey,
          createdAt: now,
          tier: requestedTier,
          tierName: tierConfig.name,
          dailyLimit: tierConfig.dailyLimit,
          rateLimit: tierConfig.rateLimit,
          features: tierConfig.features,
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
          const tierConfig = getTierConfig(item.tier);
          return {
            apiKey: item.apiKey,
            description: item.description,
            status: item.status,
            tier: item.tier,
            tierName: tierConfig.name,
            dailyLimit: item.dailyLimit || tierConfig.dailyLimit,
            rateLimit: item.rateLimit || tierConfig.rateLimit,
            usageToday: stats.last24Hours, // Rolling 24-hour window
            usageLastHour: stats.lastHour,
            usagePercentage: Math.round((stats.last24Hours / (item.dailyLimit || tierConfig.dailyLimit)) * 100),
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

    // New endpoint to list available tiers
    if (event.httpMethod === 'GET' && event.path === '/dashboard/tiers') {
      const tiers = Object.entries(TIER_CONFIGS).map(([key, config]) => ({
        id: key,
        name: config.name,
        dailyLimit: config.dailyLimit === -1 ? 'Unlimited' : config.dailyLimit.toLocaleString(),
        rateLimit: `${config.rateLimit} requests/second`,
        burstLimit: config.burstLimit,
        price: config.price === -1 ? 'Contact us' : `$${config.price}/month`,
        features: config.features,
        popular: key === 'pro', // Mark pro as most popular
      }));

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          tiers,
          currentUserTier: 'free', // TODO: Get from user profile
        }),
      };
    }

    // Enhanced usage endpoint - monthly summary
    if (event.httpMethod === 'GET' && event.path === '/dashboard/usage/monthly') {
      const queryParams = event.queryStringParameters || {};
      const month = queryParams.month || new Date().toISOString().substring(0, 7); // Default to current month
      
      // Get all API keys for user
      const { Items: userKeys } = await docClient.send(
        new QueryCommand({
          TableName: API_KEYS_TABLE,
          IndexName: 'userId-index',
          KeyConditionExpression: 'userId = :userId',
          ExpressionAttributeValues: {
            ':userId': userId,
          },
        })
      );
      
      if (!userKeys || userKeys.length === 0) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            month,
            totalRequests: 0,
            apiKeys: [],
          }),
        };
      }
      
      // Get monthly usage for each API key
      const monthlyUsage = await Promise.all(
        userKeys.map(async (key) => {
          const response = await docClient.send(
            new QueryCommand({
              TableName: USAGE_METRICS_TABLE,
              KeyConditionExpression: 'pk = :pk AND sk = :sk',
              ExpressionAttributeValues: {
                ':pk': `usage#${key.apiKey}`,
                ':sk': `${month}#monthly`,
              },
            })
          );
          
          const monthlyData = response.Items?.[0];
          const tierConfig = getTierConfig(key.tier);
          
          return {
            apiKey: key.apiKey,
            description: key.description,
            tier: key.tier,
            monthlyLimit: tierConfig.dailyLimit === -1 ? -1 : tierConfig.dailyLimit * 30,
            totalRequests: monthlyData?.totalRequests || 0,
            dailyBreakdown: monthlyData?.dailyBreakdown || {},
            endpointBreakdown: monthlyData?.endpointBreakdown || {},
            peakDay: monthlyData?.peakDay || { date: 'N/A', requests: 0 },
            averageDaily: monthlyData?.averageDaily || 0,
            usagePercentage: tierConfig.dailyLimit === -1 
              ? 0 
              : Math.round(((monthlyData?.totalRequests || 0) / (tierConfig.dailyLimit * 30)) * 100),
          };
        })
      );
      
      const totalRequests = monthlyUsage.reduce((sum, usage) => sum + usage.totalRequests, 0);
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          month,
          totalRequests,
          apiKeys: monthlyUsage,
        }),
      };
    }
    
    // Daily usage endpoint
    if (event.httpMethod === 'GET' && event.path === '/dashboard/usage/daily') {
      const queryParams = event.queryStringParameters || {};
      const startDate = queryParams.startDate || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const endDate = queryParams.endDate || new Date().toISOString().split('T')[0];
      const apiKey = queryParams.apiKey;
      
      if (apiKey) {
        // Verify API key belongs to user
        const { Item } = await docClient.send(
          new GetCommand({
            TableName: API_KEYS_TABLE,
            Key: { apiKey },
          })
        );
        
        if (!Item || Item.userId !== userId) {
          return {
            statusCode: 403,
            headers,
            body: JSON.stringify({ error: 'Access denied' }),
          };
        }
        
        // Get daily usage data
        const response = await docClient.send(
          new QueryCommand({
            TableName: USAGE_METRICS_TABLE,
            KeyConditionExpression: 'pk = :pk AND sk BETWEEN :skStart AND :skEnd',
            ExpressionAttributeValues: {
              ':pk': `usage#${apiKey}`,
              ':skStart': `${startDate.substring(0, 7)}#daily#${startDate}`,
              ':skEnd': `${endDate.substring(0, 7)}#daily#${endDate}`,
            },
          })
        );
        
        const dailyData = response.Items?.map(item => ({
          date: item.date,
          requests: item.totalRequests,
          endpoints: item.endpoints,
        })) || [];
        
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            apiKey,
            startDate,
            endDate,
            dailyUsage: dailyData,
            total: dailyData.reduce((sum, day) => sum + day.requests, 0),
          }),
        };
      }
      
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'API key parameter required' }),
      };
    }
    
    // Real-time usage endpoint (last 24 hours by hour)
    if (event.httpMethod === 'GET' && event.path === '/dashboard/usage/realtime') {
      const apiKey = event.queryStringParameters?.apiKey;
      
      if (!apiKey) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'API key parameter required' }),
        };
      }
      
      // Verify API key belongs to user
      const { Item } = await docClient.send(
        new GetCommand({
          TableName: API_KEYS_TABLE,
          Key: { apiKey },
        })
      );
      
      if (!Item || Item.userId !== userId) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'Access denied' }),
        };
      }
      
      // Get last 24 hours of hourly data
      const now = new Date();
      const monthStr = now.toISOString().substring(0, 7);
      const response = await docClient.send(
        new QueryCommand({
          TableName: USAGE_METRICS_TABLE,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
          ExpressionAttributeValues: {
            ':pk': `usage#${apiKey}`,
            ':skPrefix': `${monthStr}#hourly#`,
          },
          ScanIndexForward: false, // Most recent first
          Limit: 24, // Last 24 hours
        })
      );
      
      const hourlyData = response.Items?.map(item => ({
        hour: item.hour,
        requests: item.totalRequests,
        endpoints: item.endpoints,
      })) || [];
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          apiKey,
          hourlyUsage: hourlyData.reverse(), // Chronological order
          total24Hours: hourlyData.reduce((sum, hour) => sum + hour.requests, 0),
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