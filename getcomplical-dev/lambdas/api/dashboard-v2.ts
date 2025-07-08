import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, GetCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { nanoid } from 'nanoid';
import { getTierConfig, TIER_CONFIGS } from '../shared/tier-config';

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient);
const cloudwatchClient = new CloudWatchClient({ region: process.env.AWS_REGION });

const API_KEYS_TABLE = process.env.API_KEYS_TABLE!;
const RATE_LIMIT_TABLE = process.env.RATE_LIMIT_TABLE!;
const USAGE_METRICS_TABLE = process.env.USAGE_METRICS_TABLE!;
const AUDIT_LOG_TABLE = process.env.AUDIT_LOG_TABLE || 'getcomplical-audit-logs';

// Rate limiting for key operations
const KEY_OPERATION_LIMITS = {
  create: { limit: 5, window: 3600 }, // 5 keys per hour
  delete: { limit: 10, window: 3600 }, // 10 deletes per hour
};

interface AuditLog {
  id: string;
  userId: string;
  email: string;
  action: 'CREATE_KEY' | 'DELETE_KEY' | 'UPDATE_KEY' | 'ROTATE_KEY';
  resourceId: string;
  details: any;
  timestamp: string;
  ipAddress?: string;
  userAgent?: string;
}

async function logAuditEvent(event: APIGatewayProxyEvent, action: AuditLog['action'], resourceId: string, details: any) {
  const authorizer = event.requestContext.authorizer;
  const claims = authorizer?.claims || authorizer || {};
  const userId = claims.sub || claims['cognito:username'] || 'unknown';
  const email = claims.email || 'unknown';
  
  const auditLog: AuditLog = {
    id: `audit-${Date.now()}-${nanoid(8)}`,
    userId,
    email,
    action,
    resourceId,
    details,
    timestamp: new Date().toISOString(),
    ipAddress: event.requestContext.identity?.sourceIp,
    userAgent: event.headers['User-Agent'],
  };

  try {
    await docClient.send(new PutCommand({
      TableName: AUDIT_LOG_TABLE,
      Item: {
        ...auditLog,
        ttl: Math.floor(Date.now() / 1000) + (90 * 24 * 60 * 60), // 90 days retention
      },
    }));
  } catch (error) {
    console.error('Failed to write audit log:', error);
  }

  // Emit CloudWatch metric
  await cloudwatchClient.send(new PutMetricDataCommand({
    Namespace: 'GetComplical/Security',
    MetricData: [{
      MetricName: 'APIKeyOperation',
      Value: 1,
      Unit: 'Count',
      Dimensions: [
        { Name: 'Action', Value: action },
        { Name: 'UserId', Value: userId },
      ],
      Timestamp: new Date(),
    }],
  }));
}

async function checkRateLimit(userId: string, operation: 'create' | 'delete'): Promise<boolean> {
  const limit = KEY_OPERATION_LIMITS[operation];
  const now = Date.now();
  const windowStart = now - (limit.window * 1000);
  
  try {
    const { Items = [] } = await docClient.send(new QueryCommand({
      TableName: RATE_LIMIT_TABLE,
      KeyConditionExpression: 'pk = :pk AND sk BETWEEN :start AND :end',
      ExpressionAttributeValues: {
        ':pk': `key-ops#${userId}`,
        ':start': `${operation}#${windowStart}`,
        ':end': `${operation}#${now}`,
      },
    }));
    
    if (Items.length >= limit.limit) {
      return false;
    }
    
    // Record this operation
    await docClient.send(new PutCommand({
      TableName: RATE_LIMIT_TABLE,
      Item: {
        pk: `key-ops#${userId}`,
        sk: `${operation}#${now}`,
        timestamp: now,
        ttl: Math.floor(now / 1000) + limit.window,
      },
    }));
    
    return true;
  } catch (error) {
    console.error('Rate limit check failed:', error);
    return true; // Fail open for availability
  }
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'X-Request-ID': event.requestContext.requestId,
  };

  try {
    const authorizer = event.requestContext.authorizer;
    
    if (!authorizer) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Unauthorized' }),
      };
    }

    const claims = authorizer.claims || authorizer;
    const userId = claims.sub || claims['cognito:username'] || claims.principalId;
    const email = claims.email;

    if (!userId) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Invalid authentication token' }),
      };
    }

    const path = event.path;
    const method = event.httpMethod;

    // POST /dashboard/keys - Create new API key
    if (method === 'POST' && path === '/dashboard/keys') {
      // Rate limiting
      const canCreate = await checkRateLimit(userId, 'create');
      if (!canCreate) {
        return {
          statusCode: 429,
          headers: {
            ...headers,
            'Retry-After': '3600',
          },
          body: JSON.stringify({ 
            error: 'Rate limit exceeded. Maximum 5 keys can be created per hour.' 
          }),
        };
      }

      const body = event.body ? JSON.parse(event.body) : {};
      const requestedTier = body.tier || 'free';
      
      // Validate tier
      if (!TIER_CONFIGS[requestedTier]) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Invalid tier specified' }),
        };
      }
      
      // TODO: Validate user's subscription tier matches requested tier
      // This would involve checking against a subscriptions table
      
      const tierConfig = getTierConfig(requestedTier);
      const apiKey = `gc_${requestedTier === 'free' ? 'test' : 'live'}_${nanoid(32)}`;
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + (365 * 24 * 60 * 60 * 1000)).toISOString(); // 1 year

      await docClient.send(new PutCommand({
        TableName: API_KEYS_TABLE,
        Item: {
          apiKey,
          userId,
          email,
          customerId: userId, // For backward compatibility
          status: 'active',
          tier: requestedTier,
          enabled: true,
          dailyLimit: tierConfig.dailyLimit,
          rateLimit: tierConfig.rateLimit,
          burstLimit: tierConfig.burstLimit,
          requestCount: 0,
          monthlyUsage: 0,
          createdAt: now,
          expiresAt,
          lastUsedDate: null,
          description: body.description || `${tierConfig.name} API Key`,
          metadata: {
            createdBy: 'dashboard',
            ipAddress: event.requestContext.identity?.sourceIp,
            userAgent: event.headers['User-Agent'],
          },
        },
      }));

      await logAuditEvent(event, 'CREATE_KEY', apiKey, {
        tier: requestedTier,
        description: body.description,
      });

      return {
        statusCode: 201,
        headers,
        body: JSON.stringify({
          apiKey,
          createdAt: now,
          expiresAt,
          tier: requestedTier,
          tierName: tierConfig.name,
          dailyLimit: tierConfig.dailyLimit,
          rateLimit: tierConfig.rateLimit,
          features: tierConfig.features,
        }),
      };
    }

    // GET /dashboard/keys - List user's API keys
    if (method === 'GET' && path === '/dashboard/keys') {
      const { Items = [] } = await docClient.send(new QueryCommand({
        TableName: API_KEYS_TABLE,
        IndexName: 'userId-index',
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: {
          ':userId': userId,
        },
      }));

      // Filter out expired keys and enrich with current usage
      const now = new Date();
      const activeKeys = Items
        .filter(item => !item.expiresAt || new Date(item.expiresAt) > now)
        .map(item => {
          const tierConfig = getTierConfig(item.tier || 'free');
          return {
            apiKey: item.apiKey,
            description: item.description,
            status: item.status || 'active',
            enabled: item.enabled !== false,
            tier: item.tier || 'free',
            tierName: tierConfig.name,
            dailyLimit: item.dailyLimit || tierConfig.dailyLimit,
            rateLimit: item.rateLimit || tierConfig.rateLimit,
            requestCount: item.requestCount || 0,
            monthlyUsage: item.monthlyUsage || 0,
            createdAt: item.createdAt,
            expiresAt: item.expiresAt,
            lastUsedDate: item.lastUsedDate,
            daysUntilExpiration: item.expiresAt ? 
              Math.floor((new Date(item.expiresAt).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)) : 
              null,
          };
        });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          keys: activeKeys,
          count: activeKeys.length,
        }),
      };
    }

    // DELETE /dashboard/keys/{apiKey} - Revoke API key
    if (method === 'DELETE' && path.startsWith('/dashboard/keys/')) {
      const apiKey = path.split('/').pop();
      
      if (!apiKey || !apiKey.startsWith('gc_')) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Invalid API key format' }),
        };
      }

      // Rate limiting
      const canDelete = await checkRateLimit(userId, 'delete');
      if (!canDelete) {
        return {
          statusCode: 429,
          headers: {
            ...headers,
            'Retry-After': '3600',
          },
          body: JSON.stringify({ 
            error: 'Rate limit exceeded. Maximum 10 key deletions per hour.' 
          }),
        };
      }

      // Verify ownership
      const { Item } = await docClient.send(new GetCommand({
        TableName: API_KEYS_TABLE,
        Key: { apiKey },
      }));

      if (!Item) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: 'API key not found' }),
        };
      }

      if (Item.userId !== userId) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'You do not have permission to delete this key' }),
        };
      }

      // Soft delete - mark as revoked instead of deleting
      await docClient.send(new UpdateCommand({
        TableName: API_KEYS_TABLE,
        Key: { apiKey },
        UpdateExpression: 'SET #status = :status, #revokedAt = :revokedAt, #revokedBy = :revokedBy',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#revokedAt': 'revokedAt',
          '#revokedBy': 'revokedBy',
        },
        ExpressionAttributeValues: {
          ':status': 'revoked',
          ':revokedAt': new Date().toISOString(),
          ':revokedBy': email || userId,
        },
      }));

      await logAuditEvent(event, 'DELETE_KEY', apiKey, {
        previousStatus: Item.status,
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          message: 'API key revoked successfully',
          apiKey,
        }),
      };
    }

    // POST /dashboard/keys/{apiKey}/rotate - Rotate API key
    if (method === 'POST' && path.includes('/rotate')) {
      const pathParts = path.split('/');
      const oldApiKey = pathParts[pathParts.length - 2];
      
      // Verify ownership
      const { Item } = await docClient.send(new GetCommand({
        TableName: API_KEYS_TABLE,
        Key: { apiKey: oldApiKey },
      }));

      if (!Item || Item.userId !== userId) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: 'API key not found or access denied' }),
        };
      }

      // Generate new key with same settings
      const newApiKey = `gc_${Item.tier === 'free' ? 'test' : 'live'}_${nanoid(32)}`;
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + (365 * 24 * 60 * 60 * 1000)).toISOString();

      // Create new key
      await docClient.send(new PutCommand({
        TableName: API_KEYS_TABLE,
        Item: {
          ...Item,
          apiKey: newApiKey,
          createdAt: now,
          expiresAt,
          rotatedFrom: oldApiKey,
          requestCount: 0,
          monthlyUsage: 0,
          lastUsedDate: null,
        },
      }));

      // Mark old key for expiration in 30 days
      const oldKeyExpiration = new Date(Date.now() + (30 * 24 * 60 * 60 * 1000)).toISOString();
      await docClient.send(new UpdateCommand({
        TableName: API_KEYS_TABLE,
        Key: { apiKey: oldApiKey },
        UpdateExpression: 'SET #status = :status, #expiresAt = :expiresAt, #rotatedTo = :rotatedTo',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#expiresAt': 'expiresAt',
          '#rotatedTo': 'rotatedTo',
        },
        ExpressionAttributeValues: {
          ':status': 'rotating',
          ':expiresAt': oldKeyExpiration,
          ':rotatedTo': newApiKey,
        },
      }));

      await logAuditEvent(event, 'ROTATE_KEY', newApiKey, {
        oldApiKey,
        reason: 'Manual rotation',
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          newApiKey,
          oldApiKey,
          oldKeyExpiresAt: oldKeyExpiration,
          message: 'API key rotated successfully. Old key will expire in 30 days.',
        }),
      };
    }

    // GET /dashboard/audit-logs - Get audit logs for user
    if (method === 'GET' && path === '/dashboard/audit-logs') {
      const { Items = [] } = await docClient.send(new QueryCommand({
        TableName: AUDIT_LOG_TABLE,
        IndexName: 'userId-index',
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: {
          ':userId': userId,
        },
        ScanIndexForward: false, // Most recent first
        Limit: 50,
      }));

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          logs: Items,
          count: Items.length,
        }),
      };
    }

    // GET /dashboard/usage/monthly - Monthly usage stats
    if (method === 'GET' && path === '/dashboard/usage/monthly') {
      const startOfMonth = new Date();
      startOfMonth.setUTCDate(1);
      startOfMonth.setUTCHours(0, 0, 0, 0);

      const { Items = [] } = await docClient.send(new QueryCommand({
        TableName: USAGE_METRICS_TABLE,
        KeyConditionExpression: 'pk = :pk AND sk >= :startDate',
        ExpressionAttributeValues: {
          ':pk': `user#${userId}`,
          ':startDate': startOfMonth.toISOString(),
        },
      }));

      const totalRequests = Items.reduce((sum, item) => sum + (item.requestCount || 0), 0);
      const totalErrors = Items.reduce((sum, item) => sum + (item.errorCount || 0), 0);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          month: startOfMonth.toISOString().substring(0, 7),
          totalRequests,
          totalErrors,
          errorRate: totalRequests > 0 ? (totalErrors / totalRequests) : 0,
          dailyBreakdown: Items.map(item => ({
            date: item.sk,
            requests: item.requestCount || 0,
            errors: item.errorCount || 0,
          })),
        }),
      };
    }

    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Endpoint not found' }),
    };

  } catch (error) {
    console.error('Dashboard error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Internal server error',
        requestId: event.requestContext.requestId,
      }),
    };
  }
};