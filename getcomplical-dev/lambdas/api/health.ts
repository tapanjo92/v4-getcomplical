import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { CloudWatchClient, GetMetricStatisticsCommand } from '@aws-sdk/client-cloudwatch';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const cloudwatchClient = new CloudWatchClient({ region: process.env.AWS_REGION });
const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION });

let cachedHealthCheckKey: string | null = null;

interface HealthCheck {
  service: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  latency?: number;
  details?: any;
}

interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  region: string;
  checks: HealthCheck[];
  version: string;
}

async function checkDynamoDB(tableName: string): Promise<HealthCheck> {
  const start = Date.now();
  try {
    const command = new DescribeTableCommand({ TableName: tableName });
    const response = await dynamoClient.send(command);
    const latency = Date.now() - start;
    
    return {
      service: `dynamodb:${tableName}`,
      status: response.Table?.TableStatus === 'ACTIVE' ? 'healthy' : 'degraded',
      latency,
      details: {
        status: response.Table?.TableStatus,
        itemCount: response.Table?.ItemCount,
        sizeBytes: response.Table?.TableSizeBytes,
        pointInTimeRecovery: response.Table?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus
      }
    };
  } catch (error) {
    return {
      service: `dynamodb:${tableName}`,
      status: 'unhealthy',
      latency: Date.now() - start,
      details: { error: error instanceof Error ? error.message : 'Unknown error' }
    };
  }
}

async function checkLambdaMetrics(): Promise<HealthCheck> {
  const start = Date.now();
  try {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - 5 * 60 * 1000); // Last 5 minutes
    
    const command = new GetMetricStatisticsCommand({
      Namespace: 'AWS/Lambda',
      MetricName: 'Errors',
      Dimensions: [
        { Name: 'FunctionName', Value: process.env.AWS_LAMBDA_FUNCTION_NAME || '' }
      ],
      StartTime: startTime,
      EndTime: endTime,
      Period: 300,
      Statistics: ['Sum']
    });
    
    const response = await cloudwatchClient.send(command);
    const errorCount = response.Datapoints?.[0]?.Sum || 0;
    
    return {
      service: 'lambda:metrics',
      status: errorCount > 10 ? 'degraded' : 'healthy',
      latency: Date.now() - start,
      details: {
        recentErrors: errorCount,
        memorySize: process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE,
        functionVersion: process.env.AWS_LAMBDA_FUNCTION_VERSION
      }
    };
  } catch (error) {
    return {
      service: 'lambda:metrics',
      status: 'degraded',
      latency: Date.now() - start,
      details: { error: 'Unable to fetch metrics' }
    };
  }
}

async function checkEnvironment(): Promise<HealthCheck> {
  const requiredEnvVars = [
    'API_KEYS_TABLE',
    'TAX_DATA_TABLE',
    'RATE_LIMIT_TABLE',
    'AWS_REGION'
  ];
  
  const missingVars = requiredEnvVars.filter(v => !process.env[v]);
  
  return {
    service: 'environment',
    status: missingVars.length === 0 ? 'healthy' : 'unhealthy',
    details: {
      missingVars,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch
    }
  };
}

async function getHealthCheckKey(): Promise<string> {
  if (cachedHealthCheckKey) {
    return cachedHealthCheckKey;
  }
  
  try {
    const command = new GetSecretValueCommand({
      SecretId: process.env.HEALTH_CHECK_SECRET_ARN,
    });
    const response = await secretsClient.send(command);
    
    if (response.SecretString) {
      const secret = JSON.parse(response.SecretString);
      cachedHealthCheckKey = secret.key;
      return cachedHealthCheckKey;
    }
  } catch (error) {
    console.error('Failed to retrieve health check key:', error);
  }
  
  return process.env.HEALTH_CHECK_KEY || 'default-health-key';
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // Basic authentication check - only allow internal health checks
  const authHeader = event.headers['x-health-check-key'];
  const healthCheckKey = await getHealthCheckKey();
  const isInternalCheck = authHeader === healthCheckKey;
  
  // Determine check depth based on authentication
  const isDeepCheck = event.queryStringParameters?.deep === 'true' && isInternalCheck;
  
  const checks: HealthCheck[] = [];
  
  // Always include environment check
  checks.push(await checkEnvironment());
  
  if (isDeepCheck) {
    // Deep health checks - check all dependencies
    const [apiKeysCheck, taxDataCheck, rateLimitCheck, lambdaCheck] = await Promise.all([
      checkDynamoDB(process.env.API_KEYS_TABLE || 'getcomplical-api-keys'),
      checkDynamoDB(process.env.TAX_DATA_TABLE || 'getcomplical-tax-data'),
      checkDynamoDB(process.env.RATE_LIMIT_TABLE || 'getcomplical-rate-limits'),
      checkLambdaMetrics()
    ]);
    
    checks.push(apiKeysCheck, taxDataCheck, rateLimitCheck, lambdaCheck);
  }
  
  // Determine overall health status
  const hasUnhealthy = checks.some(c => c.status === 'unhealthy');
  const hasDegraded = checks.some(c => c.status === 'degraded');
  const overallStatus = hasUnhealthy ? 'unhealthy' : (hasDegraded ? 'degraded' : 'healthy');
  
  const response: HealthResponse = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    region: process.env.AWS_REGION || 'unknown',
    checks,
    version: process.env.API_VERSION || '1.0.0'
  };
  
  // Return appropriate status code based on health
  const statusCode = overallStatus === 'healthy' ? 200 : (overallStatus === 'degraded' ? 200 : 503);
  
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'X-Health-Status': overallStatus
    },
    body: JSON.stringify(response, null, 2)
  };
};